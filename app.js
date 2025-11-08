// ==================================================================================
// 1. State Management (The single source of truth)
// ==================================================================================

const state = {
    pdfDoc: null,
    originalPdfBytes: null,
    currentPageNum: 1,
    currentPdfPage: null, // The rendered page object from pdf.js
    scale: 1.5, // The scale of the rendered PDF on canvas
    signature: {
        dataUrl: null,
        placement: null, // { x, y } relative to the canvas
        zoom: 1.0,
    },
    history: [],
    historyPointer: -1,
    ui: {
        isLoading: false,
        currentView: 'upload', // 'upload', 'sign'
        showDownload: false, // Controls visibility of the download container
        message: { text: '', type: 'info' }, // { text, type }
    },
    signaturePadInstance: null,
};

function updateState(newState) {
    // Deep merge for nested objects like ui and signature
    if (newState.ui) {
        newState.ui = { ...state.ui, ...newState.ui };
    }
    if (newState.signature) {
        newState.signature = { ...state.signature, ...newState.signature };
    }
    Object.assign(state, newState);
    UI.render();
}

// ==================================================================================
// 2. UI Module (Handles all DOM manipulations)
// ==================================================================================

const UI = {
    elements: {
        uploadContainer: document.getElementById('uploadContainer'),
        pdfContainer: document.getElementById('pdfContainer'),
        downloadContainer: document.getElementById('downloadContainer'),
        instructionsContainer: document.getElementById('instructionsContainer'),
        pdfCanvas: document.getElementById('pdfCanvas'),
        pdfMessage: document.getElementById('pdfMessage'),
        messageArea: document.getElementById('messageArea'),
        fileNameInput: document.getElementById('fileName'),
        signatureModal: document.getElementById('signatureModal'),
        signaturePadCanvas: document.getElementById('signaturePad'),
        pdfUndoButton: document.getElementById('pdfUndoButton'),
        pdfRedoButton: document.getElementById('pdfRedoButton'),
    },

    showMessage(text, type = 'info') {
        const { messageArea } = this.elements;
        messageArea.innerHTML = '';
        if (type === 'loading') {
            messageArea.innerHTML = `
                <div class="loader"></div>
                <p class="text-blue-600">${text}</p>
            `;
        } else if (text) {
            const color = {
                error: 'text-red-600',
                success: 'text-green-600',
                info: 'text-gray-600',
            }[type];
            messageArea.innerHTML = `<p class="${color} font-medium">${text}</p>`;
        }
    },

    render() {
        this.elements.uploadContainer.classList.toggle('hidden', state.ui.currentView !== 'upload');
        this.elements.instructionsContainer.classList.toggle('hidden', state.ui.currentView !== 'upload');
        this.elements.pdfContainer.classList.toggle('hidden', state.ui.currentView !== 'sign');
        this.elements.downloadContainer.classList.toggle('hidden', !state.ui.showDownload);
        this.showMessage(state.ui.message.text, state.ui.message.type);
        this.elements.pdfUndoButton.disabled = state.historyPointer <= 0;
        this.elements.pdfRedoButton.disabled = state.historyPointer >= state.history.length - 1;
    },

    async renderPdfPage() {
        if (!state.currentPdfPage) return;
        const containerWidth = this.elements.pdfContainer.clientWidth * 0.95;
        const viewportAtScale1 = state.currentPdfPage.getViewport({ scale: 1 });
        const scale = containerWidth / viewportAtScale1.width;
        state.scale = scale; // Direct mutation to avoid render loop

        const viewport = state.currentPdfPage.getViewport({ scale });
        const context = this.elements.pdfCanvas.getContext('2d');
        this.elements.pdfCanvas.height = viewport.height;
        this.elements.pdfCanvas.width = viewport.width;

        await state.currentPdfPage.render({ canvasContext: context, viewport }).promise;
        console.log('Page rendered with scale:', scale);

        // FIX: ALWAYS redraw the signature preview after rendering the PDF page to ensure consistency.
        if (state.signature.dataUrl && state.signature.placement) {
            this.drawSignaturePreview();
        }
    },

    drawSignaturePreview() {
        const { dataUrl, placement, zoom } = state.signature;
        if (!dataUrl || !placement) return;
        const context = this.elements.pdfCanvas.getContext('2d');
        const sigImage = new Image();
        sigImage.onload = () => {
            const baseSigWidth = 120;
            const baseSigHeight = 60;
            const sigWidth = baseSigWidth * zoom;
            const sigHeight = baseSigHeight * zoom;
            context.drawImage(sigImage, placement.x, placement.y, sigWidth, sigHeight);
        };
        sigImage.src = dataUrl;
    },

    initializeSignaturePad() {
        const canvas = this.elements.signaturePadCanvas;
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext("2d").scale(ratio, ratio);
        if (state.signaturePadInstance) {
            state.signaturePadInstance.off();
        }
        state.signaturePadInstance = new SignaturePad(canvas, {
            backgroundColor: 'rgb(249, 249, 249)',
            penColor: 'rgb(0, 0, 0)',
        });
    },

    openSignatureModal() {
        this.elements.signatureModal.style.display = 'flex';
        if (!state.signaturePadInstance) {
            this.initializeSignaturePad();
        }
        state.signaturePadInstance.clear();
    },

    closeSignatureModal() {
        this.elements.signatureModal.style.display = 'none';
    },
};

// ==================================================================================
// 3. PDF Module (Handles core PDF processing logic)
// ==================================================================================

const PDF = {
    async loadPdf(pdfBytes) {
        const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
        const pdfDoc = await loadingTask.promise;
        const page = await pdfDoc.getPage(1);
        updateState({
            originalPdfBytes: pdfBytes,
            pdfDoc: pdfDoc,
            currentPageNum: 1,
            currentPdfPage: page,
        });
    },

    async embedSignature() {
        const { originalPdfBytes, signature, currentPdfPage, scale } = state;
        if (!originalPdfBytes || !signature.dataUrl || !signature.placement) {
            throw new Error('Missing PDF, signature, or placement data.');
        }
        const pdfDoc = await PDFDocument.load(originalPdfBytes);
        const firstPage = pdfDoc.getPages()[0];
        const { width: pageWidth, height: pageHeight } = firstPage.getSize();
        const sigImageBytes = await fetch(signature.dataUrl).then(res => res.arrayBuffer());
        const sigImage = await pdfDoc.embedPng(sigImageBytes);
        const viewport = currentPdfPage.getViewport({ scale });
        const scaleX = pageWidth / viewport.width;
        const scaleY = pageHeight / viewport.height;
        const baseSigWidthPoints = 120;
        const baseSigHeightPoints = 60;
        const sigWidthPoints = baseSigWidthPoints * signature.zoom;
        const sigHeightPoints = baseSigHeightPoints * signature.zoom;
        const pdfX = signature.placement.x * scaleX;
        const pdfY = pageHeight - (signature.placement.y * scaleY) - sigHeightPoints;
        firstPage.drawImage(sigImage, {
            x: pdfX,
            y: pdfY,
            width: sigWidthPoints,
            height: sigHeightPoints,
        });
        return await pdfDoc.save();
    },
};

// ==================================================================================
// 4. History Module (Manages undo/redo state)
// ==================================================================================

const History = {
    saveState() {
        const currentState = {
            placement: state.signature.placement,
            dataUrl: state.signature.dataUrl,
            zoom: state.signature.zoom,
        };
        const newHistory = state.history.slice(0, state.historyPointer + 1);
        updateState({
            history: [...newHistory, currentState],
            historyPointer: newHistory.length,
        });
    },

    undo() {
        if (state.historyPointer > 0) {
            const newPointer = state.historyPointer - 1;
            const previousState = state.history[newPointer];
            updateState({
                historyPointer: newPointer,
                signature: { ...state.signature, ...previousState },
            });
            UI.renderPdfPage();
        }
    },

    redo() {
        if (state.historyPointer < state.history.length - 1) {
            const newPointer = state.historyPointer + 1;
            const nextState = state.history[newPointer];
            updateState({
                historyPointer: newPointer,
                signature: { ...state.signature, ...nextState },
            });
            UI.renderPdfPage();
        }
    },
};

// ==================================================================================
// 5. Event Handlers (The "Controller" layer)
// ==================================================================================

const Events = {
    async handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file || file.type !== 'application/pdf') {
            updateState({ ui: { message: { text: '請選擇一個 PDF 檔案。', type: 'error' } } });
            return;
        }
        updateState({ ui: { message: { text: '正在載入 PDF...', type: 'loading' }, showDownload: false } });
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                await PDF.loadPdf(event.target.result);
                updateState({
                    ui: { currentView: 'sign', message: { text: 'PDF 載入成功！請點擊預覽圖以放置簽名。', type: 'info' } },
                });
                await UI.renderPdfPage();
                History.saveState();
            } catch (err) {
                console.error('載入 PDF 失敗:', err);
                updateState({ ui: { message: { text: `載入 PDF 失敗: ${err.message}`, type: 'error' } } });
            }
        };
        reader.readAsArrayBuffer(file);
    },

    handleCanvasClick(e) {
        if (!state.currentPdfPage) return;
        const rect = UI.elements.pdfCanvas.getBoundingClientRect();
        const placement = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        updateState({ signature: { placement } });
        if (!state.signature.dataUrl) {
            UI.openSignatureModal();
        } else {
            updateState({ ui: { message: { text: '簽名位置已更新。', type: 'info' } } });
            UI.renderPdfPage();
            History.saveState();
        }
    },

    handleSaveSignature() {
        if (state.signaturePadInstance.isEmpty()) {
            alert('簽名欄位是空的。');
            return;
        }
        const dataUrl = state.signaturePadInstance.toDataURL('image/png');
        updateState({
            signature: { dataUrl },
            ui: { showDownload: true, message: { text: '簽名已儲存！您可以調整位置或下載。', type: 'success' } },
        });
        UI.closeSignatureModal();
        UI.renderPdfPage();
        History.saveState();
    },

    async handleDownload() {
        updateState({ ui: { message: { text: '正在處理 PDF...', type: 'loading' } } });
        try {
            // The scale is assumed to be correct because renderPdfPage is now robust.
            const pdfBytes = await PDF.embedSignature();
            let fileName = UI.elements.fileNameInput.value.trim() || '已簽署文件';
            if (!fileName.toLowerCase().endsWith('.pdf')) {
                fileName += '.pdf';
            }
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
            updateState({ ui: { message: { text: '處理完成！', type: 'success' } } });
        } catch (err) {
            console.error('嵌入簽名失敗:', err);
            updateState({ ui: { message: { text: `嵌入簽名失敗: ${err.message}`, type: 'error' } } });
        }
    },

    handleZoom(direction) {
        let newZoom = state.signature.zoom;
        if (direction === 'in') {
            newZoom += 0.25;
        } else {
            newZoom = Math.max(0.25, newZoom - 0.25);
        }
        updateState({ signature: { zoom: newZoom } });
        UI.renderPdfPage();
        History.saveState();
    },

    handleResize() {
        if (state.currentPdfPage) {
            UI.renderPdfPage();
        }
        if (state.signaturePadInstance && UI.elements.signatureModal.style.display === 'flex') {
            UI.initializeSignaturePad();
        }
    },

    bind() {
        const { pdfCanvas } = UI.elements;
        const uploadInput = document.getElementById('pdfUpload');
        const clearSigButton = document.getElementById('clearSigButton');
        const saveSigButton = document.getElementById('saveSigButton');
        const cancelSigButton = document.getElementById('cancelSigButton');
        const downloadButton = document.getElementById('downloadButton');
        const newSignatureButton = document.getElementById('newSignatureButton');
        const zoomInButton = document.getElementById('zoomInButton');
        const zoomOutButton = document.getElementById('zoomOutButton');
        const undoButton = document.getElementById('pdfUndoButton');
        const redoButton = document.getElementById('pdfRedoButton');

        uploadInput.addEventListener('change', this.handleFileUpload.bind(this));
        pdfCanvas.addEventListener('click', this.handleCanvasClick.bind(this));
        saveSigButton.addEventListener('click', this.handleSaveSignature.bind(this));
        downloadButton.addEventListener('click', this.handleDownload.bind(this));
        clearSigButton.addEventListener('click', () => state.signaturePadInstance.clear());
        cancelSigButton.addEventListener('click', UI.closeSignatureModal.bind(UI));
        newSignatureButton.addEventListener('click', UI.openSignatureModal.bind(UI));
        zoomInButton.addEventListener('click', () => this.handleZoom('in'));
        zoomOutButton.addEventListener('click', () => this.handleZoom('out'));
        undoButton.addEventListener('click', History.undo.bind(History));
        redoButton.addEventListener('click', History.redo.bind(History));
        window.addEventListener('resize', this.handleResize.bind(this));
    }
};

// ==================================================================================
// 6. App Initialization
// ==================================================================================

function createStarfield() {
    const starfield = document.getElementById('starfield');
    if (!starfield) return;
    const numStars = 200;
    for (let i = 0; i < numStars; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        const size = Math.random() * 3;
        star.style.width = `${size}px`;
        star.style.height = `${size}px`;
        star.style.top = `${Math.random() * 100}%`;
        star.style.left = `${Math.random() * 100}%`;
        star.style.animationDelay = `${Math.random() * 2}s`;
        star.style.animationDuration = `${2 + Math.random() * 2}s`;
        starfield.appendChild(star);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js';
    createStarfield();
    Events.bind();
    UI.render();
});
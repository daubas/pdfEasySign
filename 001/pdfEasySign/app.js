// ==================================================================================
// 0. Library Globals & Setup
// ==================================================================================
const { PDFDocument, rgb } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js';

// ==================================================================================
// 1. State Management (The single source of truth)
// ==================================================================================
const state = {
    pdfDoc: null,
    originalPdfBytes: null,
    currentPageNum: 1,
    totalPages: 0,
    currentPdfPage: null,
    scale: 1.5,
    // --- MODIFIED: Removed signatureZoom, zoom is now per-annotation ---
    annotations: [], // Stores all drawing annotations: { id, type: 'drawing', data, placement, zoom, pageNum }
    currentAnnotationData: null, // Temp storage for placement data
    // --- END MODIFIED ---
    history: [],
    historyPointer: -1,
    ui: {
        isLoading: false,
        currentView: 'upload',
        showDownload: false,
        message: { text: '', type: 'info' },
    },
    signaturePadInstance: null,
};

function updateState(newState) {
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
        messageArea: document.getElementById('messageArea'),
        fileNameInput: document.getElementById('fileName'),
        signatureModal: document.getElementById('signatureModal'),
        signaturePadCanvas: document.getElementById('signaturePad'),
        pdfUndoButton: document.getElementById('pdfUndoButton'),
        pdfRedoButton: document.getElementById('pdfRedoButton'),
        prevPageButton: document.getElementById('prevPageButton'),
        nextPageButton: document.getElementById('nextPageButton'),
        pageIndicator: document.getElementById('pageIndicator'),
        // --- RE-ADDED: Zoom controls ---
        zoomInButton: document.getElementById('zoomInButton'),
        zoomOutButton: document.getElementById('zoomOutButton'),
    },

    showMessage(text, type = 'info') {
        const { messageArea } = this.elements;
        messageArea.innerHTML = '';
        if (type === 'loading') {
            messageArea.innerHTML = `<div class="loader"></div><p>${text}</p>`;
        } else if (text) {
            const color = { error: 'text-red-600', success: 'text-green-600', info: 'text-gray-600' }[type];
            messageArea.innerHTML = `<div class="${color} font-medium">${text}</div>`;
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
        this.elements.pageIndicator.textContent = `頁碼 ${state.currentPageNum} / ${state.totalPages}`;
        this.elements.prevPageButton.disabled = state.currentPageNum <= 1;
        this.elements.nextPageButton.disabled = state.currentPageNum >= state.totalPages;
    },

    async renderPdfPage(pageNum) {
        if (!state.pdfDoc) return;
        const page = await state.pdfDoc.getPage(pageNum);
        state.currentPdfPage = page;
        const containerWidth = this.elements.pdfContainer.clientWidth * 0.95;
        const viewport = page.getViewport({ scale: containerWidth / page.getViewport({ scale: 1 }).width });
        state.scale = viewport.scale;
        const context = this.elements.pdfCanvas.getContext('2d');
        this.elements.pdfCanvas.height = viewport.height;
        this.elements.pdfCanvas.width = viewport.width;
        await page.render({ canvasContext: context, viewport }).promise;
        this.drawAnnotationsPreview(pageNum);
    },

    drawAnnotationsPreview(pageNum) {
        const context = this.elements.pdfCanvas.getContext('2d');
        state.annotations.filter(ann => ann.pageNum === pageNum).forEach(ann => {
            const sigImage = new Image();
            sigImage.onload = () => {
                context.drawImage(sigImage, ann.placement.x, ann.placement.y, 120 * ann.zoom, 60 * ann.zoom);
            };
            sigImage.src = ann.data;
        });
    },

    initializeSignaturePad() {
        const canvas = this.elements.signaturePadCanvas;
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext("2d").scale(ratio, ratio);
        if (state.signaturePadInstance) state.signaturePadInstance.off();
        state.signaturePadInstance = new SignaturePad(canvas, { backgroundColor: 'rgba(0,0,0,0)', penColor: 'rgb(0, 0, 0)' });
    },
    openSignatureModal() {
        this.elements.signatureModal.style.display = 'flex';
        if (!state.signaturePadInstance) this.initializeSignaturePad();
        state.signaturePadInstance.clear();
    },
    closeSignatureModal() { this.elements.signatureModal.style.display = 'none'; },
};

// ==================================================================================
// 3. PDF Module (Handles core PDF processing logic)
// ==================================================================================
const PDF = {
    async loadPdf(pdfBytes) {
        const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
        return await loadingTask.promise;
    },
    async embedAnnotations() {
        const { originalPdfBytes, annotations } = state;
        if (!originalPdfBytes) throw new Error('Missing PDF data.');
        const pdfDoc = await PDFDocument.load(originalPdfBytes);

        for (const ann of annotations) {
            const pageToSign = pdfDoc.getPages()[ann.pageNum - 1];
            if (!pageToSign) continue;
            const { width: pageWidth, height: pageHeight } = pageToSign.getSize();
            const page = await state.pdfDoc.getPage(ann.pageNum);
            const viewport = page.getViewport({ scale: state.scale });
            const scaleX = pageWidth / viewport.width;
            const scaleY = pageHeight / viewport.height;

            const sigImage = await pdfDoc.embedPng(ann.data);
            pageToSign.drawImage(sigImage, {
                x: ann.placement.x * scaleX,
                y: pageHeight - (ann.placement.y * scaleY) - (60 * ann.zoom * scaleY),
                width: 120 * ann.zoom * scaleX,
                height: 60 * ann.zoom * scaleY,
            });
        }
        return await pdfDoc.save();
    },
};

// ==================================================================================
// 4. History Module (Manages undo/redo state)
// ==================================================================================
const History = {
    saveState() {
        const currentState = {
            annotations: JSON.parse(JSON.stringify(state.annotations)),
            pageNum: state.currentPageNum,
        };
        const newHistory = state.history.slice(0, state.historyPointer + 1);
        state.history = [...newHistory, currentState];
        state.historyPointer = state.history.length - 1;
        UI.render();
    },
    undo() {
        if (state.historyPointer > 0) {
            const newPointer = state.historyPointer - 1;
            const previousState = state.history[newPointer];
            updateState({ ...state, historyPointer: newPointer, currentPageNum: previousState.pageNum, annotations: previousState.annotations });
            UI.renderPdfPage(previousState.pageNum);
        }
    },
    redo() {
        if (state.historyPointer < state.history.length - 1) {
            const newPointer = state.historyPointer + 1;
            const nextState = state.history[newPointer];
            updateState({ ...state, historyPointer: newPointer, currentPageNum: nextState.pageNum, annotations: nextState.annotations });
            UI.renderPdfPage(nextState.pageNum);
        }
    },
};

// ==================================================================================
// 5. Event Handlers (The "Controller" layer)
// ==================================================================================
const Events = {
    async handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
            updateState({ ...state, ui: { ...state.ui, message: { text: '錯誤：檔案大小不能超過 10MB。', type: 'error' } } });
            return;
        }
        if (file.type !== 'application/pdf') {
            updateState({ ...state, ui: { ...state.ui, message: { text: '請選擇一個 PDF 檔案。', type: 'error' } } });
            return;
        }
        updateState({ ...state, ui: { ...state.ui, message: { text: '正在載入 PDF...', type: 'loading' }, showDownload: false } });
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const pdfDoc = await PDF.loadPdf(event.target.result);
                updateState({
                    ...state,
                    originalPdfBytes: event.target.result,
                    pdfDoc,
                    totalPages: pdfDoc.numPages,
                    currentPageNum: 1,
                    annotations: [],
                    ui: { ...state.ui, currentView: 'sign', message: { text: 'PDF 載入成功！請點擊 PDF 放置簽名。', type: 'info' } },
                });
                await UI.renderPdfPage(1);
                History.saveState();
            } catch (err) {
                console.error('載入 PDF 失敗:', err);
                updateState({ ...state, ui: { ...state.ui, message: { text: `載入 PDF 失敗: ${err.message}`, type: 'error' } } });
            }
        };
        reader.readAsArrayBuffer(file);
    },

    handleCanvasClick(e) {
        if (!state.currentPdfPage) return;
        const rect = UI.elements.pdfCanvas.getBoundingClientRect();
        const placement = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        state.currentAnnotationData = { placement, pageNum: state.currentPageNum };
        UI.openSignatureModal();
    },

    handleSaveDrawing() {
        if (state.signaturePadInstance.isEmpty()) { alert('簽名欄位是空的。'); return; }
        const newAnnotation = {
            id: Date.now(),
            type: 'drawing',
            data: state.signaturePadInstance.toDataURL('image/png'),
            placement: state.currentAnnotationData.placement,
            zoom: 1.0, // New signatures always start at 1.0x zoom
            pageNum: state.currentAnnotationData.pageNum,
        };
        updateState({
            ...state,
            annotations: [...state.annotations, newAnnotation],
            ui: { ...state.ui, showDownload: true, message: { text: '簽名已儲存！現在您可以使用縮放按鈕調整大小。', type: 'success' } },
        });
        UI.closeSignatureModal();
        UI.renderPdfPage(state.currentPageNum);
        History.saveState();
    },

    async handlePageChange(direction) {
        let newPageNum = state.currentPageNum;
        if (direction === 'next' && newPageNum < state.totalPages) newPageNum++;
        else if (direction === 'prev' && newPageNum > 1) newPageNum--;
        if (newPageNum !== state.currentPageNum) {
            updateState({ ...state, currentPageNum: newPageNum });
            await UI.renderPdfPage(newPageNum);
        }
    },

    async handleDownload() {
        updateState({ ...state, ui: { ...state.ui, message: { text: '正在處理 PDF...', type: 'loading' } } });
        try {
            const pdfBytes = await PDF.embedAnnotations();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = (UI.elements.fileNameInput.value.trim() || '已簽署文件') + '.pdf';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
            updateState({ ...state, ui: { ...state.ui, message: { text: '處理完成！', type: 'success' } } });
        } catch (err) {
            console.error('嵌入註釋失敗:', err);
            updateState({ ...state, ui: { ...state.ui, message: { text: `嵌入註釋失敗: ${err.message}`, type: 'error' } } });
        }
    },

    // --- RE-IMPLEMENTED: handleZoom provides immediate feedback ---
    handleZoom(direction) {
        // Find the last annotation on the current page
        const lastAnnotationOnPage = [...state.annotations].reverse().find(ann => ann.pageNum === state.currentPageNum);

        if (!lastAnnotationOnPage) {
            updateState({ ...state, ui: { ...state.ui, message: { text: '請先放置一個簽名再進行縮放。', type: 'error' } } });
            return;
        }

        let newZoom = lastAnnotationOnPage.zoom;
        if (direction === 'in') {
            newZoom += 0.25;
        } else {
            newZoom = Math.max(0.25, newZoom - 0.25);
        }

        // Update the zoom of that specific annotation
        lastAnnotationOnPage.zoom = newZoom;

        // Re-render the page to show the change immediately
        UI.renderPdfPage(state.currentPageNum);
        
        // Save this change to history
        History.saveState();
    },

    handleResize() {
        if (state.currentPdfPage) UI.renderPdfPage(state.currentPageNum);
        if (state.signaturePadInstance && UI.elements.signatureModal.style.display === 'flex') UI.initializeSignaturePad();
    },

    bind() {
        const { pdfCanvas, prevPageButton, nextPageButton, zoomInButton, zoomOutButton } = UI.elements;
        const uploadInput = document.getElementById('pdfUpload');
        const downloadButton = document.getElementById('downloadButton');
        const undoButton = document.getElementById('pdfUndoButton');
        const redoButton = document.getElementById('pdfRedoButton');
        const clearSigButton = document.getElementById('clearSigButton');
        const saveSigButton = document.getElementById('saveSigButton');
        const cancelSigButton = document.getElementById('cancelSigButton');

        uploadInput.addEventListener('change', this.handleFileUpload.bind(this));
        pdfCanvas.addEventListener('click', this.handleCanvasClick.bind(this));
        downloadButton.addEventListener('click', this.handleDownload.bind(this));
        undoButton.addEventListener('click', History.undo.bind(History));
        redoButton.addEventListener('click', History.redo.bind(History));
        prevPageButton.addEventListener('click', () => this.handlePageChange('prev'));
        nextPageButton.addEventListener('click', () => this.handlePageChange('next'));
        zoomInButton.addEventListener('click', () => this.handleZoom('in'));
        zoomOutButton.addEventListener('click', () => this.handleZoom('out'));
        
        clearSigButton.addEventListener('click', () => state.signaturePadInstance.clear());
        saveSigButton.addEventListener('click', this.handleSaveDrawing.bind(this));
        cancelSigButton.addEventListener('click', UI.closeSignatureModal.bind(UI));

        window.addEventListener('resize', this.handleResize.bind(this));
    }
};

// ==================================================================================
// 6. App Initialization
// ==================================================================================
document.addEventListener('DOMContentLoaded', () => {
    Events.bind();
    UI.render();
});
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
    fitScale: 1.0, // The scale to fit the PDF page to the container width
    pdfZoomLevel: 1.0, // The user-controlled zoom level of the PDF
    annotations: [], // { id, type, data, placement: { pdfX, pdfY }, zoom, pageNum }
    selectedAnnotationId: null,
    currentAnnotationData: null, // Temp storage for placement data
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
        controlsAndPdfContainer: document.getElementById('controlsAndPdfContainer'),
        pdfContainer: document.getElementById('pdfContainer'),
        downloadContainer: document.getElementById('downloadContainer'),
        instructionsContainer: document.getElementById('instructionsContainer'),
        pdfCanvas: document.getElementById('pdfCanvas'),
        messageArea: document.getElementById('messageArea'),
        fileNameInput: document.getElementById('fileName'),
        signatureModal: document.getElementById('signatureModal'),
        signaturePadCanvas: document.getElementById('signaturePad'),
        prevPageButton: document.getElementById('prevPageButton'),
        nextPageButton: document.getElementById('nextPageButton'),
        pageIndicator: document.getElementById('pageIndicator'),
        zoomInButton: document.getElementById('zoomInButton'),
        zoomOutButton: document.getElementById('zoomOutButton'),
        confirmPositionButton: document.getElementById('confirmPositionButton'),
        pdfZoomInButton: document.getElementById('pdfZoomInButton'),
        pdfZoomOutButton: document.getElementById('pdfZoomOutButton'),
        pdfZoomReset: document.getElementById('pdfZoomReset'),
        pdfZoomIndicator: document.getElementById('pdfZoomIndicator'),
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
        this.elements.controlsAndPdfContainer.classList.toggle('hidden', state.ui.currentView !== 'sign');
        this.elements.downloadContainer.classList.toggle('hidden', !state.ui.showDownload);
        this.showMessage(state.ui.message.text, state.ui.message.type);
        this.elements.pageIndicator.textContent = `頁碼 ${state.currentPageNum} / ${state.totalPages}`;
        this.elements.prevPageButton.disabled = state.currentPageNum <= 1;
        this.elements.nextPageButton.disabled = state.currentPageNum >= state.totalPages;
        this.elements.confirmPositionButton.disabled = state.selectedAnnotationId === null;
        this.elements.pdfZoomIndicator.textContent = `${Math.round(state.pdfZoomLevel * 100)}%`;
    },

    async renderPdfPage(pageNum) {
        if (!state.pdfDoc) return;
        const page = await state.pdfDoc.getPage(pageNum);
        state.currentPdfPage = page;

        const containerWidth = this.elements.pdfContainer.clientWidth * 0.95;
        const baseViewport = page.getViewport({ scale: 1 });
        state.fitScale = containerWidth / baseViewport.width;
        
        const finalScale = state.fitScale * state.pdfZoomLevel;
        const viewport = page.getViewport({ scale: finalScale });

        const context = this.elements.pdfCanvas.getContext('2d');
        this.elements.pdfCanvas.height = viewport.height;
        this.elements.pdfCanvas.width = viewport.width;
        await page.render({ canvasContext: context, viewport }).promise;
        this.drawAnnotationsPreview(pageNum, finalScale);
    },

    drawAnnotationsPreview(pageNum, finalScale) {
        const context = this.elements.pdfCanvas.getContext('2d');
        const pageAnnotations = state.annotations.filter(ann => ann.pageNum === pageNum);
        if (!state.currentPdfPage) return;
        const baseViewport = state.currentPdfPage.getViewport({ scale: 1 });

        pageAnnotations.forEach(ann => {
            const sigImage = new Image();
            sigImage.onload = () => {
                // Convert normalized PDF coordinates back to current canvas coordinates
                const canvasX = ann.placement.pdfX * baseViewport.width * finalScale;
                const canvasY = ann.placement.pdfY * baseViewport.height * finalScale;

                // Signature dimensions also need to scale with the PDF zoom
                const sigWidth = 120 * ann.zoom * state.pdfZoomLevel;
                const sigHeight = 60 * ann.zoom * state.pdfZoomLevel;

                context.drawImage(sigImage, canvasX, canvasY, sigWidth, sigHeight);

                if (ann.id === state.selectedAnnotationId) {
                    context.strokeStyle = 'rgba(0, 123, 255, 0.9)';
                    context.lineWidth = 2;
                    context.setLineDash([5, 5]);
                    context.strokeRect(canvasX - 5, canvasY - 5, sigWidth + 10, sigHeight + 10);
                    context.setLineDash([]);
                }
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
            
            const sigImage = await pdfDoc.embedPng(ann.data);
            
            // The stored coordinates are already normalized (0 to 1), so we just multiply by the page dimensions.
            const x = ann.placement.pdfX * pageWidth;
            const y = pageHeight - (ann.placement.pdfY * pageHeight); // PDF-lib's y-axis is bottom-up

            // We need to define signature dimensions in PDF points (e.g., 1 point = 1/72 inch)
            // Let's assume a standard width and scale it by the signature's own zoom.
            const sigWidthPoints = 90 * ann.zoom;
            const sigHeightPoints = sigWidthPoints / 2; // Maintain aspect ratio

            pageToSign.drawImage(sigImage, {
                x: x,
                y: y - sigHeightPoints, // Adjust y because drawImage's origin is bottom-left
                width: sigWidthPoints,
                height: sigHeightPoints,
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
        updateState({ ...state, ui: { ...state.ui, message: { text: '正在載入 PDF...', type: 'loading' } }, pdfZoomLevel: 1.0, showDownload: false });
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
                    selectedAnnotationId: null,
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

    findAnnotationAt(canvasX, canvasY) {
        if (!state.currentPdfPage) return null;
        const finalScale = state.fitScale * state.pdfZoomLevel;
        const baseViewport = state.currentPdfPage.getViewport({ scale: 1 });

        // Convert canvas click coordinates to normalized PDF coordinates
        const pdfX = canvasX / (baseViewport.width * finalScale);
        const pdfY = canvasY / (baseViewport.height * finalScale);

        const currentPageAnnotations = state.annotations.filter(ann => ann.pageNum === state.currentPageNum);
        for (const ann of [...currentPageAnnotations].reverse()) {
            // Define signature dimensions in normalized PDF space
            const sigWidthNormalized = (120 * ann.zoom * state.pdfZoomLevel) / (baseViewport.width * finalScale);
            const sigHeightNormalized = (60 * ann.zoom * state.pdfZoomLevel) / (baseViewport.height * finalScale);

            if (pdfX >= ann.placement.pdfX && pdfX <= ann.placement.pdfX + sigWidthNormalized &&
                pdfY >= ann.placement.pdfY && pdfY <= ann.placement.pdfY + sigHeightNormalized) {
                return ann;
            }
        }
        return null;
    },

    handleCanvasClick(e) {
        if (!state.currentPdfPage) return;
        const rect = UI.elements.pdfCanvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;

        const clickedAnnotation = this.findAnnotationAt(canvasX, canvasY);

        if (clickedAnnotation) {
            updateState({ ...state, selectedAnnotationId: clickedAnnotation.id });
            UI.renderPdfPage(state.currentPageNum);
            return;
        }

        const finalScale = state.fitScale * state.pdfZoomLevel;
        const baseViewport = state.currentPdfPage.getViewport({ scale: 1 });
        const pdfX = canvasX / (baseViewport.width * finalScale);
        const pdfY = canvasY / (baseViewport.height * finalScale);

        if (state.selectedAnnotationId) {
            const selectedAnnotation = state.annotations.find(a => a.id === state.selectedAnnotationId);
            if (selectedAnnotation) {
                const sigWidthNormalized = (120 * selectedAnnotation.zoom * state.pdfZoomLevel) / (baseViewport.width * finalScale);
                const sigHeightNormalized = (60 * selectedAnnotation.zoom * state.pdfZoomLevel) / (baseViewport.height * finalScale);
                
                selectedAnnotation.placement.pdfX = pdfX - sigWidthNormalized / 2;
                selectedAnnotation.placement.pdfY = pdfY - sigHeightNormalized / 2;
                
                UI.renderPdfPage(state.currentPageNum);
                History.saveState();
            }
        } else {
            state.currentAnnotationData = { placement: { pdfX, pdfY }, pageNum: state.currentPageNum };
            UI.openSignatureModal();
        }
    },

    handleSaveDrawing() {
        if (state.signaturePadInstance.isEmpty()) { alert('簽名欄位是空的。'); return; }
        const newAnnotation = {
            id: Date.now(),
            type: 'drawing',
            data: state.signaturePadInstance.toDataURL('image/png'),
            placement: state.currentAnnotationData.placement, // Already in { pdfX, pdfY }
            zoom: 1.0,
            pageNum: state.currentAnnotationData.pageNum,
        };
        updateState({
            ...state,
            annotations: [...state.annotations, newAnnotation],
            selectedAnnotationId: newAnnotation.id,
            ui: { ...state.ui, showDownload: true, message: { text: '簽名已放置。', type: 'info' } },
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
            updateState({ ...state, currentPageNum: newPageNum, selectedAnnotationId: null });
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

    handleZoom(direction) {
        if (!state.selectedAnnotationId) {
            updateState({ ...state, ui: { ...state.ui, message: { text: '請先點擊一個簽名以將其選取。', type: 'error' } } });
            return;
        }
        const selectedAnnotation = state.annotations.find(a => a.id === state.selectedAnnotationId);
        if (!selectedAnnotation) return;

        let newZoom = selectedAnnotation.zoom;
        if (direction === 'in') {
            newZoom += 0.25;
        } else {
            newZoom = Math.max(0.25, newZoom - 0.25);
        }
        selectedAnnotation.zoom = newZoom;

        UI.renderPdfPage(state.currentPageNum);
        History.saveState();
    },

    handlePdfZoom(direction) {
        let newZoom = state.pdfZoomLevel;
        if (direction === 'in') {
            newZoom += 0.25;
        } else {
            newZoom = Math.max(0.25, newZoom - 0.25);
        }
        updateState({ ...state, pdfZoomLevel: newZoom });
        UI.renderPdfPage(state.currentPageNum);
    },

    handleConfirmPosition() {
        updateState({
            ...state,
            selectedAnnotationId: null,
            ui: { ...state.ui, message: { text: '位置已確認。請點擊空白處放置新簽名。', type: 'success' } }
        });
        UI.renderPdfPage(state.currentPageNum);
    },

    handleResize() {
        if (state.currentPdfPage) UI.renderPdfPage(state.currentPageNum);
        if (state.signaturePadInstance && UI.elements.signatureModal.style.display === 'flex') UI.initializeSignaturePad();
    },

    bind() {
        const { pdfCanvas, prevPageButton, nextPageButton, zoomInButton, zoomOutButton, confirmPositionButton, pdfZoomInButton, pdfZoomOutButton, pdfZoomReset } = UI.elements;
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
        pdfZoomInButton.addEventListener('click', () => this.handlePdfZoom('in'));
        pdfZoomOutButton.addEventListener('click', () => this.handlePdfZoom('out'));
        pdfZoomReset.addEventListener('click', () => {
            updateState({ ...state, pdfZoomLevel: 1.0 });
            UI.renderPdfPage(state.currentPageNum);
        });
        confirmPositionButton.addEventListener('click', this.handleConfirmPosition.bind(this));
        
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
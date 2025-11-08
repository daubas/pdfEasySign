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
    annotations: [], // { id, type, data, placement, zoom, pageNum }
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
        zoomInButton: document.getElementById('zoomInButton'),
        zoomOutButton: document.getElementById('zoomOutButton'),
        confirmPositionButton: document.getElementById('confirmPositionButton'),
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
        this.elements.confirmPositionButton.disabled = state.selectedAnnotationId === null;
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
                const width = 120 * ann.zoom;
                const height = 60 * ann.zoom;
                context.drawImage(sigImage, ann.placement.x, ann.placement.y, width, height);

                if (ann.id === state.selectedAnnotationId) {
                    context.strokeStyle = 'rgba(0, 123, 255, 0.9)';
                    context.lineWidth = 2;
                    context.setLineDash([5, 5]);
                    context.strokeRect(ann.placement.x - 5, ann.placement.y - 5, width + 10, height + 10);
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

    findAnnotationAt(x, y) {
        const currentPageAnnotations = state.annotations.filter(ann => ann.pageNum === state.currentPageNum);
        for (const ann of [...currentPageAnnotations].reverse()) {
            const width = 120 * ann.zoom;
            const height = 60 * ann.zoom;
            if (x >= ann.placement.x && x <= ann.placement.x + width &&
                y >= ann.placement.y && y <= ann.placement.y + height) {
                return ann;
            }
        }
        return null;
    },

    handleCanvasClick(e) {
        if (!state.currentPdfPage) return;
        const rect = UI.elements.pdfCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const clickedAnnotation = this.findAnnotationAt(x, y);

        if (clickedAnnotation) {
            // Case 1: Clicked on an existing annotation. Select it.
            updateState({
                ...state,
                selectedAnnotationId: clickedAnnotation.id,
                ui: { ...state.ui, message: { text: '已選取簽名。請點擊新位置來移動，或點擊「確認位置」。', type: 'info' } }
            });
            UI.renderPdfPage(state.currentPageNum);
            return;
        }

        // Case 2: Clicked on the background.
        if (state.selectedAnnotationId) {
            // If an annotation is selected, move it to the new click position.
            const selectedAnnotation = state.annotations.find(a => a.id === state.selectedAnnotationId);
            if (selectedAnnotation) {
                const width = 120 * selectedAnnotation.zoom;
                const height = 60 * selectedAnnotation.zoom;
                selectedAnnotation.placement.x = x - width / 2;
                selectedAnnotation.placement.y = y - height / 2;
                
                UI.renderPdfPage(state.currentPageNum);
                History.saveState();
            }
        } else {
            // If nothing is selected, create a new signature.
            state.currentAnnotationData = { placement: { x, y }, pageNum: state.currentPageNum };
            UI.openSignatureModal();
        }
    },

    handleSaveDrawing() {
        if (state.signaturePadInstance.isEmpty()) { alert('簽名欄位是空的。'); return; }
        const newAnnotation = {
            id: Date.now(),
            type: 'drawing',
            data: state.signaturePadInstance.toDataURL('image/png'),
            placement: state.currentAnnotationData.placement,
            zoom: 1.0,
            pageNum: state.currentAnnotationData.pageNum,
        };
        updateState({
            ...state,
            annotations: [...state.annotations, newAnnotation],
            selectedAnnotationId: newAnnotation.id,
            ui: { ...state.ui, showDownload: true, message: { text: '簽名已放置，請調整位置或點擊「確認位置」。', type: 'info' } },
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
        const { pdfCanvas, prevPageButton, nextPageButton, zoomInButton, zoomOutButton, confirmPositionButton } = UI.elements;
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
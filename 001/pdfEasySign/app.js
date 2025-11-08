// ==================================================================================
// 0. Library Globals & Setup
// ==================================================================================
const { PDFDocument, rgb, StandardFonts } = PDFLib;
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
    annotations: [],
    currentAnnotationType: 'drawing',
    currentAnnotationData: null,
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
        textInputModal: document.getElementById('textInputModal'),
        textInput: document.getElementById('textInput'),
        fontSizeInput: document.getElementById('fontSizeInput'),
        fontColorInput: document.getElementById('fontColorInput'),
        pdfUndoButton: document.getElementById('pdfUndoButton'),
        pdfRedoButton: document.getElementById('pdfRedoButton'),
        prevPageButton: document.getElementById('prevPageButton'),
        nextPageButton: document.getElementById('nextPageButton'),
        pageIndicator: document.getElementById('pageIndicator'),
        addDrawingButton: document.getElementById('addDrawingButton'),
        addTextButton: document.getElementById('addTextButton'),
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

        if (this.elements.addDrawingButton && this.elements.addTextButton) {
            this.elements.addDrawingButton.classList.toggle('btn-primary', state.currentAnnotationType === 'drawing');
            this.elements.addDrawingButton.classList.toggle('btn', state.currentAnnotationType !== 'drawing');
            this.elements.addTextButton.classList.toggle('btn-primary', state.currentAnnotationType === 'text');
            this.elements.addTextButton.classList.toggle('btn', state.currentAnnotationType !== 'text');
        }
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
            if (ann.type === 'drawing') {
                const sigImage = new Image();
                sigImage.onload = () => {
                    context.drawImage(sigImage, ann.placement.x, ann.placement.y, 120 * ann.zoom, 60 * ann.zoom);
                };
                sigImage.src = ann.data;
            } else if (ann.type === 'text') {
                context.font = `${ann.font.size * ann.zoom}px ${ann.font.name}`;
                context.fillStyle = ann.color;
                context.fillText(ann.data, ann.placement.x, ann.placement.y);
            }
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

    openTextInputModal(placement) {
        this.elements.textInputModal.style.display = 'flex';
        this.elements.textInput.value = '';
        this.elements.fontSizeInput.value = 16;
        this.elements.fontColorInput.value = '#000000';
        state.currentAnnotationData = { placement, pageNum: state.currentPageNum };
    },
    closeTextInputModal() {
        this.elements.textInputModal.style.display = 'none';
        state.currentAnnotationData = null;
    },
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
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        for (const ann of annotations) {
            const pageToSign = pdfDoc.getPages()[ann.pageNum - 1];
            if (!pageToSign) continue;
            const { width: pageWidth, height: pageHeight } = pageToSign.getSize();
            const page = await state.pdfDoc.getPage(ann.pageNum);
            const viewport = page.getViewport({ scale: state.scale });
            const scaleX = pageWidth / viewport.width;
            const scaleY = pageHeight / viewport.height;

            if (ann.type === 'drawing') {
                const sigImage = await pdfDoc.embedPng(ann.data);
                pageToSign.drawImage(sigImage, {
                    x: ann.placement.x * scaleX,
                    y: pageHeight - (ann.placement.y * scaleY) - (60 * ann.zoom * scaleY),
                    width: 120 * ann.zoom * scaleX,
                    height: 60 * ann.zoom * scaleY,
                });
            } else if (ann.type === 'text') {
                pageToSign.drawText(ann.data, {
                    x: ann.placement.x * scaleX,
                    y: pageHeight - (ann.placement.y * scaleY) - (ann.font.size * ann.zoom),
                    font,
                    size: ann.font.size * ann.zoom,
                    color: rgb(parseInt(ann.color.slice(1, 3), 16) / 255, parseInt(ann.color.slice(3, 5), 16) / 255, parseInt(ann.color.slice(5, 7), 16) / 255),
                });
            }
        }
        return await pdfDoc.save();
    },
};

// ==================================================================================
// 4. History Module (Manages undo/redo state)
// ==================================================================================
const History = {
    saveState() {
        // FIX: Removed reference to non-existent state.signature
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
                    ui: { ...state.ui, currentView: 'sign', message: { text: 'PDF 載入成功！請選擇註釋類型並點擊 PDF 放置。', type: 'info' } },
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
        if (state.currentAnnotationType === 'drawing') {
            state.currentAnnotationData = { placement, pageNum: state.currentPageNum };
            UI.openSignatureModal();
        } else if (state.currentAnnotationType === 'text') {
            UI.openTextInputModal(placement);
        }
    },

    handleSaveDrawing() {
        if (state.signaturePadInstance.isEmpty()) { alert('簽名欄位是空的。'); return; }
        const newAnnotation = {
            id: Date.now(),
            type: 'drawing',
            data: state.signaturePadInstance.toDataURL('image/png'),
            placement: state.currentAnnotationData.placement,
            zoom: 1.0, // Zoom is now per-annotation, default to 1.0
            pageNum: state.currentAnnotationData.pageNum,
        };
        updateState({
            ...state,
            annotations: [...state.annotations, newAnnotation],
            ui: { ...state.ui, showDownload: true, message: { text: '簽名已儲存！', type: 'success' } },
        });
        UI.closeSignatureModal();
        UI.renderPdfPage(state.currentPageNum);
        History.saveState();
    },

    handleSaveText() {
        const textContent = UI.elements.textInput.value.trim();
        if (!textContent) { alert('文字內容不能為空。'); return; }
        const newAnnotation = {
            id: Date.now(),
            type: 'text',
            data: textContent,
            placement: state.currentAnnotationData.placement,
            zoom: 1.0,
            pageNum: state.currentAnnotationData.pageNum,
            font: { name: 'Helvetica', size: parseInt(UI.elements.fontSizeInput.value, 10) },
            color: UI.elements.fontColorInput.value,
        };
        updateState({
            ...state,
            annotations: [...state.annotations, newAnnotation],
            ui: { ...state.ui, showDownload: true, message: { text: '文字已儲存！', type: 'success' } },
        });
        UI.closeTextInputModal();
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

    handleSetAnnotationType(type) {
        updateState({ ...state, currentAnnotationType: type, ui: { ...state.ui, message: { text: `已選擇 ${type === 'drawing' ? '手寫簽名' : '文字輸入'}。請點擊 PDF 放置。`, type: 'info' } } });
    },

    handleResize() {
        if (state.currentPdfPage) UI.renderPdfPage(state.currentPageNum);
        if (state.signaturePadInstance && UI.elements.signatureModal.style.display === 'flex') UI.initializeSignaturePad();
    },

    // FIX: Correctly bind all events to the correct handlers
    bind() {
        const { pdfCanvas, prevPageButton, nextPageButton, addDrawingButton, addTextButton } = UI.elements;
        const uploadInput = document.getElementById('pdfUpload');
        const downloadButton = document.getElementById('downloadButton');
        const undoButton = document.getElementById('pdfUndoButton');
        const redoButton = document.getElementById('pdfRedoButton');
        
        // Signature Modal
        const clearSigButton = document.getElementById('clearSigButton');
        const saveSigButton = document.getElementById('saveSigButton');
        const cancelSigButton = document.getElementById('cancelSigButton');

        // Text Modal
        const saveTextButton = document.getElementById('saveTextButton');
        const cancelTextButton = document.getElementById('cancelTextButton');

        uploadInput.addEventListener('change', this.handleFileUpload.bind(this));
        pdfCanvas.addEventListener('click', this.handleCanvasClick.bind(this));
        downloadButton.addEventListener('click', this.handleDownload.bind(this));
        undoButton.addEventListener('click', History.undo.bind(History));
        redoButton.addEventListener('click', History.redo.bind(History));
        prevPageButton.addEventListener('click', () => this.handlePageChange('prev'));
        nextPageButton.addEventListener('click', () => this.handlePageChange('next'));
        addDrawingButton.addEventListener('click', () => this.handleSetAnnotationType('drawing'));
        addTextButton.addEventListener('click', () => this.handleSetAnnotationType('text'));
        
        clearSigButton.addEventListener('click', () => state.signaturePadInstance.clear());
        saveSigButton.addEventListener('click', this.handleSaveDrawing.bind(this));
        cancelSigButton.addEventListener('click', UI.closeSignatureModal.bind(UI));

        saveTextButton.addEventListener('click', this.handleSaveText.bind(this));
        cancelTextButton.addEventListener('click', UI.closeTextInputModal.bind(UI));

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
// ==================================================================================
// 0. Library Globals & Setup
// ==================================================================================
const { PDFDocument, rgb, StandardFonts } = PDFLib; // Added StandardFonts
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
    // --- MODIFIED: Replaced signature with annotations array ---
    annotations: [], // Stores all annotations: { id, type, data, placement: {x,y}, zoom, pageNum, font, color }
    currentAnnotationType: 'drawing', // 'drawing' or 'text'
    currentAnnotationData: null, // Temp storage for drawing dataUrl or text content
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
    textInputModalInstance: null, // For text input modal
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
        pdfMessage: document.getElementById('pdfMessage'),
        messageArea: document.getElementById('messageArea'),
        fileNameInput: document.getElementById('fileName'),
        signatureModal: document.getElementById('signatureModal'),
        signaturePadCanvas: document.getElementById('signaturePad'),
        pdfUndoButton: document.getElementById('pdfUndoButton'),
        pdfRedoButton: document.getElementById('pdfRedoButton'),
        prevPageButton: document.getElementById('prevPageButton'),
        nextPageButton: document.getElementById('nextPageButton'),
        pageIndicator: document.getElementById('pageIndicator'),
        // --- NEW: Text Annotation Modal Elements ---
        textInputModal: document.getElementById('textInputModal'),
        textInput: document.getElementById('textInput'),
        fontSizeInput: document.getElementById('fontSizeInput'),
        fontColorInput: document.getElementById('fontColorInput'),
        saveTextButton: document.getElementById('saveTextButton'),
        cancelTextButton: document.getElementById('cancelTextButton'),
        // --- NEW: Annotation Type Selection ---
        addDrawingButton: document.getElementById('addDrawingButton'),
        addTextButton: document.getElementById('addTextButton'),
    },

    showMessage(text, type = 'info') {
        const { messageArea } = this.elements;
        messageArea.innerHTML = '';
        if (type === 'loading') {
            messageArea.innerHTML = `<div class="loader"></div><p class="text-blue-600">${text}</p>`;
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

        // Update active annotation type button
        if (this.elements.addDrawingButton) {
            this.elements.addDrawingButton.classList.toggle('btn-primary', state.currentAnnotationType === 'drawing');
            this.elements.addDrawingButton.classList.toggle('btn', state.currentAnnotationType !== 'drawing');
        }
        if (this.elements.addTextButton) {
            this.elements.addTextButton.classList.toggle('btn-primary', state.currentAnnotationType === 'text');
            this.elements.addTextButton.classList.toggle('btn', state.currentAnnotationType !== 'text');
        }
    },

    async renderPdfPage(pageNum) {
        if (!state.pdfDoc) return;
        const page = await state.pdfDoc.getPage(pageNum);
        state.currentPdfPage = page;
        const containerWidth = this.elements.pdfContainer.clientWidth * 0.95;
        const viewportAtScale1 = page.getViewport({ scale: 1 });
        const scale = containerWidth / viewportAtScale1.width;
        state.scale = scale;
        const viewport = page.getViewport({ scale });
        const context = this.elements.pdfCanvas.getContext('2d');
        this.elements.pdfCanvas.height = viewport.height;
        this.elements.pdfCanvas.width = viewport.width;
        await page.render({ canvasContext: context, viewport }).promise;
        console.log(`Page ${pageNum} rendered.`);
        // --- MODIFIED: Draw all annotations for the current page ---
        this.drawAnnotationsPreview(pageNum);
        // --- END MODIFIED ---
    },

    // --- MODIFIED: drawAnnotationsPreview now draws all annotations ---
    drawAnnotationsPreview(pageNum) {
        const context = this.elements.pdfCanvas.getContext('2d');
        state.annotations.filter(ann => ann.pageNum === pageNum).forEach(ann => {
            if (ann.type === 'drawing') {
                const sigImage = new Image();
                sigImage.onload = () => {
                    const sigWidth = 120 * ann.zoom;
                    const sigHeight = 60 * ann.zoom;
                    context.drawImage(sigImage, ann.placement.x, ann.placement.y, sigWidth, sigHeight);
                };
                sigImage.src = ann.data;
            } else if (ann.type === 'text') {
                context.font = `${ann.font.size * ann.zoom}px ${ann.font.name}`;
                context.fillStyle = ann.color;
                context.fillText(ann.data, ann.placement.x, ann.placement.y);
            }
        });
    },
    // --- END MODIFIED ---

    initializeSignaturePad() {
        const canvas = this.elements.signaturePadCanvas;
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext("2d").scale(ratio, ratio);
        if (state.signaturePadInstance) state.signaturePadInstance.off();
        // --- MODIFIED: Ensure transparent background for signature pad ---
        state.signaturePadInstance = new SignaturePad(canvas, {
            backgroundColor: 'rgba(0,0,0,0)', // Transparent background
            penColor: 'rgb(0, 0, 0)',
        });
        // --- END MODIFIED ---
    },
    openSignatureModal() {
        this.elements.signatureModal.style.display = 'flex';
        if (!state.signaturePadInstance) this.initializeSignaturePad();
        state.signaturePadInstance.clear();
    },
    closeSignatureModal() { this.elements.signatureModal.style.display = 'none'; },

    // --- NEW: Text Input Modal Functions ---
    openTextInputModal(placement) {
        this.elements.textInputModal.style.display = 'flex';
        this.elements.textInput.value = '';
        this.elements.fontSizeInput.value = 12; // Default font size
        this.elements.fontColorInput.value = '#F0EFE3'; // Default font color (羊皮紙白)
        state.currentAnnotationData = { placement, pageNum: state.currentPageNum }; // Store temp data
    },
    closeTextInputModal() {
        this.elements.textInputModal.style.display = 'none';
        state.currentAnnotationData = null;
    },
    // --- END NEW ---
};

// ==================================================================================
// 3. PDF Module (Handles core PDF processing logic) - NOW PURE
// ==================================================================================
const PDF = {
    async loadPdf(pdfBytes) {
        const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
        const pdfDoc = await loadingTask.promise;
        return { pdfDoc, totalPages: pdfDoc.numPages };
    },
    // --- MODIFIED: embedAnnotations now embeds all annotations ---
    async embedAnnotations() {
        const { originalPdfBytes, annotations } = state;
        if (!originalPdfBytes) throw new Error('缺少原始 PDF 資料。');
        const pdfDoc = await PDFDocument.load(originalPdfBytes);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica); // Embed a standard font for text

        for (const ann of annotations) {
            const pageToSign = pdfDoc.getPages()[ann.pageNum - 1];
            if (!pageToSign) continue; // Skip if page doesn't exist

            const { width: pageWidth, height: pageHeight } = pageToSign.getSize();
            const viewport = state.pdfDoc.getPage(ann.pageNum).getViewport({ scale: state.scale }); // Get viewport for the specific page
            const scaleX = pageWidth / viewport.width;
            const scaleY = pageHeight / viewport.height;

            if (ann.type === 'drawing') {
                const sigImageBytes = await fetch(ann.data).then(res => res.arrayBuffer());
                const sigImage = await pdfDoc.embedPng(sigImageBytes);
                const sigWidthPoints = 120 * ann.zoom;
                const sigHeightPoints = 60 * ann.zoom;
                const pdfX = ann.placement.x * scaleX;
                const pdfY = pageHeight - (ann.placement.y * scaleY) - sigHeightPoints;
                pageToSign.drawImage(sigImage, { x: pdfX, y: pdfY, width: sigWidthPoints, height: sigHeightPoints });
            } else if (ann.type === 'text') {
                const textContent = ann.data;
                const fontSize = ann.font.size * ann.zoom; // Scale font size
                const textColor = ann.color ? rgb(
                    parseInt(ann.color.slice(1, 3), 16) / 255,
                    parseInt(ann.color.slice(3, 5), 16) / 255,
                    parseInt(ann.color.slice(5, 7), 16) / 255
                ) : rgb(0, 0, 0); // Default to black if no color
                const pdfX = ann.placement.x * scaleX;
                const pdfY = pageHeight - (ann.placement.y * scaleY) - fontSize; // Text Y is baseline

                pageToSign.drawText(textContent, {
                    x: pdfX,
                    y: pdfY,
                    font: font,
                    size: fontSize,
                    color: textColor,
                });
            }
        }
        return await pdfDoc.save();
    },
    // --- END MODIFIED ---
};

// ==================================================================================
// 4. History Module (Manages undo/redo state)
// ==================================================================================
const History = {
    saveState() {
        const currentState = {
            annotations: JSON.parse(JSON.stringify(state.annotations)), // Deep copy annotations
            zoom: state.signature.zoom, // Keep signature zoom for now, will be annotation-specific later
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
            updateState({
                ...state,
                historyPointer: newPointer,
                currentPageNum: previousState.pageNum,
                annotations: previousState.annotations, // Restore annotations array
            });
            UI.renderPdfPage(previousState.pageNum);
        }
    },
    redo() {
        if (state.historyPointer < state.history.length - 1) {
            const newPointer = state.historyPointer + 1;
            const nextState = state.history[newPointer];
            updateState({
                ...state,
                historyPointer: newPointer,
                currentPageNum: nextState.pageNum,
                annotations: nextState.annotations, // Restore annotations array
            });
            UI.renderPdfPage(nextState.pageNum);
        }
    },
};

// ==================================================================================
// 5. Event Handlers (The "Controller" layer) - CLEANED UP
// ==================================================================================
const Events = {
    async handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        const fileSizeLimit = 10 * 1024 * 1024;
        if (file.size > fileSizeLimit) {
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
                const pdfData = await PDF.loadPdf(event.target.result);
                updateState({
                    ...state,
                    originalPdfBytes: event.target.result,
                    pdfDoc: pdfData.pdfDoc,
                    totalPages: pdfData.totalPages,
                    currentPageNum: 1,
                    annotations: [], // Clear annotations on new PDF load
                    ui: { ...state.ui, currentView: 'sign', message: { text: 'PDF 載入成功！請點擊預覽圖以放置簽名。', type: 'info' } },
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

    // --- MODIFIED: handleSaveDrawing for new annotation structure ---
    handleSaveDrawing() {
        if (state.signaturePadInstance.isEmpty()) { alert('簽名欄位是空的。'); return; }
        const dataUrl = state.signaturePadInstance.toDataURL('image/png');
        const newAnnotation = {
            id: Date.now(), // Unique ID
            type: 'drawing',
            data: dataUrl,
            placement: state.currentAnnotationData.placement,
            zoom: state.signature.zoom, // Use global signature zoom for now
            pageNum: state.currentAnnotationData.pageNum,
        };
        updateState({
            ...state,
            annotations: [...state.annotations, newAnnotation],
            ui: { ...state.ui, showDownload: true, message: { text: '簽名已儲存！您可以調整位置或下載。', type: 'success' } },
        });
        UI.closeSignatureModal();
        UI.renderPdfPage(state.currentPageNum);
        History.saveState();
    },
    // --- END MODIFIED ---

    // --- NEW: handleSaveText for text annotations ---
    handleSaveText() {
        const textContent = UI.elements.textInput.value.trim();
        if (!textContent) { alert('文字內容不能為空。'); return; }
        const fontSize = parseInt(UI.elements.fontSizeInput.value, 10);
        const fontColor = UI.elements.fontColorInput.value;

        const newAnnotation = {
            id: Date.now(),
            type: 'text',
            data: textContent,
            placement: state.currentAnnotationData.placement,
            zoom: 1.0, // Text zoom can be separate or fixed
            pageNum: state.currentAnnotationData.pageNum,
            font: { name: 'Helvetica', size: fontSize }, // Using Helvetica for now
            color: fontColor,
        };
        updateState({
            ...state,
            annotations: [...state.annotations, newAnnotation],
            ui: { ...state.ui, showDownload: true, message: { text: '文字已儲存！您可以調整位置或下載。', type: 'success' } },
        });
        UI.closeTextInputModal();
        UI.renderPdfPage(state.currentPageNum);
        History.saveState();
    },
    // --- END NEW ---

    async handlePageChange(direction) {
        let newPageNum = state.currentPageNum;
        if (direction === 'next' && newPageNum < state.totalPages) newPageNum++;
        else if (direction === 'prev' && newPageNum > 1) newPageNum--;
        if (newPageNum !== state.currentPageNum) {
            updateState({ ...state, currentPageNum: newPageNum, signature: { ...state.signature, placement: null } }); // Clear placement on page change
            await UI.renderPdfPage(newPageNum);
            History.saveState();
        }
    },

    async handleDownload() {
        updateState({ ...state, ui: { ...state.ui, message: { text: '正在處理 PDF...', type: 'loading' } } });
        try {
            const pdfBytes = await PDF.embedAnnotations(); // --- MODIFIED: Call embedAnnotations ---
            let fileName = UI.elements.fileNameInput.value.trim() || '已簽署文件';
            if (!fileName.toLowerCase().endsWith('.pdf')) fileName += '.pdf';
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
            updateState({ ...state, ui: { ...state.ui, message: { text: '處理完成！', type: 'success' } } });
        } catch (err) {
            console.error('嵌入簽名失敗:', err);
            updateState({ ...state, ui: { ...state.ui, message: { text: `嵌入簽名失敗: ${err.message}`, type: 'error' } } });
        }
    },

    handleZoom(direction) {
        let newZoom = state.signature.zoom; // This zoom will now apply to the *next* annotation
        if (direction === 'in') newZoom += 0.25;
        else newZoom = Math.max(0.25, newZoom - 0.25);
        updateState({ ...state, signature: { ...state.signature, zoom: newZoom } });
        UI.renderPdfPage(state.currentPageNum); // Re-render to show potential new zoom on existing annotations
        History.saveState();
    },

    // --- NEW: handleSetAnnotationType ---
    handleSetAnnotationType(type) {
        updateState({ ...state, currentAnnotationType: type, ui: { ...state.ui, message: { text: `已選擇 ${type === 'drawing' ? '手寫簽名' : '文字輸入'}。請點擊 PDF 放置。`, type: 'info' } } });
    },
    // --- END NEW ---

    handleResize() {
        if (state.currentPdfPage) UI.renderPdfPage(state.currentPageNum);
        if (state.signaturePadInstance && UI.elements.signatureModal.style.display === 'flex') UI.initializeSignaturePad();
    },

    bind() {
        const { pdfCanvas, prevPageButton, nextPageButton } = UI.elements;
        const uploadInput = document.getElementById('pdfUpload');
        const clearSigButton = document.getElementById('clearSigButton');
        const saveSigButton = document.getElementById('saveTextButton'); // --- MODIFIED: Bind to saveTextButton ---
        const cancelSigButton = document.getElementById('cancelSigButton');
        const downloadButton = document.getElementById('downloadButton');
        const newSignatureButton = document.getElementById('newSignatureButton'); // This button will now open drawing modal
        const zoomInButton = document.getElementById('zoomInButton');
        const zoomOutButton = document.getElementById('zoomOutButton');
        const undoButton = document.getElementById('pdfUndoButton');
        const redoButton = document.getElementById('pdfRedoButton');
        // --- NEW: Text Modal Buttons ---
        const saveTextButton = UI.elements.saveTextButton;
        const cancelTextButton = UI.elements.cancelTextButton;
        // --- NEW: Annotation Type Buttons ---
        const addDrawingButton = UI.elements.addDrawingButton;
        const addTextButton = UI.elements.addTextButton;

        uploadInput.addEventListener('change', this.handleFileUpload.bind(this));
        pdfCanvas.addEventListener('click', this.handleCanvasClick.bind(this));
        // --- MODIFIED: handleSaveDrawing is now called by newSignatureButton ---
        newSignatureButton.addEventListener('click', () => UI.openSignatureModal()); // This button now just opens the drawing modal
        saveSigButton.addEventListener('click', this.handleSaveDrawing.bind(this)); // --- MODIFIED: This is now saveDrawing ---
        downloadButton.addEventListener('click', this.handleDownload.bind(this));
        clearSigButton.addEventListener('click', () => state.signaturePadInstance.clear());
        cancelSigButton.addEventListener('click', UI.closeSignatureModal.bind(UI));
        zoomInButton.addEventListener('click', () => this.handleZoom('in'));
        zoomOutButton.addEventListener('click', () => this.handleZoom('out'));
        undoButton.addEventListener('click', History.undo.bind(History));
        redoButton.addEventListener('click', History.redo.bind(History));
        prevPageButton.addEventListener('click', () => this.handlePageChange('prev'));
        nextPageButton.addEventListener('click', () => this.handlePageChange('next'));
        window.addEventListener('resize', this.handleResize.bind(this));

        // --- NEW: Bind Text Modal Buttons ---
        saveTextButton.addEventListener('click', this.handleSaveText.bind(this));
        cancelTextButton.addEventListener('click', UI.closeTextInputModal.bind(UI));
        // --- NEW: Bind Annotation Type Buttons ---
        addDrawingButton.addEventListener('click', () => this.handleSetAnnotationType('drawing'));
        addTextButton.addEventListener('click', () => this.handleSetAnnotationType('text'));
    }
};

// ==================================================================================
// 6. App Initialization
// ==================================================================================
document.addEventListener('DOMContentLoaded', () => {
    Events.bind();
    UI.render();
});
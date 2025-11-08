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
    totalPages: 0, // Added for pagination
    scale: 1.5,
    signature: {
        dataUrl: null,
        placement: null,
        zoom: 1.0,
    },
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
        pdfMessage: document.getElementById('pdfMessage'),
        messageArea: document.getElementById('messageArea'),
        fileNameInput: document.getElementById('fileName'),
        signatureModal: document.getElementById('signatureModal'),
        signaturePadCanvas: document.getElementById('signaturePad'),
        pdfUndoButton: document.getElementById('pdfUndoButton'),
        pdfRedoButton: document.getElementById('pdfRedoButton'),
        // Added for pagination
        prevPageButton: document.getElementById('prevPageButton'),
        nextPageButton: document.getElementById('nextPageButton'),
        pageIndicator: document.getElementById('pageIndicator'),
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
        
        // Update history buttons
        this.elements.pdfUndoButton.disabled = state.historyPointer <= 0;
        this.elements.pdfRedoButton.disabled = state.historyPointer >= state.history.length - 1;

        // Update pagination UI
        this.elements.pageIndicator.textContent = `頁碼 ${state.currentPageNum} / ${state.totalPages}`;
        this.elements.prevPageButton.disabled = state.currentPageNum <= 1;
        this.elements.nextPageButton.disabled = state.currentPageNum >= state.totalPages;
    },

    async renderPdfPage(pageNum) {
        if (!state.pdfDoc) return;
        
        // Clear previous signature placement when changing pages
        updateState({ ...state, signature: { ...state.signature, placement: null } });

        const page = await state.pdfDoc.getPage(pageNum);
        state.currentPdfPage = page; // Direct mutation for the rendered page object

        const containerWidth = this.elements.pdfContainer.clientWidth * 0.95;
        const viewportAtScale1 = page.getViewport({ scale: 1 });
        const scale = containerWidth / viewportAtScale1.width;
        state.scale = scale;

        const viewport = page.getViewport({ scale });
        const context = this.elements.pdfCanvas.getContext('2d');
        this.elements.pdfCanvas.height = viewport.height;
        this.elements.pdfCanvas.width = viewport.width;

        await page.render({ canvasContext: context, viewport }).promise;
        console.log(`Page ${pageNum} rendered with scale:`, scale);
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
        // ... (no changes)
    },
    openSignatureModal() {
        // ... (no changes)
    },
    closeSignatureModal() {
        // ... (no changes)
    },
};

// ==================================================================================
// 3. PDF Module (Handles core PDF processing logic)
// ==================================================================================

const PDF = {
    async loadPdf(pdfBytes) {
        const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
        const pdfDoc = await loadingTask.promise;
        updateState({
            ...state,
            pdfDoc: pdfDoc,
            currentPageNum: 1,
            totalPages: pdfDoc.numPages, // Store total pages
        });
    },

    async embedSignature() {
        const { originalPdfBytes, signature, currentPageNum } = state;
        if (!originalPdfBytes || !signature.dataUrl || !signature.placement) {
            throw new Error('缺少 PDF、簽名或放置位置的資料。');
        }
        const pdfDoc = await PDFDocument.load(originalPdfBytes);
        // FIX: Use the current page number to get the correct page. (0-based index)
        const pageToSign = pdfDoc.getPages()[currentPageNum - 1];
        const { width: pageWidth, height: pageHeight } = pageToSign.getSize();
        
        const sigImageBytes = await fetch(signature.dataUrl).then(res => res.arrayBuffer());
        const sigImage = await pdfDoc.embedPng(sigImageBytes);
        
        const viewport = state.currentPdfPage.getViewport({ scale: state.scale });
        const scaleX = pageWidth / viewport.width;
        const scaleY = pageHeight / viewport.height;
        
        const baseSigWidthPoints = 120;
        const baseSigHeightPoints = 60;
        const sigWidthPoints = baseSigWidthPoints * signature.zoom;
        const sigHeightPoints = baseSigHeightPoints * signature.zoom;
        
        const pdfX = signature.placement.x * scaleX;
        const pdfY = pageHeight - (signature.placement.y * scaleY) - sigHeightPoints;
        
        pageToSign.drawImage(sigImage, {
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
    // ... (no changes)
};

// ==================================================================================
// 5. Event Handlers (The "Controller" layer)
// ==================================================================================

const Events = {
    async handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        // Add file size validation (10MB limit)
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
                await PDF.loadPdf(event.target.result);
                updateState({
                    ...state,
                    ui: { ...state.ui, currentView: 'sign', message: { text: 'PDF 載入成功！請點擊預覽圖以放置簽名。', type: 'info' } },
                });
                await UI.renderPdfPage(state.currentPageNum);
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
        
        if (!state.signature.dataUrl) {
            state.signature.placement = placement;
            UI.openSignatureModal();
        } else {
            updateState({ ...state, signature: { ...state.signature, placement } });
            UI.renderPdfPage(state.currentPageNum); // Re-render current page with new placement
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
            ...state,
            signature: { ...state.signature, dataUrl },
            ui: { ...state.ui, showDownload: true, message: { text: '簽名已儲存！您可以調整位置或下載。', type: 'success' } },
        });
        UI.closeSignatureModal();
        UI.renderPdfPage(state.currentPageNum); // Re-render to show signature preview
        History.saveState();
    },

    async handlePageChange(direction) {
        let newPageNum = state.currentPageNum;
        if (direction === 'next' && newPageNum < state.totalPages) {
            newPageNum++;
        } else if (direction === 'prev' && newPageNum > 1) {
            newPageNum--;
        }

        if (newPageNum !== state.currentPageNum) {
            updateState({ ...state, currentPageNum: newPageNum });
            await UI.renderPdfPage(newPageNum);
            History.saveState();
        }
    },

    async handleDownload() {
        // ... (no changes to download logic itself)
    },
    handleZoom(direction) {
        // ... (no changes)
    },
    handleResize() {
        // ... (no changes)
    },

    bind() {
        const { pdfCanvas, prevPageButton, nextPageButton } = UI.elements;
        // ... (other bindings remain)
        
        prevPageButton.addEventListener('click', () => this.handlePageChange('prev'));
        nextPageButton.addEventListener('click', () => this.handlePageChange('next'));
        // ... (rest of bindings)
    }
};

// ... (App Initialization)

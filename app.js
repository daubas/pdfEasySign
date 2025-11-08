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
        currentView: 'upload', // 'upload', 'sign', 'download'
        message: { text: '', type: 'info' }, // { text, type }
    },
    signaturePadInstance: null,
};

function updateState(newState) {
    Object.assign(state, newState);
    // Potentially, you could trigger re-renders or updates here if using a more complex UI framework
}

// ==================================================================================
// 2. UI Module (Handles all DOM manipulations)
// ==================================================================================

const UI = {
    // Element cache
    elements: {
        uploadContainer: document.getElementById('uploadContainer'),
        pdfContainer: document.getElementById('pdfContainer'),
        downloadContainer: document.getElementById('downloadContainer'),
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
        messageArea.innerHTML = ''; // Clear previous messages
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
        // Show/hide main containers based on state
        this.elements.uploadContainer.classList.toggle('hidden', state.ui.currentView !== 'upload');
        this.elements.pdfContainer.classList.toggle('hidden', state.ui.currentView !== 'sign');
        this.elements.downloadContainer.classList.toggle('hidden', state.ui.currentView !== 'download');

        // Update message area
        this.showMessage(state.ui.message.text, state.ui.message.type);

        // Update buttons
        this.elements.pdfUndoButton.disabled = state.historyPointer <= 0;
        this.elements.pdfRedoButton.disabled = state.historyPointer >= state.history.length - 1;
    },

    async renderPdfPage() {
        if (!state.currentPdfPage) return;

        const containerWidth = this.elements.pdfContainer.clientWidth * 0.95;
        const viewportAtScale1 = state.currentPdfPage.getViewport({ scale: 1 });
        const scale = containerWidth / viewportAtScale1.width;
        updateState({ scale });

        const viewport = state.currentPdfPage.getViewport({ scale });
        const context = this.elements.pdfCanvas.getContext('2d');
        this.elements.pdfCanvas.height = viewport.height;
        this.elements.pdfCanvas.width = viewport.width;

        await state.currentPdfPage.render({ canvasContext: context, viewport }).promise;
        console.log('Page rendered.');

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
        
        const signaturePad = new SignaturePad(canvas, {
            backgroundColor: 'rgb(249, 249, 249)',
            penColor: 'rgb(0, 0, 0)',
        });
        updateState({ signaturePadInstance: signaturePad });
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
        const page = await pdfDoc.getPage(1); // Get the first page
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

        // Coordinate conversion
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
        
        // If we undo and then make a new change, we should clear the "redo" history
        const newHistory = state.history.slice(0, state.historyPointer + 1);
        
        updateState({
            history: [...newHistory, currentState],
            historyPointer: newHistory.length,
        });
        UI.render();
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
            UI.render();
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
            UI.render();
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
            updateState({ ui: { ...state.ui, message: { text: 'Please select a PDF file.', type: 'error' } } });
            UI.render();
            return;
        }

        updateState({ ui: { ...state.ui, message: { text: 'Loading PDF...', type: 'loading' } } });
        UI.render();

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                await PDF.loadPdf(event.target.result);
                updateState({
                    ui: { ...state.ui, currentView: 'sign', message: { text: 'PDF loaded successfully! Click on the preview to place your signature.', type: 'info' } },
                });
                // First, render the UI to make the container visible
                UI.render();
                // Now that the container is visible, render the PDF page
                await UI.renderPdfPage();
                History.saveState(); // Save the initial blank state
            } catch (err) {
                console.error('Failed to load PDF:', err);
                updateState({ ui: { ...state.ui, message: { text: `Failed to load PDF: ${err.message}`, type: 'error' } } });
                UI.render();
            }
        };
        reader.readAsArrayBuffer(file);
    },

    handleCanvasClick(e) {
        if (!state.currentPdfPage) return;

        const rect = UI.elements.pdfCanvas.getBoundingClientRect();
        const placement = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        
        updateState({ signature: { ...state.signature, placement } });

        if (!state.signature.dataUrl) {
            UI.openSignatureModal();
        } else {
            updateState({ ui: { ...state.ui, message: { text: 'Signature position updated.', type: 'info' } } });
            History.saveState();
            UI.renderPdfPage();
        }
    },

    handleSaveSignature() {
        if (state.signaturePadInstance.isEmpty()) {
            alert('Signature is empty.');
            return;
        }
        const dataUrl = state.signaturePadInstance.toDataURL('image/png');
        updateState({
            signature: { ...state.signature, dataUrl },
            ui: { ...state.ui, currentView: 'sign', message: { text: 'Signature saved! You can adjust the position or download.', type: 'success' } },
        });
        UI.elements.downloadContainer.classList.remove('hidden'); // Explicitly show download button
        UI.closeSignatureModal();
        History.saveState();
        UI.renderPdfPage();
        UI.render();
    },

    async handleDownload() {
        updateState({ ui: { ...state.ui, message: { text: 'Processing PDF...', type: 'loading' } } });
        UI.render();
        try {
            const pdfBytes = await PDF.embedSignature();
            let fileName = UI.elements.fileNameInput.value.trim() || 'signed_document';
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

            updateState({ ui: { ...state.ui, message: { text: 'Processing complete!', type: 'success' } } });
            UI.render();
        } catch (err) {
            console.error('Failed to embed signature:', err);
            updateState({ ui: { ...state.ui, message: { text: `Failed to embed signature: ${err.message}`, type: 'error' } } });
            UI.render();
        }
    },

    handleZoom(direction) {
        let newZoom = state.signature.zoom;
        if (direction === 'in') {
            newZoom += 0.25;
        } else {
            newZoom = Math.max(0.25, newZoom - 0.25);
        }
        updateState({ signature: { ...state.signature, zoom: newZoom } });
        History.saveState();
        UI.renderPdfPage();
    },

    handleResize() {
        if (state.signaturePadInstance && UI.elements.signatureModal.style.display === 'flex') {
            UI.initializeSignaturePad();
        }
        if (state.currentPdfPage) {
            UI.renderPdfPage();
        }
    },

    bind() {
        // Get all interactive elements from the UI module
        const { pdfCanvas, signaturePadCanvas } = UI.elements;
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

        // Bind events
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

document.addEventListener('DOMContentLoaded', () => {
    // Set up pdf.js worker
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js';
    
    // Bind all event listeners
    Events.bind();

    // Initial render
    UI.render();
});
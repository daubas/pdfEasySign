# Project Overview

This project is a simple, single-page web application for electronically signing PDF documents. Users can upload a PDF, draw their signature in a modal window, place it on the PDF preview, and then download the modified document.

The application is built entirely with client-side technologies and is self-contained in a single `index.html` file.

**Key Technologies:**

*   **HTML5:** The core structure of the application.
*   **Tailwind CSS:** Used for styling the user interface, loaded via a CDN.
*   **JavaScript (ES Modules):** Handles all the application logic.
*   **pdf.js:** A library from Mozilla for rendering PDF documents in a `<canvas>` element.
*   **pdf-lib.js:** A library for creating and modifying PDF documents in JavaScript. It's used here to embed the user's signature into the original PDF.
*   **signature_pad.js:** A library for creating a smooth signature drawing pad using an HTML5 `<canvas>`.

**Architecture:**

The application follows a simple, monolithic architecture where all code (HTML, CSS, and JavaScript) resides in one file. It uses global variables to maintain the application's state, such as the loaded PDF data, the signature image, and the signature's placement coordinates.

The workflow is as follows:
1.  User selects a PDF file via an `<input type="file">` element.
2.  The file is read as an `ArrayBuffer` using `FileReader`.
3.  `pdf.js` is used to load the PDF and render the first page onto a `<canvas>`.
4.  When the user clicks on the canvas, a modal with a `signature_pad` canvas is displayed.
5.  The user draws their signature, which is then converted to a data URL (PNG image).
6.  The signature is drawn as a preview on the PDF canvas. The user can click again to move it.
7.  Upon clicking the "Download" button, `pdf-lib.js` is used to load the original PDF, embed the signature image at the correct coordinates, and save the new PDF.
8.  The final PDF is downloaded to the user's machine.

# Building and Running

This is a client-side only project with no build process.

**To run the application:**

1.  You do not need to install any dependencies as all libraries are loaded from a CDN.
2.  You need a local web server to serve the `index.html` file. This is because browser security policies (CORS) may prevent the PDF worker script from loading if you open the file directly from the local filesystem (`file:///...`).

    You can use any simple web server. For example, if you have Python installed, you can run:
    ```bash
    # For Python 3
    python3 -m http.server
    ```
    Or, if you have Node.js and `npx` installed:
    ```bash
    npx serve
    ```
3.  Once the server is running, open your web browser and navigate to the provided local address (e.g., `http://localhost:8000`).

There are no automated tests for this project.

# Development Conventions

*   **Code Style:** The code is written in a procedural style with global variables and functions. There is no explicit linter or formatter configuration.
*   **Dependencies:** All external libraries are loaded via CDN, which simplifies setup but makes the application dependent on these external services.
*   **State Management:** Application state is managed through a set of global variables (e.g., `pdfDoc`, `signatureDataUrl`, `zoomLevel`). This can make the application difficult to debug and maintain as it grows.
*   **Modularity:** The code is not modular. All logic is in a single `<script type="module">` block. Refactoring this into separate modules for UI, PDF handling, and state management would be a significant improvement.

# Third-Party Notices

agentOS context preserves and extends the Apache-2.0-licensed dsh-opencontext package. Its original license notice is distributed as `LICENSE.opencontext`; the package's own license is in `LICENSE`.

Runtime interfaces and dependencies used by this package include:
- DeepSeek Harness packages 0.1.5-rc.2 and Cordis 4.0.2 (see each installed package for its license).
- @melandlabs/opencontext 0.5.1 and @melandlabs/env-config 0.4.0.
- better-sqlite3 12.x and sqlite-vec 0.1.x for the existing OpenContext compatibility path.
- officeparser 8.0.0 (MIT) for local DOCX/XLSX/PPTX/PDF/ODF/RTF/EPUB text extraction. Its runtime dependencies include @xmldom/xmldom, fflate, file-type, pdfjs-dist and tesseract.js under their respective licenses. OCR is disabled by this plugin.
- React 18.3.1 and the DSH native UI primitives for client presentation.
- Three.js 0.186.1 (MIT) for the optional WebGL 3D knowledge-graph view; it is bundled into the client artifact.

This notice does not replace the license files distributed by those projects.

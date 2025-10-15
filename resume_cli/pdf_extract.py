from pathlib import Path
from typing import Tuple, Dict
import io
from pypdf import PdfReader
from pdfminer.high_level import extract_text as pdfminer_extract_text
from pdf2image import convert_from_path
from PIL import Image
import pytesseract


def extract_text_from_pdf(path: Path) -> Tuple[str, Dict]:
    """Attempt layered extraction: pypdf -> pdfminer -> OCR fallback.

    Returns tuple of (text, metadata).
    """
    text = ""
    meta: Dict = {"method": None, "pages": 0}

    # First try PyPDF (fast, good for digital PDFs)
    try:
        reader = PdfReader(str(path))
        pages_text = []
        for page in reader.pages:
            pages_text.append(page.extract_text() or "")
        text = "\n".join(pages_text).strip()
        if text:
            meta["method"] = "pypdf"
            meta["pages"] = len(reader.pages)
            return text, meta
    except Exception:
        pass

    # Next try pdfminer (more thorough text extraction)
    try:
        text = pdfminer_extract_text(str(path)) or ""
        if text.strip():
            meta["method"] = "pdfminer"
            # Pages unknown cheaply; leave default
            return text.strip(), meta
    except Exception:
        pass

    # OCR fallback using Tesseract via pdf2image
    images = convert_from_path(str(path))
    ocr_text_parts = []
    for img in images:
        gray = img.convert("L")
        ocr_text = pytesseract.image_to_string(gray)
        ocr_text_parts.append(ocr_text)
    text = "\n".join(ocr_text_parts).strip()
    meta["method"] = "ocr"
    meta["pages"] = len(images)
    return text, meta

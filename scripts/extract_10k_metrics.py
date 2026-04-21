import json
import re
from pathlib import Path

import pdfplumber

INPUT_DIR = Path("reports")
OUTPUT_FILE = Path("public/data/tenk_extracted.json")

# Human page numbers -> 0-based PDF indexes
PAGE_PROPERTIES = 27   # page 28
PAGE_PRODUCTION = 43   # page 44


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n\n", text)
    return text.strip()


def extract_number(text: str, keyword_patterns: list[str]) -> str | None:
    """
    Look for numbers near phrases like:
    - gold ounces produced
    - produced gold ounces
    - silver ounces produced
    - ounces of gold produced
    """
    if not text:
        return None

    number = r"(\d{1,3}(?:,\d{3})*(?:\.\d+)?)"

    patterns = []
    for phrase in keyword_patterns:
        patterns.extend([
            rf"{phrase}[^0-9]{{0,40}}{number}",
            rf"{number}[^A-Za-z]{{0,15}}{phrase}",
        ])

    for pat in patterns:
        m = re.search(pat, text, flags=re.IGNORECASE | re.DOTALL)
        if m:
            for g in m.groups():
                if g and re.match(r"^\d{1,3}(?:,\d{3})*(?:\.\d+)?$", g):
                    return g

    return None


def extract_production_metrics(page_text: str) -> dict:
    """
    Tries multiple phrase variants because annual reports vary a lot.
    """
    text = clean_text(page_text)

    gold_patterns = [
        r"gold ounces produced",
        r"ounces of gold produced",
        r"produced gold ounces",
        r"gold production",
        r"gold ounces",
    ]

    silver_patterns = [
        r"silver ounces produced",
        r"ounces of silver produced",
        r"produced silver ounces",
        r"silver production",
        r"silver ounces",
    ]

    gold_oz = extract_number(text, gold_patterns)
    silver_oz = extract_number(text, silver_patterns)

    return {
        "gold_ounces_produced": gold_oz,
        "silver_ounces_produced": silver_oz,
        "page_44_text": text,
    }


def extract_properties(page_text: str) -> dict:
    text = clean_text(page_text)
    return {
        "properties_page_text": text
    }


def process_pdf(pdf_path: Path) -> dict:
    result = {
        "file": pdf_path.name,
        "properties_page_number": 28,
        "production_page_number": 44,
        "properties": None,
        "gold_ounces_produced": None,
        "silver_ounces_produced": None,
        "errors": [],
    }

    try:
        with pdfplumber.open(pdf_path) as pdf:
            total_pages = len(pdf.pages)

            if PAGE_PROPERTIES >= total_pages:
                result["errors"].append(
                    f"Missing page 28. PDF only has {total_pages} pages."
                )
            else:
                properties_text = pdf.pages[PAGE_PROPERTIES].extract_text() or ""
                properties_data = extract_properties(properties_text)
                result["properties"] = properties_data["properties_page_text"]

            if PAGE_PRODUCTION >= total_pages:
                result["errors"].append(
                    f"Missing page 44. PDF only has {total_pages} pages."
                )
            else:
                production_text = pdf.pages[PAGE_PRODUCTION].extract_text() or ""
                production_data = extract_production_metrics(production_text)
                result["gold_ounces_produced"] = production_data["gold_ounces_produced"]
                result["silver_ounces_produced"] = production_data["silver_ounces_produced"]
                result["page_44_text"] = production_data["page_44_text"]

    except Exception as e:
        result["errors"].append(str(e))

    return result


def main():
    if not INPUT_DIR.exists():
        raise FileNotFoundError(f"Input folder not found: {INPUT_DIR}")

    pdf_files = sorted(INPUT_DIR.glob("*.pdf"))
    if not pdf_files:
        raise FileNotFoundError(f"No PDF files found in {INPUT_DIR}")

    all_results = []
    for pdf_file in pdf_files:
        print(f"Processing {pdf_file.name} ...")
        all_results.append(process_pdf(pdf_file))

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(all_results, indent=2), encoding="utf-8")

    print(f"Saved results to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()

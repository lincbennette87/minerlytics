import json
import re
from pathlib import Path
from typing import Any

INPUT_DIR = Path("public/data/mining_disclosure_reports")
OUTPUT_FILE = Path("public/data/tenk_extracted.json")

# Human page numbers
PAGE_PROPERTIES = 28
PAGE_PRODUCTION = 44


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n\n", text)
    return text.strip()


def extract_number(text: str, keyword_patterns: list[str]) -> str | None:
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
        match = re.search(pat, text, flags=re.IGNORECASE | re.DOTALL)
        if match:
            for g in match.groups():
                if g and re.fullmatch(r"\d{1,3}(?:,\d{3})*(?:\.\d+)?", g):
                    return g

    return None


def extract_production_metrics(page_text: str) -> dict:
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

    return {
        "gold_ounces_produced": extract_number(text, gold_patterns),
        "silver_ounces_produced": extract_number(text, silver_patterns),
        "page_44_text": text,
    }


def extract_properties(page_text: str) -> dict:
    return {"properties_page_text": clean_text(page_text)}


def join_page_blocks(blocks: list[Any]) -> str:
    parts = []

    for block in blocks:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict):
            for key in ["text", "content", "value", "raw_text"]:
                value = block.get(key)
                if isinstance(value, str) and value.strip():
                    parts.append(value)
                    break

    return clean_text("\n".join(parts))


def normalize_page_key(page_number: int) -> list[str]:
    """
    Candidate keys for matching page number in JSON maps.
    """
    return [
        str(page_number),
        f"{page_number}",
        f"page_{page_number}",
        f"Page_{page_number}",
        f"page-{page_number}",
        f"Page-{page_number}",
        f"page {page_number}",
        f"Page {page_number}",
    ]


def extract_page_text_from_pages_list(pages: list[Any], page_number: int) -> str | None:
    """
    Supports list formats like:
    [
      {"page": 28, "text": "..."},
      {"page_number": 44, "content": "..."}
    ]

    Also supports plain index-based list fallback.
    """
    # First try explicit page fields
    for item in pages:
        if isinstance(item, dict):
            page_fields = [
                item.get("page"),
                item.get("page_number"),
                item.get("pageNum"),
                item.get("number"),
            ]
            if page_number in page_fields or str(page_number) in [str(x) for x in page_fields if x is not None]:
                for key in ["text", "content", "raw_text", "value"]:
                    value = item.get(key)
                    if isinstance(value, str) and value.strip():
                        return clean_text(value)

                for key in ["blocks", "paragraphs", "items"]:
                    value = item.get(key)
                    if isinstance(value, list):
                        joined = join_page_blocks(value)
                        if joined:
                            return joined

    # Then fallback to 1-based page list position
    idx = page_number - 1
    if 0 <= idx < len(pages):
        item = pages[idx]
        if isinstance(item, str):
            return clean_text(item)
        if isinstance(item, dict):
            for key in ["text", "content", "raw_text", "value"]:
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    return clean_text(value)
            for key in ["blocks", "paragraphs", "items"]:
                value = item.get(key)
                if isinstance(value, list):
                    joined = join_page_blocks(value)
                    if joined:
                        return joined

    return None


def extract_page_text(data: dict[str, Any], page_number: int) -> str | None:
    """
    Try several likely JSON shapes.
    """

    # 1) Top-level page maps, e.g. {"pages": {"28": "...", "44": "..."}}
    for key in ["pages", "page_map", "page_text", "pageTexts", "page_texts"]:
        value = data.get(key)
        if isinstance(value, dict):
            for candidate in normalize_page_key(page_number):
                page_val = value.get(candidate)
                if isinstance(page_val, str) and page_val.strip():
                    return clean_text(page_val)
                if isinstance(page_val, list):
                    joined = join_page_blocks(page_val)
                    if joined:
                        return joined
                if isinstance(page_val, dict):
                    for inner_key in ["text", "content", "raw_text", "value"]:
                        inner_val = page_val.get(inner_key)
                        if isinstance(inner_val, str) and inner_val.strip():
                            return clean_text(inner_val)
                    for inner_key in ["blocks", "paragraphs", "items"]:
                        inner_val = page_val.get(inner_key)
                        if isinstance(inner_val, list):
                            joined = join_page_blocks(inner_val)
                            if joined:
                                return joined

    # 2) Top-level list of pages, e.g. {"pages": [{"page": 28, "text": "..."}]}
    for key in ["pages", "document_pages", "page_list"]:
        value = data.get(key)
        if isinstance(value, list):
            text = extract_page_text_from_pages_list(value, page_number)
            if text:
                return text

    # 3) Flat keys like {"page_28": "..."}
    for candidate in normalize_page_key(page_number):
        value = data.get(candidate)
        if isinstance(value, str) and value.strip():
            return clean_text(value)
        if isinstance(value, list):
            joined = join_page_blocks(value)
            if joined:
                return joined
        if isinstance(value, dict):
            for inner_key in ["text", "content", "raw_text", "value"]:
                inner_val = value.get(inner_key)
                if isinstance(inner_val, str) and inner_val.strip():
                    return clean_text(inner_val)

    # 4) OCR/content block structures, e.g. {"blocks": [{"page": 28, "text": "..."}]}
    for key in ["blocks", "content", "items"]:
        value = data.get(key)
        if isinstance(value, list):
            matching_parts = []
            for item in value:
                if not isinstance(item, dict):
                    continue

                page_fields = [
                    item.get("page"),
                    item.get("page_number"),
                    item.get("pageNum"),
                    item.get("number"),
                ]
                if page_number in page_fields or str(page_number) in [str(x) for x in page_fields if x is not None]:
                    for text_key in ["text", "content", "raw_text", "value"]:
                        text_val = item.get(text_key)
                        if isinstance(text_val, str) and text_val.strip():
                            matching_parts.append(text_val)

            if matching_parts:
                return clean_text("\n".join(matching_parts))

    return None


def process_json(json_path: Path) -> dict:
    result = {
        "file": json_path.name,
        "properties_page_number": PAGE_PROPERTIES,
        "production_page_number": PAGE_PRODUCTION,
        "properties": None,
        "gold_ounces_produced": None,
        "silver_ounces_produced": None,
        "errors": [],
    }

    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))

        properties_text = extract_page_text(data, PAGE_PROPERTIES)
        if not properties_text:
            result["errors"].append(f"Could not find page {PAGE_PROPERTIES}")
        else:
            result["properties"] = extract_properties(properties_text)["properties_page_text"]

        production_text = extract_page_text(data, PAGE_PRODUCTION)
        if not production_text:
            result["errors"].append(f"Could not find page {PAGE_PRODUCTION}")
        else:
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

    json_files = sorted(INPUT_DIR.glob("*.json"))
    if not json_files:
        raise FileNotFoundError(f"No JSON files found in {INPUT_DIR}")

    all_results = []
    for json_file in json_files:
        print(f"Processing {json_file.name} ...")
        all_results.append(process_json(json_file))

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(all_results, indent=2), encoding="utf-8")

    print(f"Saved results to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()

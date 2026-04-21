import json
import re
from pathlib import Path
from urllib.request import Request, urlopen

INPUT_DIR = Path("public/data/mining_disclosure_reports")
OUTPUT_FILE = Path("public/data/tenk_extracted.json")

SEC_HEADERS = {
    "User-Agent": "Minerlytics research team contact@example.com",
    "Accept-Encoding": "identity",
    "Host": "www.sec.gov",
}


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\xa0", " ")
    text = re.sub(r"\r", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n\n", text)
    return text.strip()


def strip_html(html: str) -> str:
    # Remove scripts/styles first
    html = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
    html = re.sub(r"(?is)<style.*?>.*?</style>", " ", html)

    # Convert some structural tags to line breaks
    html = re.sub(r"(?i)<br\s*/?>", "\n", html)
    html = re.sub(r"(?i)</p>", "\n", html)
    html = re.sub(r"(?i)</div>", "\n", html)
    html = re.sub(r"(?i)</tr>", "\n", html)
    html = re.sub(r"(?i)</td>", " ", html)
    html = re.sub(r"(?i)</th>", " ", html)
    html = re.sub(r"(?i)</li>", "\n", html)

    # Strip remaining tags
    text = re.sub(r"(?is)<[^>]+>", " ", html)

    # Decode a few common entities
    text = (
        text.replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&#160;", " ")
    )

    return clean_text(text)


def fetch_text(url: str) -> str:
    req = Request(url, headers=SEC_HEADERS)
    with urlopen(req, timeout=60) as resp:
        html = resp.read().decode("utf-8", errors="ignore")
    return strip_html(html)


def find_url_in_json(data: dict) -> str | None:
    candidates = [
        data.get("source_url"),
        data.get("url"),
        data.get("filing_url"),
        data.get("html_url"),
        data.get("document_url"),
    ]
    for c in candidates:
        if isinstance(c, str) and c.startswith("http"):
            return c

    # Nested metadata fallback
    metadata = data.get("metadata")
    if isinstance(metadata, dict):
        for key in ["source_url", "url", "filing_url", "html_url", "document_url"]:
            c = metadata.get(key)
            if isinstance(c, str) and c.startswith("http"):
                return c

    return None


def extract_properties_section(text: str) -> str | None:
    """
    Grab Item 2. Properties until the next item heading.
    """
    patterns = [
        r"(Item\s*2\.?\s*Properties)(.*?)(?=Item\s*3\.?\s*Legal Proceedings)",
        r"(Item\s*2\.?\s*Properties)(.*?)(?=Item\s*3\b)",
        r"(Item\s*2\.?\s*Properties)(.*?)(?=PART\s*II)",
    ]

    for pat in patterns:
        m = re.search(pat, text, flags=re.IGNORECASE | re.DOTALL)
        if m:
            return clean_text(m.group(1) + "\n" + m.group(2))

    return None


def extract_operation_blocks(text: str) -> list[dict]:
    """
    Finds operation sections that contain 'Gold ounces produced' and/or 'Silver ounces produced'.
    """
    operation_names = [
        "Las Chispas",
        "Palmarejo",
        "Rochester",
        "Kensington",
        "Wharf",
        "Silvertip",
    ]

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    results = []

    i = 0
    while i < len(lines):
        line = lines[i]
        if line in operation_names:
            op_name = line
            block_lines = [line]
            j = i + 1
            while j < len(lines):
                if lines[j] in operation_names and lines[j] != op_name:
                    break
                if re.match(r"Item\s+\d", lines[j], flags=re.I):
                    break
                block_lines.append(lines[j])
                j += 1

            block_text = " ".join(block_lines)

            gold_match = re.search(
                r"Gold ounces produced\s+(\d{1,3}(?:,\d{3})*(?:\.\d+)?)",
                block_text,
                flags=re.I,
            )
            silver_match = re.search(
                r"Silver ounces produced\s+(\d{1,3}(?:,\d{3})*(?:\.\d+)?)",
                block_text,
                flags=re.I,
            )

            if gold_match or silver_match:
                results.append({
                    "operation": op_name,
                    "gold_ounces_produced": gold_match.group(1) if gold_match else None,
                    "silver_ounces_produced": silver_match.group(1) if silver_match else None,
                    "raw_block": clean_text("\n".join(block_lines)),
                })

            i = j
        else:
            i += 1

    return results


def process_json_file(json_path: Path) -> dict:
    result = {
        "file": json_path.name,
        "source_url": None,
        "properties": None,
        "operations": [],
        "errors": [],
    }

    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception as e:
        result["errors"].append(f"Invalid JSON: {e}")
        return result

    url = find_url_in_json(data)
    if not url:
        # Fallback: infer URL if stored in another field later
        result["errors"].append("No SEC filing URL found in JSON")
        return result

    result["source_url"] = url

    try:
        filing_text = fetch_text(url)
    except Exception as e:
        result["errors"].append(f"Failed to fetch filing HTML: {e}")
        return result

    props = extract_properties_section(filing_text)
    if props:
        result["properties"] = props
    else:
        result["errors"].append("Could not extract Item 2. Properties section")

    ops = extract_operation_blocks(filing_text)
    if ops:
        result["operations"] = ops
    else:
        result["errors"].append("Could not extract operation production blocks")

    return result


def main():
    if not INPUT_DIR.exists():
        raise FileNotFoundError(f"Input folder not found: {INPUT_DIR}")

    json_files = sorted(INPUT_DIR.glob("*.json"))
    if not json_files:
        raise FileNotFoundError(f"No JSON files found in {INPUT_DIR}")

    results = []
    for jf in json_files:
        print(f"Processing {jf.name} ...")
        results.append(process_json_file(jf))

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Saved results to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()

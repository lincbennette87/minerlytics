import json
import re
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

INDEX_FILE = Path("public/data/mining_disclosure_index.json")
OUTPUT_FILE = Path("public/data/tenk_extracted.json")

SEC_HEADERS = {
"User-Agent": "Minerlytics research research@minerlytics.local",
"Accept-Encoding": "identity",
"Host": "www.sec.gov",
}


def fetch_html(url: str) -> str:
req = Request(url, headers=SEC_HEADERS)
with urlopen(req, timeout=60) as resp:
return resp.read().decode("utf-8", errors="ignore")


def clean_text(text: str) -> str:
if not text:
return ""
text = text.replace("\xa0", " ")
text = text.replace("&nbsp;", " ")
text = text.replace("&#160;", " ")
text = re.sub(r"\r", "\n", text)
text = re.sub(r"[ \t]+", " ", text)
text = re.sub(r"\n{3,}", "\n\n", text)
return text.strip()


def strip_html(html: str) -> str:
html = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
html = re.sub(r"(?is)<style.*?>.*?</style>", " ", html)

html = re.sub(r"(?i)<br\s*/?>", "\n", html)
html = re.sub(r"(?i)</p>", "\n", html)
html = re.sub(r"(?i)</div>", "\n", html)
html = re.sub(r"(?i)</tr>", "\n", html)
html = re.sub(r"(?i)</li>", "\n", html)
html = re.sub(r"(?i)</td>", " ", html)
html = re.sub(r"(?i)</th>", " ", html)

text = re.sub(r"(?is)<[^>]+>", " ", html)
text = (
text.replace("&amp;", "&")
.replace("&lt;", "<")
.replace("&gt;", ">")
)
return clean_text(text)


def resolve_primary_document_url(wrapper_url: str) -> tuple[str, str]:
"""
Returns:
(resolved_url, resolved_kind)

resolved_kind:
- wrapper
- ex99_1
"""
wrapper_html = fetch_html(wrapper_url)

if re.search(r"ex[-_]?99[_\-]?1", wrapper_url, flags=re.I):
return wrapper_url, "ex99_1"

matches = re.findall(r'href="([^"]+\.htm[^"]*)"', wrapper_html, flags=re.I)

ranked = []
for href in matches:
score = 0
lower = href.lower()
if "99_1" in lower or "99-1" in lower or "99.1" in lower:
score += 5
if "ex" in lower:
score += 2
ranked.append((score, href))

ranked.sort(reverse=True)

if ranked and ranked[0][0] > 0:
return urljoin(wrapper_url, ranked[0][1]), "ex99_1"

return wrapper_url, "wrapper"


def extract_section_by_heading(text: str, headings: list[str], end_markers: list[str]) -> str | None:
for heading in headings:
start_match = re.search(heading, text, flags=re.I | re.S)
if not start_match:
continue

start_idx = start_match.start()
tail = text[start_idx:]

nearest_end = None
for end_pat in end_markers:
m = re.search(end_pat, tail, flags=re.I | re.S)
if m:
end_idx = m.start()
if nearest_end is None or end_idx < nearest_end:
nearest_end = end_idx

if nearest_end is not None:
return clean_text(tail[:nearest_end])

return clean_text(tail[:12000])

return None


def extract_properties_section(text: str) -> str | None:
headings = [
r"\bItem\s*2\.?\s*Properties\b",
r"\bProperties\b",
r"\bProperty Description\b",
r"\bOur Properties\b",
r"\bMining Properties\b",
]
end_markers = [
r"\bItem\s*3\.?\b",
r"\bLegal Proceedings\b",
r"\bRisk Factors\b",
r"\bItem\s*4\.?\b",
r"\bDirectors and Officers\b",
r"\bManagement's Discussion and Analysis\b",
r"\bMD&A\b",
]
return extract_section_by_heading(text, headings, end_markers)


def extract_operations_section(text: str) -> str | None:
headings = [
r"\bOperations and Production\b",
r"\bOperating Statistics\b",
r"\bProduction\b",
r"\bSelected Annual Information\b",
r"\bOperating and Financial Review\b",
]
end_markers = [
r"\bMineral Reserves\b",
r"\bMineral Resources\b",
r"\bProperties\b",
r"\bItem\s*2\.?\b",
r"\bRisk Factors\b",
r"\bExploration\b",
r"\bSustainability\b",
]
return extract_section_by_heading(text, headings, end_markers)


def extract_number_near_phrase(text: str, phrases: list[str]) -> str | None:
num = r"(\d{1,3}(?:,\d{3})*(?:\.\d+)?)"

for phrase in phrases:
patterns = [
rf"{phrase}[^0-9]{{0,30}}{num}",
rf"{num}[^A-Za-z]{{0,15}}{phrase}",
]
for pat in patterns:
m = re.search(pat, text, flags=re.I | re.S)
if m:
for g in m.groups():
if g and re.fullmatch(r"\d{1,3}(?:,\d{3})*(?:\.\d+)?", g):
return g
return None


def extract_operation_rows(text: str) -> list[dict]:
operation_names = [
"Las Chispas",
"Palmarejo",
"Rochester",
"Kensington",
"Wharf",
"Silvertip",
"LaRonde",
"La Ronde",
"Canadian Malartic",
"Detour Lake",
"Fosterville",
"Macassa",
"Meadowbank",
"Meliadine",
"Pinos Altos",
"Creston Mascota",
"La India",
"Cerro Moro",
"Jacobina",
"El Peñón",
"Minera Florida",
]

lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
rows = []

i = 0
while i < len(lines):
line = lines[i]

matched_name = None
for op in operation_names:
if line.lower() == op.lower():
matched_name = op
break

if not matched_name:
i += 1
continue

block = [line]
j = i + 1
while j < len(lines):
stop = False
for op in operation_names:
if lines[j].lower() == op.lower() and op.lower() != matched_name.lower():
stop = True
break
if stop:
break
if re.match(r"item\s+\d", lines[j], flags=re.I):
break
block.append(lines[j])
j += 1

block_text = clean_text(" ".join(block))

gold = extract_number_near_phrase(
block_text,
[
r"gold ounces produced",
r"ounces of gold produced",
r"gold production",
r"gold ounces",
],
)

silver = extract_number_near_phrase(
block_text,
[
r"silver ounces produced",
r"ounces of silver produced",
r"silver production",
r"silver ounces",
],
)

if gold or silver:
rows.append(
{
"operation": matched_name,
"gold_ounces_produced": gold,
"silver_ounces_produced": silver,
"raw_block": block_text,
}
)

i = j

return rows


def extract_totals(text: str) -> dict:
return {
"gold_ounces_produced": extract_number_near_phrase(
text,
[
r"gold ounces produced",
r"ounces of gold produced",
r"gold production",
r"gold ounces",
],
),
"silver_ounces_produced": extract_number_near_phrase(
text,
[
r"silver ounces produced",
r"ounces of silver produced",
r"silver production",
r"silver ounces",
],
),
}


def normalize_index_data(data):
"""
Supports:
1) [ {...}, {...} ]
2) { "data": [ {...} ] }
3) { "records": [ {...} ] }
4) { "items": [ {...} ] }
5) { "something": { ... }, "something2": { ... } }
"""
if isinstance(data, list):
return data

if isinstance(data, dict):
for key in ["data", "records", "items", "results", "filings"]:
value = data.get(key)
if isinstance(value, list):
return value

dict_values = [v for v in data.values() if isinstance(v, dict)]
if dict_values:
return dict_values

raise ValueError("Unsupported JSON format for mining_disclosure_index.json")


def process_entry(entry: dict) -> dict:
result = {
"ticker": entry.get("ticker"),
"cik": entry.get("cik"),
"accessionNumber": entry.get("accessionNumber"),
"form": entry.get("form"),
"filingDate": entry.get("filingDate"),
"source_url": entry.get("url"),
"resolved_url": None,
"resolved_kind": None,
"output": entry.get("output"),
"properties": None,
"operations": [],
"totals": {
"gold_ounces_produced": None,
"silver_ounces_produced": None,
},
"errors": [],
}

source_url = entry.get("url")
if not source_url:
result["errors"].append("Missing url in index entry")
return result

try:
resolved_url, resolved_kind = resolve_primary_document_url(source_url)
result["resolved_url"] = resolved_url
result["resolved_kind"] = resolved_kind

html = fetch_html(resolved_url)
text = strip_html(html)

props = extract_properties_section(text)
if props:
result["properties"] = props
else:
result["errors"].append("Could not extract properties section")

operations_section = extract_operations_section(text)
target_text = operations_section if operations_section else text

ops = extract_operation_rows(target_text)
if ops:
result["operations"] = ops
else:
result["errors"].append("Could not extract operation production blocks")

totals = extract_totals(target_text)
result["totals"] = totals

except Exception as e:
result["errors"].append(str(e))

return result


def main():
if not INDEX_FILE.exists():
raise FileNotFoundError(f"Index file not found: {INDEX_FILE}")

raw = INDEX_FILE.read_text(encoding="utf-8")
data = json.loads(raw)

print("Top-level type:", type(data).__name__)
if isinstance(data, dict):
print("Top-level keys:", list(data.keys())[:20])

entries = normalize_index_data(data)

print(f"Total normalized entries: {len(entries)}")

results = []
for entry in entries:
if not isinstance(entry, dict):
continue
if entry.get("form") not in {"10-K", "40-F", "20-F"}:
continue

print(
f"Processing {entry.get('ticker')} "
f"{entry.get('accessionNumber')} ..."
)
results.append(process_entry(entry))

OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
OUTPUT_FILE.write_text(json.dumps(results, indent=2), encoding="utf-8")
print(f"Saved results to {OUTPUT_FILE}")


if __name__ == "__main__":
main()

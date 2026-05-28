from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
UNIVERSE_PATH = ROOT / "public" / "universe.json"
OUTPUT_PATH = ROOT / "Minerlytics_Ticker_Universe_By_Category.pdf"


def load_items() -> list[dict]:
    data = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))
    items = data.get("items", [])
    normalized = []
    for item in items:
      normalized.append({
          "symbol": str(item.get("symbol", "")).strip().upper(),
          "name": str(item.get("name", "")).strip(),
          "metal": str(item.get("metal", "")).strip().lower(),
          "aliases": [str(alias).strip() for alias in item.get("aliases", []) if str(alias).strip()],
      })
    return [item for item in normalized if item["symbol"] and item["name"] and item["metal"]]


def build_pdf(items: list[dict]) -> None:
    groups: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        groups[item["metal"]].append(item)

    order = ["gold", "silver", "copper", "diamond"]
    doc = SimpleDocTemplate(
        str(OUTPUT_PATH),
        pagesize=letter,
        leftMargin=0.65 * inch,
        rightMargin=0.65 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "MinerTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=26,
        textColor=colors.HexColor("#1f1f1f"),
        spaceAfter=6,
    )
    subtitle_style = ParagraphStyle(
        "MinerSubtitle",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        textColor=colors.HexColor("#5b5b5b"),
        spaceAfter=14,
    )
    section_style = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=14,
        leading=18,
        textColor=colors.HexColor("#7a6032"),
        spaceBefore=6,
        spaceAfter=8,
    )
    note_style = ParagraphStyle(
        "Note",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9,
        leading=13,
        textColor=colors.HexColor("#4b5563"),
    )

    story = [
        Paragraph("Minerlytics Ticker Universe By Category", title_style),
        Paragraph(
            "Current ticker list grouped from the app universe for homepage search and company discovery.",
            subtitle_style,
        ),
    ]

    for metal in order:
        entries = sorted(groups.get(metal, []), key=lambda item: item["symbol"])
        if not entries:
            continue

        story.append(Paragraph(f"{metal.title()} ({len(entries)})", section_style))
        rows = [["Ticker", "Company", "Aliases / Notes"]]
        for entry in entries:
            alias_text = ", ".join(entry["aliases"][:3]) if entry["aliases"] else "-"
            rows.append([entry["symbol"], entry["name"], alias_text])

        table = Table(rows, colWidths=[0.95 * inch, 2.7 * inch, 3.4 * inch], repeatRows=1)
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, 0), 9),
                    ("BOTTOMPADDING", (0, 0), (-1, 0), 7),
                    ("TOPPADDING", (0, 0), (-1, 0), 7),
                    ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f8f6f1")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f8f6f1"), colors.HexColor("#f1ede3")]),
                    ("TEXTCOLOR", (0, 1), (-1, -1), colors.HexColor("#1f2937")),
                    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                    ("FONTSIZE", (0, 1), (-1, -1), 8.5),
                    ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#d1c7b6")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 1), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
                ]
            )
        )
        story.append(table)
        story.append(Spacer(1, 0.18 * inch))

    story.append(
        Paragraph(
            "Categories are based on the current Minerlytics search universe and include miners, royalties, funds, and diamond-related names where supported in the app.",
            note_style,
        )
    )

    doc.build(story)


if __name__ == "__main__":
    build_pdf(load_items())
    print(OUTPUT_PATH)

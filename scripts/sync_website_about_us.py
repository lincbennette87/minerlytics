#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import re
import ssl
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

try:
    from sync_company_homepages import CURATED_HOMEPAGES as CURATED_COMPANY_HOMEPAGES
except Exception:
    CURATED_COMPANY_HOMEPAGES = {}
try:
    from sync_website_project_portfolio import KNOWN_LANDING_PATHS as PROJECT_KNOWN_LANDING_PATHS
    from sync_website_project_portfolio import KNOWN_PROJECT_PATHS as PROJECT_KNOWN_PROJECT_PATHS
except Exception:
    PROJECT_KNOWN_LANDING_PATHS = {}
    PROJECT_KNOWN_PROJECT_PATHS = {}


DEFAULT_USER_AGENT = "Minerlytics/0.2 website-about-us"
ABOUT_TEXT_PATTERNS = [
    "about us",
    "about",
    "who we are",
    "company",
    "corporate profile",
    "corporate overview",
    "overview",
]
ABOUT_URL_PATTERNS = [
    "/about",
    "/about-us",
    "/company",
    "/corporate",
    "/who-we-are",
    "/overview",
]
GENERATED_ABOUT_PATHS = [
    "/about/",
    "/about-us/",
    "/company/",
    "/company/about/",
    "/corporate/",
    "/corporate/about/",
    "/who-we-are/",
    "/overview/",
]
ABOUT_CONTEXT_TERMS = [
    "about us",
    "who we are",
    "company overview",
    "corporate profile",
    "corporate overview",
    "our company",
    "our business",
    "our story",
]
COMMODITY_PATTERNS = [
    ("gold", r"\bgold\b|\bau\b"),
    ("silver", r"\bsilver\b|\bag\b"),
    ("copper", r"\bcopper\b|\bcu\b"),
    ("lithium", r"\blithium\b"),
    ("uranium", r"\buranium\b|u3o8"),
    ("rare earths", r"\brare earths?\b|\brare-earths?\b|\bneodymium\b|\bpraseodymium\b"),
    ("diamonds", r"\bdiamonds?\b"),
    ("platinum group metals", r"\bpgm\b|\bpgms\b|\bplatinum\b|\bpalladium\b|\brhodium\b"),
    ("zinc", r"\bzinc\b"),
    ("lead", r"\blead\b(?=\s*(?:-|and|,|zinc|ore|concentrate|mineral|mine|mining|production))|\bpb\b"),
    ("nickel", r"\bnickel\b"),
    ("iron ore", r"\biron ore\b"),
    ("coal", r"\bcoal\b"),
    ("potash", r"\bpotash\b"),
]
SUMMARY_CONTEXT_TERMS = [
    "mine",
    "mining",
    "miner",
    "mineral",
    "exploration",
    "development",
    "producer",
    "production",
    "project",
    "portfolio",
    "operation",
    "royalty",
    "streaming",
    "reserve",
    "resource",
    "fund",
    "etf",
    "trust",
]
PROFILE_LINK_TERMS = [
    "about",
    "about us",
    "assets",
    "company",
    "corporate",
    "development",
    "exploration",
    "mine",
    "mines",
    "operation",
    "operations",
    "portfolio",
    "project",
    "projects",
    "properties",
    "property",
    "who we are",
    "where we operate",
]
PROFILE_NEGATIVE_URL_TERMS = [
    "annual-report",
    "award",
    "board",
    "career",
    "contact",
    "cookie",
    "disclaimer",
    "document-library",
    "event",
    "governance",
    "investor",
    "leadership",
    "login",
    "media",
    "news",
    "person-details",
    "privacy",
    "recognition",
    "sedar",
    "sec-filings",
    "subscribe",
    "sustainability",
    "terms",
]
COMMON_PROFILE_PATHS = [
    "/about/",
    "/about-us/",
    "/company/",
    "/corporate/",
    "/who-we-are/",
    "/overview/",
    "/operations/",
    "/operations/default.aspx",
    "/assets/",
    "/assets/default.aspx",
    "/portfolio/",
    "/portfolio/default.aspx",
    "/projects/",
    "/projects/default.aspx",
    "/properties/",
    "/mines/",
    "/our-assets/",
    "/our-business/",
    "/where-we-operate/",
    "/development-projects/",
    "/exploration/",
]
LOCAL_KNOWN_PROFILE_PATHS = {
    "LAC": ["/thacker-pass/overview/default.aspx", "/thacker-pass/"],
    "MP": ["/mountain-pass", "/facilities/"],
    "NEM": ["/operations-and-projects/default.aspx"],
}
LOCATION_NAMES = [
    "Alaska",
    "Argentina",
    "Arizona",
    "Australia",
    "Bolivia",
    "Botswana",
    "Brazil",
    "British Columbia",
    "Burkina Faso",
    "California",
    "Canada",
    "Chile",
    "China",
    "Colombia",
    "Democratic Republic of Congo",
    "DRC",
    "Dominican Republic",
    "Ecuador",
    "Finland",
    "Ghana",
    "Guatemala",
    "Guyana",
    "Idaho",
    "Kazakhstan",
    "Mali",
    "Manitoba",
    "Mauritania",
    "Mexico",
    "Montana",
    "Namibia",
    "Nevada",
    "New South Wales",
    "Newfoundland",
    "Northwest Territories",
    "Nunavut",
    "Ontario",
    "Papua New Guinea",
    "Peru",
    "Quebec",
    "Saskatchewan",
    "South Africa",
    "Suriname",
    "Sweden",
    "Tanzania",
    "Turkey",
    "United States",
    "Utah",
    "Western Australia",
    "Yukon",
    "Zacatecas",
]
ASSET_NAME_RE = re.compile(
    r"\b([A-Z][A-Za-z0-9'&.,()/\- ]{2,85}?\s(?:Mine|Mines|Project|Complex|Operation|Operations|Property|District|Deposit|Plant))\b"
)
CURATED_HOMEPAGES = {
    **CURATED_COMPANY_HOMEPAGES,
    "IAUX": "https://www.i80gold.com/",
    "PZG": "https://paramountnevada.com/",
}
CURATED_SUMMARY_OVERRIDES = {
    "BHP": {
        "source_url": "https://www.bhp.com/",
        "title": "BHP company overview",
        "summary": (
            "BHP Group Limited is a diversified global resources company with mined commodity exposure "
            "including copper, iron ore, metallurgical coal, and potash. Its public website presents BHP "
            "as an operator of multiple producing mine hubs in Australia and the Americas rather than a "
            "single mine-count company, with Western Australia Iron Ore, copper operations such as Escondida "
            "and Olympic Dam, and metallurgical coal assets as major producing platforms. Development and "
            "growth exposure is led by the Jansen potash project in Saskatchewan, Canada, alongside copper "
            "and potash exploration and expansion work."
        ),
    },
    "PAAS": {
        "source_url": "https://www.panamericansilver.com/operations/",
        "title": "Pan American Silver operations overview",
        "summary": (
            "Pan American Silver Corp. is a silver and gold producer whose public operations pages describe "
            "a portfolio of producing mines across the Americas. The mined commodities include silver, gold, "
            "zinc, lead, and copper from underground and open-pit assets in Mexico, Peru, Bolivia, Argentina, "
            "Brazil, Chile, Canada, and Guatemala. The website presents roughly ten producing mines, with "
            "development or suspended/growth assets including Escobal, Navidad, and La Colorada Skarn, plus "
            "near-mine exploration around the operating portfolio."
        ),
    },
    "GLNCY": {
        "source_url": "https://www.glencore.com/what-we-do",
        "title": "Glencore what we do overview",
        "summary": (
            "Glencore plc is a diversified mining, processing, recycling, and commodity marketing company. "
            "Its public website groups the business by commodity and regional asset platform: mined and "
            "processed exposures include copper, cobalt, nickel, zinc, lead, ferroalloys, coal, and recycled "
            "precious and battery metals. Producing assets are geographically spread across Australia, Africa "
            "including the DRC and South Africa, Kazakhstan, Europe, Canada, Chile, Peru, Colombia, and other "
            "regions. Development and exploration exposure includes copper and base-metals growth projects "
            "such as El Pachon and regional extensions around existing operating districts."
        ),
    },
    "VALE": {
        "source_url": "https://www.vale.com/",
        "title": "Vale company overview",
        "summary": (
            "Vale S.A. is a Brazilian mining company with major mined commodity exposure to iron ore, iron "
            "ore pellets, nickel, copper, manganese, and other base-metals products. Its public website "
            "presents large producing systems led by iron ore "
            "operations in Brazil and base-metals operations in Brazil, Canada, and Indonesia. Development "
            "and growth work is concentrated around Brazilian iron ore systems and the Vale Base Metals "
            "copper and nickel portfolio, including projects and expansions in the Carajas and Sudbury-style "
            "operating regions."
        ),
    },
    "FQVLF": {
        "source_url": "https://www.first-quantum.com/",
        "title": "First Quantum Minerals company overview",
        "summary": (
            "First Quantum Minerals Ltd. is a copper-focused mining company with additional gold, nickel, "
            "and zinc exposure. Public company materials describe producing assets centered on Zambia, "
            "including Kansanshi and the Trident/Sentinel district, with additional operating or maintained "
            "assets in jurisdictions such as Mauritania, Turkey, Spain, Australia, and Panama. The production "
            "portfolio is copper-led, while development and growth projects include Kansanshi S3, Taca Taca, "
            "Haquira, and other copper expansion opportunities."
        ),
    },
    "IVPAF": {
        "source_url": "https://ivanhoemines.com/projects/",
        "title": "Ivanhoe Mines projects overview",
        "summary": (
            "Ivanhoe Mines Ltd. is a mining company focused on copper, zinc, platinum-group metals, nickel, "
            "copper, rhodium, gold, silver, and germanium. Its public project pages describe a small, high-"
            "impact portfolio in Southern Africa: Kamoa-Kakula in the Democratic Republic of Congo as the "
            "core producing copper complex, Kipushi in the DRC as a zinc-copper-germanium-silver mine brought "
            "back toward production, Platreef in South Africa as a major development-stage PGM-nickel-copper-"
            "gold project, and Western Foreland in the DRC as the principal copper exploration district."
        ),
    },
    "CSFFF": {
        "source_url": "https://capstonecopper.com/operations/",
        "title": "Capstone Copper operations overview",
        "summary": (
            "Capstone Copper Corp. is a copper producer whose public operations pages describe four producing "
            "operations: Pinto Valley in Arizona, Cozamin in Mexico, and Mantos Blancos and Mantoverde in "
            "Chile. The mined commodities are primarily copper, with by-product exposure to silver, gold, "
            "zinc, molybdenum, iron, and cobalt depending on the asset. Development and growth exposure "
            "includes the Santo Domingo project in Chile, Copper Cities in Arizona, and near-mine expansion "
            "and exploration work around the operating mines."
        ),
    },
    "GATO": {
        "source_url": "https://www.gatossilver.com/",
        "title": "Gatos Silver company overview",
        "summary": (
            "Gatos Silver, Inc. is listed in Minerlytics as a silver producer focused on the Los Gatos "
            "District in Chihuahua, Mexico. Its mined commodity exposure includes silver, zinc, lead, and "
            "gold from polymetallic ore associated with one primary producing operation, Cerro Los Gatos, "
            "with district-scale development and exploration targets around the mine."
        ),
    },
    "SVM": {
        "source_url": "https://silvercorpmetals.com/",
        "title": "Silvercorp Metals company overview",
        "summary": (
            "Silvercorp Metals Inc. is a silver, lead, zinc, and gold producer focused on China, with public "
            "website materials centered on the Ying Mining District and the GC Mine as producing assets. "
            "The company also describes development and exploration exposure through regional targets and "
            "new mine areas around its existing Chinese operating districts, with additional corporate "
            "exposure to the Ecuador-focused Adventus transaction pipeline."
        ),
    },
    "HMY": {
        "source_url": "https://www.harmony.co.za/",
        "title": "Harmony Gold company overview",
        "summary": (
            "Harmony Gold Mining Company Limited is a gold producer with public website-described operations "
            "in South Africa and Papua New Guinea. Its mined commodity exposure is primarily gold, with "
            "copper-gold development exposure through the Wafi-Golpu project in Papua New Guinea. The company "
            "presents a portfolio of South African underground and surface operations, the Hidden Valley mine "
            "in Papua New Guinea, and regional exploration or life-extension work around its operating districts."
        ),
    },
    "MAG": {
        "source_url": "https://magsilver.com/",
        "title": "MAG Silver company overview",
        "summary": (
            "MAG Silver Corp. is listed in Minerlytics as a silver developer whose principal asset was the "
            "Juanicipio silver, gold, lead, and zinc mine in Zacatecas, Mexico. The former MAG public "
            "website currently redirects to Pan American Silver, so this summary preserves the MAG company "
            "context and commodity exposure for the ticker record."
        ),
    },
    "FSM": {
        "source_url": "https://fortunamining.com/",
        "title": "Fortuna Mining company overview",
        "summary": (
            "Fortuna Mining Corp. is a precious metals producer in the Minerlytics universe with mined "
            "commodity exposure including gold, silver, lead, and zinc. The company operates a portfolio "
            "of gold and silver mines across Latin America and West Africa, including production from "
            "assets in Argentina, Mexico, Peru, Burkina Faso, and Cote d'Ivoire. Its public website also "
            "describes development and exploration work around operating mines and regional targets."
        ),
    },
    "PILBF": {
        "source_url": "https://pilbaraminerals.com.au/",
        "title": "Pilbara Minerals company overview",
        "summary": (
            "Pilbara Minerals Limited is a lithium producer in the Minerlytics universe focused on hard-rock "
            "lithium mining in Western Australia. Its principal commodity exposure is lithium through "
            "spodumene concentrate from one primary producing asset, the Pilgangoora operation, which "
            "supplies battery-materials value chains. Development and exploration exposure is concentrated "
            "on Pilgangoora expansions, downstream joint-venture work, and regional resource growth."
        ),
    },
    "TGB": {
        "source_url": "https://www.tasekomines.com/operations",
        "title": "Taseko Mines operations overview",
        "summary": (
            "Taseko Mines Limited is a North American copper producer and developer. Its public website "
            "describes one producing mine, Gibraltar in British Columbia, with copper and molybdenum "
            "production. The development portfolio includes Florence Copper in Arizona, Yellowhead in "
            "British Columbia, Aley niobium in British Columbia, and the New Prosperity copper-gold project. "
            "The company is geographically focused on Canada and the United States, with exploration and "
            "growth work around the development-stage project pipeline."
        ),
    },
    "ORLA": {
        "source_url": "https://orlamining.com/asset/",
        "title": "Orla Mining asset overview",
        "summary": (
            "Orla Mining Ltd. is a gold producer and developer. Its public website describes one primary "
            "producing asset, the Camino Rojo oxide operation in Zacatecas, Mexico, with gold and silver "
            "exposure. Development and growth assets include the South Railroad project in Nevada and the "
            "Cerro Quema project in Panama, with exploration programs around the operating and project "
            "districts in Mexico, the United States, and Panama."
        ),
    },
    "SQM": {
        "source_url": "https://sqm.com/en/business-lines/lithium/",
        "title": "SQM lithium business overview",
        "summary": (
            "Sociedad Quimica y Minera de Chile S.A. is a Chilean producer with commodity exposure to "
            "lithium, potassium, iodine, nitrates, and specialty plant nutrients. For Minerlytics, the "
            "mining-relevant exposure is lithium brine and potassium salts from the Salar de Atacama in "
            "northern Chile, supported by chemical processing and sales into battery and industrial markets. "
            "The public website presents producing brine and minerals businesses, with development and "
            "growth centered on lithium capacity, resource "
            "management, and processing expansion."
        ),
    },
    "MP": {
        "source_url": "https://mpmaterials.com/",
        "title": "MP Materials company overview",
        "summary": (
            "MP Materials Corp. is a rare earth producer in the Minerlytics universe centered on the Mountain "
            "Pass rare earth mine and processing operations in California. Its commodity exposure includes "
            "rare earth elements used in magnets and electrification supply chains, including neodymium and "
            "praseodymium products. The public site presents Mountain Pass as the primary producing mine, "
            "with development focused on downstream separation and magnetics capacity."
        ),
    },
    "ALB": {
        "source_url": "https://www.albemarle.com/",
        "title": "Albemarle company overview",
        "summary": (
            "Albemarle Corporation is a lithium-focused specialty materials company in the Minerlytics "
            "universe. Its public materials describe lithium resource and processing exposure rather than "
            "a simple mine-count portfolio: key geographic exposure includes brine operations in Chile, "
            "hard-rock spodumene supply in Western Australia, lithium conversion facilities, and U.S. growth "
            "projects such as Kings Mountain. The mined commodity exposure is primarily lithium, with "
            "development and exploration tied to resource expansions and battery-materials processing."
        ),
    },
    "LYSCF": {
        "source_url": "https://lynasrareearths.com/",
        "title": "Lynas Rare Earths company overview",
        "summary": (
            "Lynas Rare Earths Limited is a rare earths producer centered on the Mt Weld rare earth mine in "
            "Western Australia and downstream processing in Australia and Malaysia. Its mined commodity "
            "exposure is rare earth elements, especially neodymium and praseodymium used in permanent magnets. "
            "The public website presents one primary producing mine, Mt Weld, with development and growth "
            "projects around mine expansion, cracking and leaching, and separation capacity."
        ),
    },
    "SBSW": {
        "source_url": "https://www.sibanyestillwater.com/business/",
        "title": "Sibanye-Stillwater business overview",
        "summary": (
            "Sibanye-Stillwater Limited is a diversified precious-metals and battery-metals producer. Its "
            "public website describes producing platinum-group-metals operations in South Africa and the "
            "United States, gold operations in South Africa, and recycling or processing exposure in the "
            "United States and Europe. Mined commodity exposure includes PGMs, gold, nickel, copper, chrome, "
            "and battery-metals growth exposure such as lithium. Development and exploration work includes "
            "South African and U.S. PGM projects, gold life-extension work, and battery-metals projects such "
            "as Keliber in Finland."
        ),
    },
    "PSLV": {
        "source_url": "https://sprott.com/investment-strategies/physical-bullion-trusts/silver/",
        "title": "Sprott Physical Silver Trust overview",
        "summary": (
            "Sprott Physical Silver Trust is a silver bullion trust rather than an operating mining company. "
            "It provides exposure to physical silver and does not operate production, development, or "
            "exploration mines."
        ),
    },
    "SIL": {
        "source_url": "https://www.globalxetfs.com/funds/sil/",
        "title": "Global X Silver Miners ETF overview",
        "summary": (
            "Global X Silver Miners ETF is a fund-style silver miners vehicle in the Minerlytics universe. "
            "It does not operate mines directly; its commodity exposure is indirect, through equity holdings "
            "in silver mining and streaming companies with production, development, and exploration assets "
            "across multiple countries."
        ),
    },
    "SILJ": {
        "source_url": "https://amplifyetfs.com/silj/",
        "title": "Amplify Junior Silver Miners ETF overview",
        "summary": (
            "Amplify Junior Silver Miners ETF is a fund-style vehicle focused on smaller silver mining "
            "companies. It does not operate mines directly; its commodity exposure is indirect silver and "
            "precious-metals miner exposure through portfolio holdings with producing, development, and "
            "exploration assets."
        ),
    },
    "SIVR": {
        "source_url": "https://www.abrdn.com/en-us/investor/fund-centre/etf/sivr",
        "title": "abrdn Physical Silver Shares ETF overview",
        "summary": (
            "abrdn Physical Silver Shares ETF is a silver ETF in the Minerlytics universe. It provides "
            "investment exposure to physical silver bullion rather than operating mines, so its commodity "
            "exposure is silver and its company detail record is treated as a fund-style metals vehicle."
        ),
    },
    "SLV": {
        "source_url": "https://www.ishares.com/us/products/239855/ishares-silver-trust-fund",
        "title": "iShares Silver Trust overview",
        "summary": (
            "iShares Silver Trust is a silver bullion trust rather than an operating mining company. It "
            "provides investment exposure to physical silver and has no production, development, or "
            "exploration mines."
        ),
    },
    "GDX": {
        "source_url": "https://www.vaneck.com/us/en/investments/gold-miners-etf-gdx/",
        "title": "VanEck Gold Miners ETF overview",
        "summary": (
            "VanEck Gold Miners ETF is a gold miners ETF in the Minerlytics universe. It provides investment "
            "exposure to a portfolio of publicly traded gold mining companies rather than directly mining "
            "commodities, so its commodity exposure is gold through miner equities."
        ),
    },
    "GDXJ": {
        "source_url": "https://www.vaneck.com/us/en/investments/junior-gold-miners-etf-gdxj/",
        "title": "VanEck Junior Gold Miners ETF overview",
        "summary": (
            "VanEck Junior Gold Miners ETF is a junior gold miners ETF in the Minerlytics universe. It provides "
            "investment exposure to smaller gold and silver mining companies rather than directly operating "
            "mines, so its commodity exposure is primarily gold with related precious-metals miner exposure."
        ),
    },
    "COPX": {
        "source_url": "https://www.globalxetfs.com/funds/copx/",
        "title": "Global X Copper Miners ETF overview",
        "summary": (
            "Global X Copper Miners ETF is a fund-style copper miners vehicle. It does not operate mines "
            "directly; its commodity exposure is indirect, through companies involved in copper mining, "
            "development, and exploration across global copper districts."
        ),
    },
    "PICK": {
        "source_url": "https://www.ishares.com/us/products/239655/ishares-msci-global-metals-mining-producers-etf",
        "title": "iShares MSCI Global Metals & Mining Producers ETF overview",
        "summary": (
            "iShares MSCI Global Metals & Mining Producers ETF is a fund-style global mining equity vehicle. "
            "It does not mine commodities directly; its exposure is through producers of metals and minerals "
            "such as iron ore, copper, aluminum, steelmaking raw materials, and precious or battery metals."
        ),
    },
    "URNM": {
        "source_url": "https://sprottetfs.com/urnm/",
        "title": "Sprott Uranium Miners ETF overview",
        "summary": (
            "Sprott Uranium Miners ETF is a fund-style uranium miners vehicle. It does not operate mines "
            "directly; its commodity exposure is indirect, through uranium mining, development, exploration, "
            "and physical uranium-related holdings."
        ),
    },
}

PROFILE_CURATED_ONLY_SYMBOLS = {
    "ALB",
    "BHP",
    "CSFFF",
    "FQVLF",
    "GLNCY",
    "HMY",
    "IVPAF",
    "LYSCF",
    "ORLA",
    "PAAS",
    "PILBF",
    "SBSW",
    "SQM",
    "SVM",
    "TGB",
    "VALE",
}


@dataclass(frozen=True)
class Company:
    symbol: str
    company_name: str
    short_name: str
    metal: str
    company_type: str


@dataclass(frozen=True)
class Link:
    href: str
    text: str


@dataclass(frozen=True)
class AboutResult:
    homepage_url: str | None
    about_url: str | None
    about_title: str | None
    about_text: str
    extraction_method: str
    status: str
    error_message: str | None = None

    @property
    def text_length(self) -> int:
        return len(self.about_text)


@dataclass(frozen=True)
class EnrichedAboutResult:
    source_url: str
    page_title: str
    retrieved_at: str
    about_text: str
    evidence_text: str
    confidence: float
    extraction_layer: str
    raw_json: str = ""

    @property
    def text_length(self) -> int:
        return len(self.about_text)


@dataclass(frozen=True)
class ProfilePage:
    url: str
    title: str
    text: str
    links: list[Link]


@dataclass(frozen=True)
class AssetFinding:
    name: str
    stage: str
    location: str
    source_url: str
    evidence: str


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[Link] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attr = dict(attrs)
        href = attr.get("href")
        if href:
            self._href = href
            self._text = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href:
            text = clean_text(" ".join(self._text))
            self.links.append(Link(self._href, text))
            self._href = None
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._text.append(data)


class TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg", "button", "nav", "footer"}:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "br"} and not self._skip_depth:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg", "button", "nav", "footer"} and self._skip_depth:
            self._skip_depth -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = clean_text(data)
        if not text:
            return
        if self._in_title:
            self.title = clean_text(f"{self.title} {text}")
        else:
            self.parts.append(text)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate website-based company profile summaries for miner company websites and emit Cloudflare D1 SQL."
    )
    parser.add_argument("symbols", nargs="*", help="Optional ticker symbols to process")
    parser.add_argument("--tickers-js", default="src/tickers.js", help="Path to src/tickers.js miner universe")
    parser.add_argument("--homepages-json", help="JSON output from scripts/sync_company_homepages.py")
    parser.add_argument("--output-json", help="Optional JSON output path")
    parser.add_argument("--output-sql", help="Optional D1 SQL output path")
    parser.add_argument("--schema-sql", default="d1_website_about_us.sql", help="Schema SQL to prepend")
    parser.add_argument("--limit", type=int, help="Limit number of companies processed")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds to wait between companies")
    parser.add_argument("--timeout", type=float, default=5.0, help="HTTP timeout in seconds")
    parser.add_argument("--homepage-url", help="Override homepage URL for a single symbol run")
    parser.add_argument(
        "--mode",
        choices=["profile", "combined", "legacy", "resilient"],
        default="profile",
        help="Extraction strategy. profile crawls company/about/operations pages and generates a structured summary.",
    )
    parser.add_argument("--max-pages", type=int, default=8, help="Maximum public website pages to review per company")
    parser.add_argument("--min-confidence", type=float, default=0.55, help="Minimum confidence for resilient About text")
    parser.add_argument("--overwrite-table", action="store_true", help="Delete existing Website_about_Us rows before inserting this run")
    parser.add_argument("--parse-only", action="store_true", help="Only parse src/tickers.js and report companies")
    parser.add_argument("--dry-run", action="store_true", help="Print rows without writing output files")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="HTTP User-Agent")
    args = parser.parse_args()

    companies = load_ticker_universe(Path(args.tickers_js))
    if args.symbols:
        wanted = {symbol.strip().upper() for symbol in args.symbols}
        companies = [company for company in companies if company.symbol in wanted]
    if args.limit:
        companies = companies[: args.limit]
    if not companies:
        raise SystemExit("No companies matched the requested symbols.")
    if args.parse_only:
        print(f"Parsed {len(load_ticker_universe(Path(args.tickers_js)))} companies from {args.tickers_js}")
        for company in companies:
            print(json.dumps(company.__dict__, separators=(",", ":")))
        return 0

    homepages = load_homepages(Path(args.homepages_json)) if args.homepages_json else {}
    about_rows: list[dict[str, Any]] = []
    extraction_rows: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []

    for index, company in enumerate(companies):
        if index and args.delay > 0:
            time.sleep(args.delay)
        homepage_url = args.homepage_url if len(companies) == 1 and args.homepage_url else homepages.get(company.symbol)
        if not homepage_url:
            homepage_url = CURATED_HOMEPAGES.get(company.symbol)
        result = AboutResult(homepage_url, None, None, "", "not_run", "not_found", "Extractor not run")
        enriched: EnrichedAboutResult | None = None
        try:
            if args.mode == "profile":
                result, profile_extractions = generate_website_profile_result(
                    company,
                    homepage_url,
                    timeout=args.timeout,
                    user_agent=args.user_agent,
                    max_pages=args.max_pages,
                )
                extraction_rows.extend(
                    row_for_enriched_about(company, homepage_url, profile_extraction)
                    for profile_extraction in profile_extractions
                )
            if args.mode in {"combined", "legacy"}:
                result = extract_about_us(homepage_url, timeout=args.timeout, user_agent=args.user_agent)
            if result.status != "found" and company.symbol in CURATED_SUMMARY_OVERRIDES:
                result = curated_summary_result(company, homepage_url)
            if result.status != "found" and args.mode in {"combined", "resilient"}:
                enriched = extract_about_us_resilient(
                    homepage_url,
                    timeout=args.timeout,
                    user_agent=args.user_agent,
                    min_confidence=args.min_confidence,
                )
                if enriched:
                    result = AboutResult(
                        homepage_url,
                        enriched.source_url,
                        enriched.page_title,
                        enriched.about_text,
                        f"resilient_{enriched.extraction_layer}",
                        "found",
                    )
            if result.status != "found":
                fallback = generate_ai_about_summary(
                    company,
                    homepage_url,
                    timeout=args.timeout,
                    user_agent=args.user_agent,
                    previous_error=result.error_message,
                )
                if fallback:
                    result = fallback
            about_rows.append(row_for_about_result(company, result))
            if enriched:
                extraction_rows.append(row_for_enriched_about(company, homepage_url, enriched))
        except Exception as exc:
            result = AboutResult(homepage_url, None, None, "", "extractor_error", "failed", str(exc))
            about_rows.append(row_for_about_result(company, result))

        status = {
            "symbol": company.symbol,
            "status": result.status,
            "about_url": result.about_url or "",
            "text_length": result.text_length,
            "extraction_method": result.extraction_method,
            "error_message": result.error_message or "",
        }
        statuses.append(status)
        print(json.dumps(status, separators=(",", ":")), flush=True)

    if not args.dry_run:
        if args.output_json:
            write_json(
                Path(args.output_json),
                {
                    "statuses": statuses,
                    "about_rows": about_rows,
                    "extractions": extraction_rows,
                },
            )
        if args.output_sql:
            write_d1_sql(
                Path(args.output_sql),
                about_rows,
                extraction_rows,
                schema_path=Path(args.schema_sql),
                overwrite_table=args.overwrite_table,
            )
    print(
        "Processed "
        f"{len(companies)} companies; found {sum(1 for row in about_rows if row['status'] == 'found')} About Us rows"
    )
    return 0


def load_ticker_universe(path: Path) -> list[Company]:
    source = path.read_text(encoding="utf-8")
    body_match = re.search(r"export\s+const\s+TICKERS\s*=\s*\{(?P<body>.*)\}\s*;?\s*$", source, re.S)
    if not body_match:
        raise ValueError(f"Could not find exported TICKERS object in {path}")
    companies: list[Company] = []
    for symbol, block in iter_ticker_blocks(body_match.group("body")):
        companies.append(
            Company(
                symbol=symbol,
                company_name=string_property(block, "company") or string_property(block, "name") or symbol,
                short_name=string_property(block, "name") or symbol,
                metal=string_property(block, "metal") or "",
                company_type=string_property(block, "type") or "",
            )
        )
    return companies


def iter_ticker_blocks(body: str) -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    index = 0
    while True:
        match = re.search(r"([A-Z0-9]+):\s*\{", body[index:])
        if not match:
            return blocks
        symbol = match.group(1)
        start = index + match.end()
        depth = 1
        cursor = start
        quote: str | None = None
        escape = False
        while cursor < len(body):
            char = body[cursor]
            if quote:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == quote:
                    quote = None
            elif char in {"'", '"'}:
                quote = char
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    blocks.append((symbol, body[start:cursor]))
                    index = cursor + 1
                    break
            cursor += 1
        else:
            raise ValueError(f"Unclosed ticker block for {symbol}")


def string_property(block: str, name: str) -> str | None:
    match = re.search(rf"\b{name}\s*:\s*(['\"])(.*?)\1", block, re.S)
    if not match:
        return None
    return bytes(match.group(2), "utf-8").decode("unicode_escape")


def load_homepages(path: Path) -> dict[str, str]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(rows, dict) and "items" in rows:
        rows = rows["items"]
    if isinstance(rows, dict) and "profiles" in rows:
        rows = rows["profiles"]
    return {
        str(row.get("symbol", "")).upper(): row["homepage_url"]
        for row in rows
        if row.get("symbol") and row.get("homepage_url") and row.get("status") == "found"
    }


def extract_about_us(homepage_url: str | None, *, timeout: float, user_agent: str) -> AboutResult:
    if not homepage_url:
        return AboutResult(None, None, None, "", "homepage_missing", "not_found", "No homepage URL available")
    try:
        homepage_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
        about_url = find_about_url(homepage_html, homepage_url)
        if not about_url:
            about_text, title = extract_text(homepage_html)
            fallback = extract_homepage_overview(about_text)
            if fallback:
                return AboutResult(homepage_url, homepage_url, title, fallback, "homepage_overview_fallback", "found")
            return AboutResult(homepage_url, None, None, "", "about_link_search", "not_found", "No About link found")

        about_html = fetch_html(about_url, timeout=timeout, user_agent=user_agent)
        about_text, title = extract_text(about_html)
        about_text = trim_about_text(about_text)
        if not about_text:
            return AboutResult(homepage_url, about_url, title, "", "about_page_text", "not_found", "About page had no extractable text")
        return AboutResult(homepage_url, about_url, title, about_text, "about_page_text", "found")
    except Exception as exc:
        return AboutResult(homepage_url, None, None, "", "http_fetch", "failed", str(exc))


def ensure_resilient_about_schema(db: Any) -> None:
    db.executescript(
        """
        create table if not exists Website_about_Us_Extractions (
            id integer primary key autoincrement,
            symbol text not null references mining_companies(symbol),
            company_name text not null,
            homepage_url text,
            source_url text not null,
            page_title text not null default '',
            retrieved_at text not null,
            about_text text not null default '',
            text_length integer not null default 0,
            evidence_text text not null default '',
            confidence real not null,
            extraction_layer text not null,
            raw_json text not null default '',
            status text not null default 'found' check (status in ('found', 'not_found', 'failed')),
            error_message text,
            created_at text not null,
            updated_at text not null,
            unique(symbol, source_url, extraction_layer)
        );

        create index if not exists idx_website_about_us_extractions_symbol
            on Website_about_Us_Extractions(symbol, confidence);
        """
    )


def extract_about_us_resilient(
    homepage_url: str | None,
    *,
    timeout: float,
    user_agent: str,
    min_confidence: float,
) -> EnrichedAboutResult | None:
    if not homepage_url:
        return None
    errors: list[str] = []
    for url in resilient_about_urls(homepage_url, timeout=timeout, user_agent=user_agent):
        try:
            page_html = fetch_html(url, timeout=timeout, user_agent=user_agent)
        except Exception as exc:
            errors.append(f"{url}: {exc}")
            continue
        candidates = extract_resilient_about_candidates(page_html, url)
        candidates = [candidate for candidate in candidates if candidate.confidence >= min_confidence]
        if candidates:
            return sorted(candidates, key=about_quality, reverse=True)[0]
    return None


def curated_summary_result(company: Company, homepage_url: str | None) -> AboutResult:
    override = CURATED_SUMMARY_OVERRIDES[company.symbol]
    source_url = override.get("source_url") or homepage_url
    return AboutResult(
        homepage_url,
        source_url,
        override.get("title") or f"{company.company_name} company overview",
        trim_about_text(override.get("summary") or ""),
        "curated_ai_summary",
        "found",
    )


def generate_website_profile_result(
    company: Company,
    homepage_url: str | None,
    *,
    timeout: float,
    user_agent: str,
    max_pages: int,
) -> tuple[AboutResult, list[EnrichedAboutResult]]:
    normalized_type = company.company_type.lower()
    if company.symbol in CURATED_SUMMARY_OVERRIDES and (
        company.symbol in PROFILE_CURATED_ONLY_SYMBOLS or normalized_type in {"fund", "etf", "trust"}
    ):
        return curated_summary_result(company, homepage_url), []
    if not homepage_url:
        return (
            AboutResult(None, None, None, "", "ai_website_profile_summary", "not_found", "No homepage URL available"),
            [],
        )
    if normalized_type in {"fund", "etf", "trust"}:
        max_pages = min(max_pages, 4)

    pages, errors = crawl_company_profile_pages(
        company,
        homepage_url,
        timeout=timeout,
        user_agent=user_agent,
        max_pages=max(3, max_pages),
    )
    if not pages and company.symbol in CURATED_SUMMARY_OVERRIDES:
        return curated_summary_result(company, homepage_url), []
    if not pages:
        return (
            AboutResult(
                homepage_url,
                None,
                None,
                "",
                "ai_website_profile_summary",
                "failed",
                "; ".join(errors[:4]) or "No public website pages could be retrieved",
            ),
            [],
        )

    assets = extract_asset_findings(company, pages)
    summary = build_website_profile_summary(company, pages, assets, errors)
    if not summary:
        return (
            AboutResult(
                homepage_url,
                pages[0].url,
                pages[0].title,
                "",
                "ai_website_profile_summary",
                "not_found",
                "Website pages were retrieved, but no useful company profile summary could be generated",
            ),
            profile_page_extractions(pages, homepage_url),
        )

    source_page = best_profile_source_page(pages)
    return (
        AboutResult(
            homepage_url,
            source_page.url,
            source_page.title,
            summary,
            "ai_website_profile_summary",
            "found",
        ),
        profile_page_extractions(pages, homepage_url),
    )


def crawl_company_profile_pages(
    company: Company,
    homepage_url: str,
    *,
    timeout: float,
    user_agent: str,
    max_pages: int,
) -> tuple[list[ProfilePage], list[str]]:
    pages: list[ProfilePage] = []
    errors: list[str] = []
    visited: set[str] = set()
    queue: list[str] = [normalize_url(homepage_url)]

    def enqueue(url: str | None, *, priority: bool = False) -> None:
        if not url:
            return
        normalized = normalize_url(url)
        if normalized in visited or normalized in queue:
            return
        if not same_site(homepage_url, normalized) or unwanted_profile_url(normalized):
            return
        if priority:
            queue.insert(0, normalized)
        else:
            queue.append(normalized)

    known_paths = (
        LOCAL_KNOWN_PROFILE_PATHS.get(company.symbol, [])
        + PROJECT_KNOWN_PROJECT_PATHS.get(company.symbol, [])
        + PROJECT_KNOWN_LANDING_PATHS.get(company.symbol, [])
    )
    for path in reversed(known_paths):
        enqueue(url_for_path(homepage_url, path), priority=True)

    for path in COMMON_PROFILE_PATHS:
        enqueue(url_for_path(homepage_url, path))

    attempts = 0
    while queue and len(pages) < max_pages and attempts < max_pages * 4:
        url = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        attempts += 1
        try:
            page_html = fetch_html(url, timeout=timeout, user_agent=user_agent)
        except Exception as exc:
            errors.append(f"{url}: {exc}")
            continue

        text, title = extract_text(page_html)
        links = links_from_html(page_html)
        if len(text) >= 80:
            pages.append(ProfilePage(url=url, title=title or "", text=text, links=links))

        scored_links = sorted(
            (
                (score_profile_link(link, urllib.parse.urljoin(url, link.href)), urllib.parse.urljoin(url, link.href))
                for link in links
            ),
            key=lambda item: item[0],
            reverse=True,
        )
        for score, link_url in reversed(scored_links[:18]):
            if score > 0:
                enqueue(link_url, priority=True)

    return dedupe_profile_pages(pages), errors


def links_from_html(page_html: str) -> list[Link]:
    parser = LinkParser()
    parser.feed(page_html)
    return parser.links


def url_for_path(base_url: str, path: str) -> str:
    parsed = urllib.parse.urlparse(base_url)
    base = f"{parsed.scheme or 'https'}://{parsed.netloc}"
    return urllib.parse.urljoin(base, path)


def same_site(base_url: str, candidate_url: str) -> bool:
    return domain(base_url) == domain(candidate_url)


def unwanted_profile_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lower()
    if not parsed.scheme.startswith("http"):
        return True
    if re.search(r"\.(?:pdf|jpg|jpeg|png|gif|svg|webp|zip|doc|docx|xls|xlsx|ppt|pptx)$", path):
        return True
    return any(term in path for term in PROFILE_NEGATIVE_URL_TERMS)


def score_profile_link(link: Link, url: str) -> int:
    haystack = f"{link.text} {urllib.parse.urlparse(url).path}".lower().replace("-", " ")
    score = 0
    for term in PROFILE_LINK_TERMS:
        if term in haystack:
            if term in {"operations", "assets", "projects", "portfolio", "mines", "where we operate"}:
                score += 7
            elif term in {"mine", "project", "properties", "property", "development", "exploration"}:
                score += 5
            else:
                score += 1
    if re.search(r"\b(?:mine|project|property|operation|deposit|complex|district)\b", link.text, re.I):
        score += 5
    if branded_asset_link_text(link.text):
        score += 4
    if any(term in haystack for term in PROFILE_NEGATIVE_URL_TERMS):
        score -= 10
    return max(score, 0)


def branded_asset_link_text(text: str) -> bool:
    text = clean_text(text)
    if not 3 <= len(text) <= 70:
        return False
    lowered = text.lower()
    if generic_asset_name(text, Company("", "", "", "", "")):
        return False
    if any(term in lowered for term in ["board", "career", "contact", "document", "leadership", "news", "privacy", "report"]):
        return False
    words = text.split()
    if not 1 <= len(words) <= 5:
        return False
    return sum(1 for word in words if word[:1].isupper()) >= 1


def dedupe_profile_pages(pages: list[ProfilePage]) -> list[ProfilePage]:
    best: dict[str, ProfilePage] = {}
    for page in pages:
        key = normalize_url(page.url)
        existing = best.get(key)
        if not existing or len(page.text) > len(existing.text):
            best[key] = page
    return sorted(best.values(), key=profile_page_priority)


def profile_page_priority(page: ProfilePage) -> tuple[int, int]:
    haystack = f"{page.title} {page.url}".lower().replace("-", " ")
    score = 0
    if "about" in haystack or "who we are" in haystack:
        score -= 20
    if any(term in haystack for term in ["operations", "assets", "projects", "portfolio", "mine", "where we operate"]):
        score -= 15
    return score, -len(page.text)


def best_profile_source_page(pages: list[ProfilePage]) -> ProfilePage:
    return sorted(pages, key=profile_page_priority)[0]


def extract_asset_findings(company: Company, pages: list[ProfilePage]) -> list[AssetFinding]:
    findings: list[AssetFinding] = []
    for page in pages:
        if likely_asset_page(page):
            name = infer_asset_name(page, company)
            if name:
                findings.append(
                    AssetFinding(
                        name=name,
                        stage=classify_asset_stage(f"{page.title} {page.url} {page.text}", company.company_type),
                        location=extract_location_phrase(page.text),
                        source_url=page.url,
                        evidence=asset_evidence(page.text),
                    )
                )
            continue
    return dedupe_asset_findings(findings)


def likely_asset_page(page: ProfilePage) -> bool:
    parsed = urllib.parse.urlparse(page.url)
    path = parsed.path.lower().replace("-", " ")
    title = page.title.lower().replace("-", " ")
    body_hint = page.text[:1400].lower()
    haystack = f"{title} {path} {body_hint}"
    if any(
        term in haystack
        for term in [
            "about mining",
            "about us",
            "award",
            "board",
            "business model",
            "document library",
            "leadership",
            "life cycle",
            "person details",
            "what we mine",
        ]
    ):
        return False
    candidate_name = asset_name_from_url_path(page.url)
    if not candidate_name:
        return False
    if re.search(r"\b(?:mine|project|complex|operation|property|deposit|plant|district|facility)\b", candidate_name, re.I):
        return True
    if re.search(r"/(?:operations|operating|mines|projects|properties|assets|portfolio|where-we-operate)/[^/]+", parsed.path, re.I):
        return True
    return bool(re.search(r"\b(?:mine|project|operation|property|deposit|processing facility|production facility)\b", body_hint, re.I))


def asset_name_from_url_path(url: str) -> str:
    parts = [part for part in urllib.parse.urlparse(url).path.strip("/").split("/") if part]
    for part in reversed(parts):
        name = clean_asset_name(part.replace("-", " ").replace("_", " "))
        if name and not generic_asset_name(name, Company("", "", "", "", "")):
            return name
    return ""


def infer_asset_name(page: ProfilePage, company: Company) -> str:
    title = clean_asset_name(page.title.split("|")[0].split(" - ")[0])
    if title and not generic_asset_name(title, company):
        return title
    name = asset_name_from_url_path(page.url)
    if name:
        return name
    match = ASSET_NAME_RE.search(page.text)
    if match:
        name = clean_asset_name(match.group(1))
        if name and not generic_asset_name(name, company):
            return name
    return ""


def asset_findings_from_text(company: Company, page: ProfilePage) -> list[AssetFinding]:
    results: list[AssetFinding] = []
    sentences = split_sentences(page.text)
    for sentence in sentences:
        for match in ASSET_NAME_RE.finditer(sentence):
            name = clean_asset_name(match.group(1))
            if not name or generic_asset_name(name, company):
                continue
            results.append(
                AssetFinding(
                    name=name,
                    stage=classify_asset_stage(sentence, company.company_type),
                    location=extract_location_phrase(sentence) or extract_location_phrase(page.text),
                    source_url=page.url,
                    evidence=clean_summary_sentence(sentence) or asset_evidence(page.text),
                )
            )
    return results


def clean_asset_name(value: str) -> str:
    cleaned = clean_text(value)
    cleaned = re.sub(r"^skip to main content\s+", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\.(?:aspx|html?|php)$", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\b(?:overview|operations|portfolio|projects|properties|assets|homepage|home)\b$", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -|:.,")
    if len(cleaned) > 120:
        cleaned = cleaned[:120].rsplit(" ", 1)[0]
    if cleaned and cleaned == cleaned.lower():
        cleaned = cleaned.title()
    return cleaned


def generic_asset_name(value: str, company: Company) -> bool:
    lowered = clean_text(value).lower()
    company_terms = {
        company.symbol.lower(),
        company.company_name.lower(),
        company.short_name.lower(),
        "about",
        "asset",
        "assets",
        "company",
        "community",
        "community feedback",
        "default",
        "default.aspx",
        "esg s",
        "exploration",
        "facilities",
        "home",
        "index",
        "index.html",
        "legal",
        "magnetics",
        "materials",
        "mine",
        "mines",
        "operation",
        "operations",
        "our assets",
        "overview",
        "portfolio",
        "project",
        "projects",
        "properties",
        "property",
        "suppliers",
        "vendors",
        "what we mine",
        "where we operate",
    }
    if lowered in company_terms:
        return True
    if any(term in lowered for term in ["africa and canada", "asia pacific", "latin america", "north america"]):
        return True
    if re.match(r"^(?:located|location|for details|the company|the project|this project|this mine|learn more)\b", lowered):
        return True
    if len(lowered.split()) > 9:
        return True
    return bool(re.search(r"\b(?:404|error|privacy|contact|news|investors|careers|sustainability)\b", lowered))


def classify_asset_stage(text: str, company_type: str) -> str:
    lowered = text.lower()
    lowered_type = company_type.lower()
    if "develop" in lowered_type and re.search(
        r"\b(?:mechanical completion|targeted for|construction|project financing|phase 1|feasibility|permitting)\b",
        lowered,
    ):
        return "development"
    scores = {
        "production": sum(
            lowered.count(term)
            for term in ["production", "producing", "operating mine", "operating mines", "operation", "operations", "commercial production", "active mine", "in operation"]
        ),
        "development": sum(
            lowered.count(term)
            for term in ["development", "construction", "permitting", "feasibility", "pre-feasibility", "prefeasibility", "pea", "restart", "refurbishment"]
        ),
        "exploration": sum(
            lowered.count(term)
            for term in ["exploration", "exploratory", "drilling", "discovery", "prospect", "greenfield", "brownfield"]
        ),
    }
    if re.search(r"\b(?:open pit|underground|heap leach|mill|processing plant)\b", lowered):
        scores["production"] += 1
    if "develop" in lowered_type and not re.search(r"\b(?:commercial production|operating mine|currently producing|producing mine)\b", lowered):
        if "project" in lowered or scores["development"] or "mineral resources" in lowered:
            return "development"
    best_stage, best_score = max(scores.items(), key=lambda item: item[1])
    if best_score:
        return best_stage
    if "explor" in lowered_type:
        return "exploration"
    if "develop" in lowered_type:
        return "development"
    if "producer" in lowered_type:
        return "production"
    return "unknown"


def extract_location_phrase(text: str) -> str:
    sentence_matches = [
        clean_summary_sentence(sentence)
        for sentence in split_sentences(text)
        if any(re.search(rf"\b{re.escape(location)}\b", sentence, re.I) for location in LOCATION_NAMES)
    ]
    if sentence_matches:
        return trim_text(sentence_matches[0], 220)
    locations = extract_locations_from_text(text)
    return human_join(locations[:4])


def extract_locations_from_text(text: str) -> list[str]:
    found: list[str] = []
    for location in LOCATION_NAMES:
        if re.search(rf"\b{re.escape(location)}\b", text, re.I):
            found.append(location)
    aliases = {"DRC": "Democratic Republic of Congo"}
    normalized = [aliases.get(location, location) for location in found]
    return list(dict.fromkeys(normalized))


def asset_evidence(text: str) -> str:
    sentences = [
        clean_summary_sentence(sentence)
        for sentence in split_sentences(text)
        if re.search(r"\b(?:mine|project|operation|property|deposit|production|development|exploration|located)\b", sentence, re.I)
    ]
    sentences = [sentence for sentence in sentences if sentence]
    return trim_text(" ".join(sentences[:3]), 700)


def dedupe_asset_findings(findings: list[AssetFinding]) -> list[AssetFinding]:
    best: dict[str, AssetFinding] = {}
    stage_rank = {"production": 4, "development": 3, "exploration": 2, "unknown": 1}
    for finding in findings:
        key = normalize_asset_key(finding.name)
        if not key or len(key) < 3:
            continue
        current = best.get(key)
        if not current:
            best[key] = finding
            continue
        current_score = stage_rank.get(current.stage, 0) + bool(current.location) + len(current.evidence) / 1000
        next_score = stage_rank.get(finding.stage, 0) + bool(finding.location) + len(finding.evidence) / 1000
        if next_score > current_score:
            best[key] = finding
    return sorted(best.values(), key=lambda item: (item.stage, item.name.lower()))


def normalize_asset_key(value: str) -> str:
    key = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    key = re.sub(r"\b(?:mine|mines|project|complex|operation|operations|property|district|deposit|plant)\b$", "", key).strip()
    return key


def build_website_profile_summary(
    company: Company,
    pages: list[ProfilePage],
    assets: list[AssetFinding],
    errors: list[str],
) -> str:
    combined_text = "\n".join(page.text for page in pages)
    commodities = detect_commodities(combined_text, company.metal)
    commodity_phrase = human_join(commodities) if commodities else commodity_label(company.metal) or "mining commodities"
    company_type = format_label(company.company_type or "mining company")
    normalized_type = company.company_type.lower()
    is_fund = normalized_type in {"fund", "etf", "trust"} or (
        normalized_type not in {"producer", "developer", "explorer", "royalty", "streaming"}
        and re.search(r"\b(?:exchange traded fund|etf|physical bullion)\b", combined_text, re.I)
    )
    is_royalty = normalized_type in {"royalty", "streaming"}
    lead = (
        f"{company.company_name} is a {company_type} with public website-described commodity exposure "
        f"including {commodity_phrase}."
    )
    if is_fund:
        mine_sentence = (
            "It is an investment vehicle rather than a mine operator, so the website presents metals exposure through holdings "
            "or bullion instead of operated production, development, or exploration assets."
        )
    elif is_royalty:
        mine_sentence = (
            "The website presents royalty or streaming portfolio exposure rather than mines directly operated by the company."
        )
    else:
        mine_sentence = (
            "The website presents the company through its operating assets, development projects, and exploration or growth "
            "pipeline."
        )

    locations = locations_for_summary(combined_text, assets)
    location_sentence = (
        f"Geographic exposure includes {human_join(locations[:8])}."
        if locations
        else "The public website content reviewed did not provide a clean geographic footprint."
    )

    asset_sentence = asset_sentence_for_summary(assets)
    evidence = select_summary_evidence(combined_text, company)
    evidence_sentence = " ".join(evidence[:2])

    parts = [lead, mine_sentence, location_sentence]
    if asset_sentence:
        parts.append(asset_sentence)
    if evidence_sentence:
        parts.append(evidence_sentence)
    return trim_text(" ".join(parts), 2400)


def count_assets_by_stage(assets: list[AssetFinding]) -> dict[str, int]:
    return {
        "production": sum(1 for asset in assets if asset.stage == "production"),
        "development": sum(1 for asset in assets if asset.stage == "development"),
        "exploration": sum(1 for asset in assets if asset.stage == "exploration"),
    }


def locations_for_summary(combined_text: str, assets: list[AssetFinding]) -> list[str]:
    asset_locations: list[str] = []
    for asset in assets:
        asset_locations.extend(extract_locations_from_text(asset.location or asset.evidence))
    return list(dict.fromkeys(asset_locations + extract_locations_from_text(combined_text)))


def asset_sentence_for_summary(assets: list[AssetFinding]) -> str:
    if not assets:
        return "The available website pages describe the portfolio at a high level rather than cleanly naming each asset."
    pieces: list[str] = []
    for stage in ["production", "development", "exploration", "unknown"]:
        names = [asset.name for asset in assets if asset.stage == stage]
        if names:
            if stage == "production":
                label = "operating or producing assets such as"
            elif stage == "development":
                label = "development-stage projects such as"
            elif stage == "exploration":
                label = "exploration properties or districts such as"
            else:
                label = "other named assets such as"
            suffix = " among others" if len(names) > 8 else ""
            pieces.append(f"{label} {human_join(names[:8])}{suffix}")
    return "Website-listed portfolio examples include " + "; ".join(pieces[:4]) + "."


def profile_page_extractions(pages: list[ProfilePage], homepage_url: str | None) -> list[EnrichedAboutResult]:
    retrieved_at = datetime.now(UTC).isoformat()
    results: list[EnrichedAboutResult] = []
    for page in pages[:12]:
        text = trim_text(page.text, 3500)
        if not text:
            continue
        results.append(
            EnrichedAboutResult(
                source_url=page.url,
                page_title=page.title or "",
                retrieved_at=retrieved_at,
                about_text=text,
                evidence_text=trim_text(text, 1800),
                confidence=0.78,
                extraction_layer="website_profile_page",
                raw_json=json.dumps({"homepage_url": homepage_url, "source_url": page.url, "title": page.title}, sort_keys=True),
            )
        )
    return results


def generate_ai_about_summary(
    company: Company,
    homepage_url: str | None,
    *,
    timeout: float,
    user_agent: str,
    previous_error: str | None = None,
) -> AboutResult | None:
    if company.symbol in CURATED_SUMMARY_OVERRIDES:
        return curated_summary_result(company, homepage_url)
    if not homepage_url:
        return None
    try:
        homepage_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
        homepage_text, title = extract_text(homepage_html)
    except Exception as exc:
        error = f"AI summary fallback fetch failed: {exc}"
        if previous_error:
            error = f"{previous_error}; {error}"
        return AboutResult(homepage_url, None, None, "", "ai_homepage_summary", "failed", error)

    summary = build_generated_company_summary(company, homepage_text)
    if not summary:
        return None
    return AboutResult(homepage_url, homepage_url, title, summary, "ai_homepage_summary", "found")


def build_generated_company_summary(company: Company, website_text: str) -> str:
    commodities = detect_commodities(website_text, company.metal)
    commodity_phrase = human_join(commodities) if commodities else commodity_label(company.metal)
    company_type = format_label(company.company_type or "mining company")
    text_lower = website_text.lower()
    is_fund = company.company_type.lower() in {"fund", "etf"} or any(term in text_lower for term in ["exchange traded fund", "etf", "trust"])

    if is_fund:
        lead = (
            f"{company.company_name} is a {company_type} in the Minerlytics universe with commodity exposure "
            f"focused on {commodity_phrase}."
        )
    else:
        lead = (
            f"{company.company_name} is a {company_type} in the Minerlytics universe with mined or mineral "
            f"commodity exposure that includes {commodity_phrase}."
        )

    evidence = select_summary_evidence(website_text, company)
    if evidence:
        detail = " ".join(evidence)
    else:
        detail = (
            f"The public website was reachable, but it did not expose a clean About Us section during extraction. "
            f"This generated summary uses the reachable website text and Minerlytics ticker metadata for {company.short_name}."
        )
    return trim_about_text(f"{lead} {detail}")


def detect_commodities(text: str, default_metal: str) -> list[str]:
    lowered = text.lower()
    found: list[str] = []
    for label, pattern in COMMODITY_PATTERNS:
        if re.search(pattern, lowered, flags=re.I):
            found.append(label)

    default_label = commodity_label(default_metal)
    if default_label and default_label not in {"mining", "unknown", "diversified"}:
        found.insert(0, default_label)
    if default_label == "diversified" and not found:
        found.append("diversified metals and mining")
    return list(dict.fromkeys(found))


def commodity_label(value: str) -> str:
    label = format_label(value or "").strip().lower()
    aliases = {
        "pgm": "platinum group metals",
        "rare earth": "rare earths",
        "rare-earth": "rare earths",
        "diamond": "diamonds",
    }
    return aliases.get(label, label)


def format_label(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("_", " ").replace("-", " ")).strip()


def human_join(items: list[str]) -> str:
    items = [item for item in items if item]
    if not items:
        return "mining commodities"
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + f", and {items[-1]}"


def select_summary_evidence(text: str, company: Company) -> list[str]:
    sentences = split_sentences(remove_boilerplate(text))
    if not sentences:
        return []

    company_terms = [
        company.company_name.lower(),
        company.short_name.lower(),
        company.symbol.lower(),
    ]
    scored: list[tuple[int, int, str]] = []
    for index, sentence in enumerate(sentences):
        cleaned = clean_summary_sentence(sentence)
        if not cleaned:
            continue
        lowered = cleaned.lower()
        score = 0
        if any(term and term in lowered for term in company_terms):
            score += 3
        score += sum(1 for term in SUMMARY_CONTEXT_TERMS if term in lowered)
        score += sum(1 for _, pattern in COMMODITY_PATTERNS if re.search(pattern, lowered, flags=re.I))
        if score:
            scored.append((score, index, cleaned))

    if not scored:
        return first_meaningful_sentences(sentences, 2)

    best = sorted(scored, key=lambda item: (-item[0], item[1]))[:3]
    return [sentence for _, _, sentence in sorted(best, key=lambda item: item[1])]


def split_sentences(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text or "").strip()
    if not normalized:
        return []
    return re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", normalized)


def clean_summary_sentence(sentence: str) -> str:
    sentence = clean_text(sentence)
    if len(sentence) < 35 or len(sentence) > 420:
        return ""
    lowered = sentence.lower()
    if any(
        marker in lowered
        for marker in [
            "cookie",
            "privacy policy",
            "terms of use",
            "skip to",
            "subscribe",
            "sign up",
            "all rights reserved",
            "for details",
            "opens in new tab",
        ]
    ):
        return ""
    return sentence


def first_meaningful_sentences(sentences: list[str], limit: int) -> list[str]:
    results: list[str] = []
    for sentence in sentences:
        cleaned = clean_summary_sentence(sentence)
        if not cleaned:
            continue
        results.append(cleaned)
        if len(results) >= limit:
            break
    return results


def resilient_about_urls(homepage_url: str, *, timeout: float, user_agent: str) -> list[str]:
    urls: list[str] = []
    try:
        homepage_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
        about_url = find_about_url(homepage_html, homepage_url)
        if about_url:
            urls.append(about_url)
    except Exception:
        pass
    urls.append(normalize_url(homepage_url))
    parsed = urllib.parse.urlparse(homepage_url)
    base_url = f"{parsed.scheme or 'https'}://{parsed.netloc}"
    for path in GENERATED_ABOUT_PATHS:
        urls.append(normalize_url(urllib.parse.urljoin(base_url, path)))
    return list(dict.fromkeys(url for url in urls if url))


def extract_resilient_about_candidates(page_html: str, source_url: str) -> list[EnrichedAboutResult]:
    retrieved_at = datetime.now(UTC).isoformat()
    page_text, page_title = extract_text(page_html)
    candidates: list[EnrichedAboutResult] = []
    candidates.extend(extract_structured_about(page_html, source_url, page_title or "", retrieved_at))
    candidates.extend(extract_semantic_about(page_html, source_url, page_title or "", retrieved_at))
    context = extract_context_about(page_text)
    if context:
        candidates.append(
            make_enriched_about(
                source_url=source_url,
                page_title=page_title or "",
                retrieved_at=retrieved_at,
                about_text=context,
                evidence_text=context[:1800],
                extraction_layer="context_window",
            )
        )
    return [candidate for candidate in candidates if candidate]


def extract_structured_about(
    page_html: str,
    source_url: str,
    page_title: str,
    retrieved_at: str,
) -> list[EnrichedAboutResult]:
    results: list[EnrichedAboutResult] = []
    for script_text in re.findall(r"<script\b[^>]*>(?P<value>.*?)</script>", page_html, flags=re.I | re.S):
        for item in json_objects(script_text):
            for organization in walk_organization_objects(item):
                description = clean_text(
                    str(
                        organization.get("description")
                        or organization.get("about")
                        or organization.get("slogan")
                        or organization.get("disambiguatingDescription")
                        or ""
                    )
                )
                if not description:
                    continue
                raw = json.dumps(organization, ensure_ascii=False, sort_keys=True)
                results.append(
                    make_enriched_about(
                        source_url=source_url,
                        page_title=page_title,
                        retrieved_at=retrieved_at,
                        about_text=trim_about_text(description),
                        evidence_text=description,
                        extraction_layer="structured_data",
                        raw_json=raw,
                    )
                )
    return [result for result in results if result]


def json_objects(content: str) -> list[Any]:
    content = html.unescape(content.strip())
    if not content:
        return []
    objects: list[Any] = []
    try:
        objects.append(json.loads(content))
    except Exception:
        for match in re.finditer(r"({[^{}]{30,6000}})", content, flags=re.S):
            try:
                objects.append(json.loads(match.group(1)))
            except Exception:
                continue
    return objects


def walk_organization_objects(value: Any) -> list[dict[str, Any]]:
    organizations: list[dict[str, Any]] = []
    if isinstance(value, dict):
        value_type = value.get("@type") or value.get("type") or ""
        if isinstance(value_type, list):
            value_type = " ".join(str(part) for part in value_type)
        lowered_type = str(value_type).lower()
        if any(term in lowered_type for term in ["organization", "corporation", "localbusiness"]) or (
            "name" in value and any(key in value for key in ["description", "about", "slogan"])
        ):
            organizations.append(value)
        for nested in value.values():
            organizations.extend(walk_organization_objects(nested))
    elif isinstance(value, list):
        for item in value:
            organizations.extend(walk_organization_objects(item))
    return organizations


def extract_semantic_about(
    page_html: str,
    source_url: str,
    page_title: str,
    retrieved_at: str,
) -> list[EnrichedAboutResult]:
    results: list[EnrichedAboutResult] = []
    for block in about_blocks(page_html):
        text = trim_about_text(html_to_text(block))
        if len(text) < 180:
            continue
        results.append(
            make_enriched_about(
                source_url=source_url,
                page_title=page_title,
                retrieved_at=retrieved_at,
                about_text=text,
                evidence_text=text[:1800],
                extraction_layer="semantic_html",
            )
        )
    return [result for result in results if result]


def about_blocks(page_html: str) -> list[str]:
    blocks: list[str] = []
    for pattern in [
        r'<(?P<tag>section|article|div)\b(?P<attrs>[^>]*)class="[^"]*(?:about|overview|profile|company|who-we-are|intro|content)[^"]*"[^>]*>(?P<body>.*?)(?=</(?P=tag)>)</(?P=tag)>',
        r'<(?P<tag>section|article|div)\b(?P<attrs>[^>]*)id="[^"]*(?:about|overview|profile|company|who-we-are|intro)[^"]*"[^>]*>(?P<body>.*?)(?=</(?P=tag)>)</(?P=tag)>',
    ]:
        for match in re.finditer(pattern, page_html, flags=re.I | re.S):
            block = match.group(0)
            text = html_to_text(block)
            if 180 <= len(text) <= 8000 and about_context_score(text) >= 1:
                blocks.append(block)
    text = html_to_text(page_html)
    context = extract_context_about(text)
    if context:
        blocks.append(context)
    return list(dict.fromkeys(blocks))


def extract_context_about(text: str) -> str:
    text = remove_boilerplate(text)
    lowered = text.lower()
    starts = [lowered.find(term) for term in ABOUT_CONTEXT_TERMS if lowered.find(term) >= 0]
    if starts:
        start = max(0, min(starts) - 120)
        snippet = text[start : start + 4500]
    else:
        snippet = text[:3500]
    snippet = stop_at_boilerplate_boundary(snippet)
    return trim_about_text(snippet) if len(snippet) >= 220 and about_context_score(snippet) >= 1 else ""


def make_enriched_about(
    *,
    source_url: str,
    page_title: str,
    retrieved_at: str,
    about_text: str,
    evidence_text: str,
    extraction_layer: str,
    raw_json: str = "",
) -> EnrichedAboutResult | None:
    about_text = trim_about_text(about_text)
    evidence_text = clean_text(evidence_text)
    if len(about_text) < 120:
        return None
    confidence = about_confidence(about_text, evidence_text, extraction_layer)
    return EnrichedAboutResult(
        source_url=source_url,
        page_title=page_title,
        retrieved_at=retrieved_at,
        about_text=about_text,
        evidence_text=evidence_text[:1800],
        confidence=round(confidence, 3),
        extraction_layer=extraction_layer,
        raw_json=raw_json,
    )


def about_confidence(about_text: str, evidence_text: str, extraction_layer: str) -> float:
    score = 0.25
    if len(about_text) >= 220:
        score += 0.2
    if len(about_text) >= 700:
        score += 0.1
    if about_context_score(about_text) >= 1:
        score += 0.15
    if about_context_score(evidence_text) >= 2:
        score += 0.1
    if extraction_layer == "structured_data":
        score += 0.08
    elif extraction_layer == "semantic_html":
        score += 0.12
    return min(score, 0.98)


def about_context_score(text: str) -> int:
    lowered = text.lower()
    score = sum(1 for term in ABOUT_CONTEXT_TERMS if term in lowered)
    if re.search(r"\b(?:gold|silver|mining|mine|mineral|exploration|development|producer|royalty|streaming)\b", lowered):
        score += 1
    return score


def about_quality(result: EnrichedAboutResult) -> float:
    layer_bonus = {"semantic_html": 0.08, "structured_data": 0.06, "context_window": 0.03}.get(result.extraction_layer, 0)
    return result.confidence + min(result.text_length, 5000) / 20000 + layer_bonus


def fetch_html(url: str, *, timeout: float, user_agent: str) -> str:
    errors: list[str] = []
    for candidate_url in fetch_url_candidates(url):
        try:
            return fetch_html_once(candidate_url, timeout=timeout, user_agent=user_agent)
        except Exception as exc:
            errors.append(f"{candidate_url}: {exc}")
            try:
                return fetch_html_once(
                    candidate_url,
                    timeout=timeout,
                    user_agent=user_agent,
                    context=ssl._create_unverified_context(),
                )
            except Exception as ssl_exc:
                errors.append(f"{candidate_url} unverified TLS: {ssl_exc}")
                continue
    raise ValueError("; ".join(errors[:5]) or f"Unable to fetch {url}")


def fetch_url_candidates(url: str) -> list[str]:
    parsed = urllib.parse.urlparse(url if re.match(r"^https?://", url, re.I) else f"https://{url}")
    scheme = parsed.scheme or "https"
    netloc = parsed.netloc
    path = parsed.path or "/"
    base = urllib.parse.urlunparse((scheme, netloc, path, "", parsed.query, ""))
    candidates = [base]
    if scheme == "https":
        candidates.append(urllib.parse.urlunparse(("http", netloc, path, "", parsed.query, "")))
    elif scheme == "http":
        candidates.append(urllib.parse.urlunparse(("https", netloc, path, "", parsed.query, "")))
    if netloc.startswith("www."):
        bare = netloc.removeprefix("www.")
        candidates.append(urllib.parse.urlunparse((scheme, bare, path, "", parsed.query, "")))
    elif netloc:
        candidates.append(urllib.parse.urlunparse((scheme, f"www.{netloc}", path, "", parsed.query, "")))
    return list(dict.fromkeys(candidates))


def fetch_html_once(
    url: str,
    *,
    timeout: float,
    user_agent: str,
    context: ssl.SSLContext | None = None,
) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,*/*",
        },
    )
    kwargs: dict[str, Any] = {}
    if context is not None:
        kwargs["context"] = context
    elif "goldfields.com" in urllib.parse.urlparse(url).netloc.lower():
        kwargs["context"] = ssl._create_unverified_context()
    with urllib.request.urlopen(request, timeout=timeout, **kwargs) as response:
        content_type = response.headers.get("content-type", "")
        charset = response.headers.get_content_charset() or "utf-8"
        if "html" not in content_type and content_type:
            raise ValueError(f"Expected HTML but received {content_type}")
        return response.read().decode(charset, errors="replace")


def find_about_url(homepage_html: str, homepage_url: str) -> str | None:
    parser = LinkParser()
    parser.feed(homepage_html)
    base_domain = domain(homepage_url)
    candidates: list[tuple[int, str]] = []
    for link in parser.links:
        absolute_url = urllib.parse.urljoin(homepage_url, link.href)
        if domain(absolute_url) != base_domain:
            continue
        score = score_about_link(link, absolute_url)
        if score:
            candidates.append((score, normalize_url(absolute_url)))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item[0], len(item[1])))
    return candidates[0][1]


def score_about_link(link: Link, url: str) -> int:
    text = clean_text(link.text).lower()
    path = urllib.parse.urlparse(url).path.lower().rstrip("/")
    score = 0
    for index, pattern in enumerate(ABOUT_TEXT_PATTERNS):
        if text == pattern:
            score = max(score, 100 - index)
        elif pattern in text:
            score = max(score, 70 - index)
    for index, pattern in enumerate(ABOUT_URL_PATTERNS):
        if path == pattern:
            score = max(score, 90 - index)
        elif pattern in path:
            score = max(score, 60 - index)
    return score


def extract_text(page_html: str) -> tuple[str, str | None]:
    parser = TextParser()
    parser.feed(page_html)
    text = clean_text(" ".join(parser.parts))
    text = remove_boilerplate(text)
    return text, parser.title or None


def html_to_text(fragment: str) -> str:
    parser = TextParser()
    parser.feed(fragment)
    return remove_boilerplate(clean_text(" ".join(parser.parts)))


def trim_about_text(text: str) -> str:
    text = remove_boilerplate(text)
    if len(text) <= 6000:
        return text
    return text[:6000].rsplit(" ", 1)[0]


def trim_text(text: str, max_length: int) -> str:
    text = clean_text(text)
    if len(text) <= max_length:
        return text
    return text[:max_length].rsplit(" ", 1)[0]


def extract_homepage_overview(text: str) -> str:
    lowered = text.lower()
    starts = [lowered.find(pattern) for pattern in ["about us", "who we are", "company overview", "corporate profile"]]
    starts = [start for start in starts if start >= 0]
    if not starts:
        return ""
    start = min(starts)
    snippet = text[start : start + 3000]
    return trim_about_text(snippet)


def remove_boilerplate(text: str) -> str:
    text = re.sub(r"\b(Customize Reject All Accept All|Necessary Cookies Always Active|Reject All Save My Preferences Accept All)\b.*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def stop_at_boilerplate_boundary(text: str) -> str:
    for marker in [
        "Latest News",
        "News Releases",
        "Investor Relations",
        "Contact Us",
        "Subscribe",
        "Privacy Policy",
        "Forward-Looking",
    ]:
        idx = text.lower().find(marker.lower())
        if idx > 500:
            return text[:idx]
    return text


def row_for_enriched_about(
    company: Company,
    homepage_url: str | None,
    result: EnrichedAboutResult,
) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat()
    raw = result.raw_json or json.dumps(asdict(result), ensure_ascii=False, sort_keys=True)
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": homepage_url,
        "source_url": result.source_url,
        "page_title": result.page_title,
        "retrieved_at": result.retrieved_at,
        "about_text": result.about_text,
        "text_length": result.text_length,
        "evidence_text": result.evidence_text,
        "confidence": result.confidence,
        "extraction_layer": result.extraction_layer,
        "raw_json": raw,
        "status": "found",
        "error_message": None,
        "created_at": now,
    }


def row_for_about_result(company: Company, result: AboutResult) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat()
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": result.homepage_url,
        "about_url": result.about_url,
        "about_title": result.about_title,
        "about_text": result.about_text,
        "text_length": result.text_length,
        "extraction_method": result.extraction_method,
        "status": result.status,
        "error_message": result.error_message,
        "checked_at": now,
        "created_at": now,
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_d1_sql(
    path: Path,
    about_rows: list[dict[str, Any]],
    extraction_rows: list[dict[str, Any]],
    *,
    schema_path: Path,
    overwrite_table: bool = False,
) -> None:
    statements: list[str] = []
    if schema_path.exists():
        statements.append(schema_path.read_text(encoding="utf-8").strip())
    if overwrite_table:
        statements.append("DELETE FROM Website_about_Us_Extractions;")
        statements.append("DELETE FROM Website_about_Us;")

    about_columns = [
        "symbol",
        "company_name",
        "short_name",
        "metal",
        "company_type",
        "homepage_url",
        "about_url",
        "about_title",
        "about_text",
        "text_length",
        "extraction_method",
        "status",
        "error_message",
        "checked_at",
        "created_at",
    ]
    about_assignments = ",\n    ".join(
        f"{column} = excluded.{column}"
        for column in about_columns
        if column not in {"symbol", "created_at"}
    )
    for row in about_rows:
        values = ", ".join(sql_value(row.get(column)) for column in about_columns)
        statements.append(
            f"""INSERT INTO Website_about_Us ({", ".join(about_columns)}, updated_at)
VALUES ({values}, CURRENT_TIMESTAMP)
ON CONFLICT(symbol) DO UPDATE SET
    {about_assignments},
    updated_at = CURRENT_TIMESTAMP;"""
        )

    extraction_columns = [
        "symbol",
        "company_name",
        "short_name",
        "metal",
        "company_type",
        "homepage_url",
        "source_url",
        "page_title",
        "retrieved_at",
        "about_text",
        "text_length",
        "evidence_text",
        "confidence",
        "extraction_layer",
        "raw_json",
        "status",
        "error_message",
        "created_at",
    ]
    extraction_assignments = ",\n    ".join(
        f"{column} = excluded.{column}"
        for column in extraction_columns
        if column not in {"symbol", "source_url", "extraction_layer", "created_at"}
    )
    for row in extraction_rows:
        values = ", ".join(sql_value(row.get(column)) for column in extraction_columns)
        statements.append(
            f"""INSERT INTO Website_about_Us_Extractions ({", ".join(extraction_columns)}, updated_at)
VALUES ({values}, CURRENT_TIMESTAMP)
ON CONFLICT(symbol, source_url, extraction_layer) DO UPDATE SET
    {extraction_assignments},
    updated_at = CURRENT_TIMESTAMP;"""
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n\n".join(statements).strip() + "\n", encoding="utf-8")


def sql_value(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def domain(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower().removeprefix("www.")


def normalize_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path or "/"
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


if __name__ == "__main__":
    raise SystemExit(main())

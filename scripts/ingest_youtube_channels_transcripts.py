import os
import re
import time
from pathlib import Path
import requests
from youtube_transcript_api import YouTubeTranscriptApi

YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
WORKER_BASE_URL = os.environ["WORKER_BASE_URL"].rstrip("/")
WORKER_API_KEY = os.environ["WORKER_API_KEY"]

MAX_VIDEOS_PER_CHANNEL = int(os.environ.get("YT_MAX_VIDEOS_PER_CHANNEL", "10"))
TICKERS_JS_PATH = Path(os.environ.get("TICKERS_JS_PATH", "src/tickers.js"))
CHANNEL_FILTER = {
    item.strip().lower()
    for item in os.environ.get("YT_CHANNEL_FILTER", "").split(",")
    if item.strip()
}

SYMBOL_ONLY_BLOCKLIST = {"AG", "AU", "OR", "GOLD", "USA"}
ALIAS_BLOCKLIST = {
    "and",
    "company",
    "corp",
    "corporation",
    "copper",
    "energy",
    "gold",
    "inc",
    "limited",
    "lithium",
    "ltd",
    "metal",
    "metals",
    "miner",
    "miners",
    "mines",
    "mining",
    "or",
    "plc",
    "resource",
    "resources",
    "royalty",
    "silver",
    "streaming",
    "the",
    "uranium",
}
LEGAL_SUFFIX_RE = re.compile(
    r"\b(corp(?:oration)?|inc(?:orporated)?|ltd|limited|plc|company|co)\.?\b",
    re.I,
)

CHANNELS = [
    {
        "name": "Kitco News",
        "handle_url": "https://www.youtube.com/@kitco",
    },
    {"name": "Kitco Mining", "query": "Kitco Mining"},
    {"name": "Metals Investor Forum", "query": "Metals Investor Forum"},
    {"name": "Commodity Culture", "query": "Commodity Culture"},
    {"name": "Sprott Money", "query": "Sprott Money"},
    {"name": "Mining Stocks Today", "query": "Mining Stocks Today"},
    {"name": "Sprott", "query": "Sprott"},
    {"name": "Rule Investment Media", "query": "Rule Investment Media"},
    {"name": "Don Durrett", "query": "Don Durrett"},
    {"name": "Mining Stock Education", "query": "Mining Stock Education"},
    {"name": "Mining Stock Monkey", "query": "Mining Stock Monkey"},
    {"name": "Crux Investor", "query": "Crux Investor"},
    {"name": "Jay Martin Show", "query": "Jay Martin Show"},
    {"name": "Liberty and Finance", "query": "Liberty and Finance"},
    {"name": "Wealtheon", "query": "Wealtheon"},
]

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 transcript-ingest/1.0"
})


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
        quote = None
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


def array_property(block: str, name: str) -> list[str]:
    match = re.search(rf"\b{name}\s*:\s*\[(.*?)\]", block, re.S)
    if not match:
        return []
    return [
        bytes(item.group(2), "utf-8").decode("unicode_escape")
        for item in re.finditer(r"(['\"])(.*?)\1", match.group(1), re.S)
    ]


def normalize_alias(value: str) -> str:
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return value.strip(" ,.;:-")


def strip_legal_suffix(value: str) -> str:
    return normalize_alias(LEGAL_SUFFIX_RE.sub("", value))


def alias_variants(value: str) -> list[str]:
    base = normalize_alias(value)
    if not base:
        return []
    variants = {
        base,
        strip_legal_suffix(base),
        normalize_alias(base.replace("&", "and")),
        normalize_alias(base.replace("-", " ")),
    }
    return [variant for variant in variants if variant]


def is_useful_alias(alias: str) -> bool:
    compact = re.sub(r"[^a-z0-9]+", "", alias.lower())
    if len(compact) < 4:
        return False
    if alias.lower() in ALIAS_BLOCKLIST:
        return False
    return any(char.isalpha() for char in alias)


def compile_alias_pattern(alias: str):
    parts = [re.escape(part) for part in re.split(r"\s+", alias) if part]
    if not parts:
        return None
    return re.compile(r"(?<![A-Za-z0-9])" + r"[\W_]+".join(parts) + r"(?![A-Za-z0-9])", re.I)


def compile_symbol_pattern(symbol: str):
    if len(symbol) < 3 or symbol in SYMBOL_ONLY_BLOCKLIST:
        return None
    return re.compile(r"(?<![A-Za-z0-9])\$?" + re.escape(symbol) + r"(?![A-Za-z0-9])", re.I)


def load_ticker_matchers(path: Path):
    if not path.exists():
        print(f"Ticker universe not found at {path}; company-specific YouTube tagging disabled.")
        return [], []

    source = path.read_text(encoding="utf-8")
    body_match = re.search(r"export\s+const\s+TICKERS\s*=\s*\{(?P<body>.*)\}\s*;?\s*$", source, re.S)
    if not body_match:
        raise ValueError(f"Could not find exported TICKERS object in {path}")

    symbol_matchers = []
    alias_to_symbols: dict[str, set[str]] = {}
    alias_display: dict[str, str] = {}

    for symbol, block in iter_ticker_blocks(body_match.group("body")):
        pattern = compile_symbol_pattern(symbol)
        if pattern:
            symbol_matchers.append((symbol, pattern))

        raw_aliases = [
            string_property(block, "name") or "",
            string_property(block, "company") or "",
            *array_property(block, "aliases"),
        ]
        for raw_alias in raw_aliases:
            for alias in alias_variants(raw_alias):
                if not is_useful_alias(alias):
                    continue
                key = alias.lower()
                alias_to_symbols.setdefault(key, set()).add(symbol)
                alias_display.setdefault(key, alias)

    alias_matchers = []
    for key, symbols in alias_to_symbols.items():
        if len(symbols) != 1:
            continue
        pattern = compile_alias_pattern(alias_display[key])
        if pattern:
            alias_matchers.append((next(iter(symbols)), pattern))

    print(
        f"Loaded {len(symbol_matchers)} ticker patterns and "
        f"{len(alias_matchers)} company alias patterns from {path}"
    )
    return symbol_matchers, alias_matchers


SYMBOL_MATCHERS, ALIAS_MATCHERS = load_ticker_matchers(TICKERS_JS_PATH)


def should_run_channel(channel):
    if not CHANNEL_FILTER:
        return True
    values = {
        str(channel.get("name", "")).strip().lower(),
        str(channel.get("query", "")).strip().lower(),
    }
    return any(value in CHANNEL_FILTER for value in values if value)


def resolve_channel_id_from_handle(channel_url: str) -> str:
    resp = SESSION.get(channel_url, timeout=30)
    resp.raise_for_status()
    html = resp.text

    match = re.search(r'"externalId":"(UC[a-zA-Z0-9_-]{22})"', html)
    if match:
        return match.group(1)

    match = re.search(r'https://www\.youtube\.com/channel/(UC[a-zA-Z0-9_-]{22})', html)
    if match:
        return match.group(1)

    raise RuntimeError(f"Could not resolve channel id from {channel_url}")


def youtube_search(params):
    resp = SESSION.get(
        "https://www.googleapis.com/youtube/v3/search",
        params={**params, "key": YOUTUBE_API_KEY},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def resolve_channel_id_from_query(query: str) -> str:
    data = youtube_search({
        "part": "snippet",
        "q": query,
        "type": "channel",
        "maxResults": 1,
        "order": "relevance",
    })
    items = data.get("items", []) or []
    if not items:
        raise RuntimeError(f"Could not resolve channel for query: {query}")

    channel_id = ((items[0] or {}).get("id") or {}).get("channelId")
    if not channel_id:
        raise RuntimeError(f"Bad channel search response for query: {query}")
    return channel_id


def get_channel_meta(channel_id: str):
    resp = SESSION.get(
        "https://www.googleapis.com/youtube/v3/channels",
        params={
            "part": "contentDetails,snippet",
            "id": channel_id,
            "key": YOUTUBE_API_KEY,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()

    items = data.get("items", [])
    if not items:
        raise RuntimeError(f"No channel found for id {channel_id}")

    item = items[0]
    uploads = item["contentDetails"]["relatedPlaylists"]["uploads"]
    title = item["snippet"].get("title", "")
    return uploads, title


def get_uploaded_videos(uploads_playlist_id: str, limit: int):
    videos = []
    page_token = None

    while len(videos) < limit:
        resp = SESSION.get(
            "https://www.googleapis.com/youtube/v3/playlistItems",
            params={
                "part": "snippet",
                "playlistId": uploads_playlist_id,
                "maxResults": min(50, limit - len(videos)),
                "key": YOUTUBE_API_KEY,
                **({"pageToken": page_token} if page_token else {}),
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        for item in data.get("items", []):
            snippet = item.get("snippet", {})
            resource = snippet.get("resourceId", {})
            video_id = resource.get("videoId")
            if not video_id:
                continue

            videos.append({
                "video_id": video_id,
                "title": snippet.get("title", ""),
                "published_at": snippet.get("publishedAt"),
                "channel_title": snippet.get("channelTitle", ""),
                "video_url": f"https://www.youtube.com/watch?v={video_id}",
            })
            if len(videos) >= limit:
                break

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return videos


def transcript_exists(video_id: str) -> bool:
    resp = SESSION.get(
        f"{WORKER_BASE_URL}/api/youtube-transcript/exists",
        params={"video_id": video_id},
        headers={"x-api-key": WORKER_API_KEY},
        timeout=30,
    )
    resp.raise_for_status()
    return bool(resp.json().get("exists"))


def infer_symbol_tags(video: dict, transcript_text: str = ""):
    text = "\n".join(
        [
            str(video.get("title", "") or ""),
            str(transcript_text or "")[:200000],
        ]
    )
    tags = []
    for symbol, pattern in SYMBOL_MATCHERS:
        if pattern.search(text):
            tags.append(symbol)
    for symbol, pattern in ALIAS_MATCHERS:
        if pattern.search(text):
            tags.append(symbol)

    seen = set()
    unique = []
    for tag in tags:
        normalized = str(tag or "").upper().strip()
        if normalized and normalized not in seen:
            unique.append(normalized)
            seen.add(normalized)
    return unique[:12]


def fetch_transcript(video_id: str):
    ytt = YouTubeTranscriptApi()

    try:
        transcript = ytt.fetch(video_id, languages=["en"])
        rows = transcript.to_raw_data()
        full_text = "\n".join(
            row.get("text", "").strip() for row in rows if row.get("text", "").strip()
        ).strip()
        return full_text, transcript.language_code, transcript.is_generated
    except Exception:
        transcript_list = ytt.list(video_id)
        chosen = None

        try:
            chosen = transcript_list.find_transcript(["en"])
        except Exception:
            pass

        if chosen is None:
            for item in transcript_list:
                chosen = item
                break

        if chosen is None:
            raise RuntimeError("No transcript found")

        fetched = chosen.fetch()
        rows = fetched.to_raw_data()
        full_text = "\n".join(
            row.get("text", "").strip() for row in rows if row.get("text", "").strip()
        ).strip()
        return full_text, fetched.language_code, fetched.is_generated


def ingest_one(channel_id: str, channel_title: str, video: dict):
    transcript_text, language_code, is_generated = fetch_transcript(video["video_id"])
    symbol_tags = infer_symbol_tags(video, transcript_text)

    payload = {
        "video_id": video["video_id"],
        "title": video["title"],
        "channel_id": channel_id,
        "channel_title": channel_title or video.get("channel_title"),
        "published_at": video["published_at"],
        "video_url": video["video_url"],
        "transcript_text": transcript_text,
        "transcript_language": language_code,
        "is_generated": bool(is_generated),
        "symbol_tags": symbol_tags,
    }

    resp = SESSION.post(
        f"{WORKER_BASE_URL}/api/ingest/youtube-transcript",
        json=payload,
        headers={
            "x-api-key": WORKER_API_KEY,
            "content-type": "application/json",
        },
        timeout=60,
    )
    resp.raise_for_status()
    result = resp.json()
    result["symbol_tags"] = symbol_tags
    return result


def ingest_video_metadata(channel_id: str, channel_title: str, video: dict, reason: str):
    """Store a video/link record when transcript fetch is blocked by YouTube."""
    payload = {
        "video_id": video["video_id"],
        "title": video["title"],
        "channel": channel_title or video.get("channel_title") or "",
        "published_at": video.get("published_at") or "",
        "url": video["video_url"],
        "symbol_tags": infer_symbol_tags(video),
        "segments": [
            {
                "start": 0,
                "duration": 0,
                "text": f"Transcript unavailable from GitHub runner. Stored video metadata only. Reason: {str(reason)[:500]}",
            }
        ],
    }

    resp = SESSION.post(
        f"{WORKER_BASE_URL}/api/ingest/youtube",
        json=payload,
        headers={
            "x-api-key": WORKER_API_KEY,
            "content-type": "application/json",
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def resolve_channel(channel: dict):
    channel_id = channel.get("channel_id")
    if channel_id:
        try:
            get_channel_meta(channel_id)
            return channel_id
        except Exception:
            pass
    if channel.get("handle_url"):
        return resolve_channel_id_from_handle(channel["handle_url"])
    if channel.get("query"):
        return resolve_channel_id_from_query(channel["query"])
    raise RuntimeError(f"Channel config missing resolver: {channel}")


def main():
    totals = {"success": 0, "metadata_only": 0, "skipped": 0, "failed": 0, "channels": 0, "videos": 0}

    for channel in CHANNELS:
        if not should_run_channel(channel):
            continue

        name = channel["name"]
        print(f"\n=== CHANNEL: {name} ===")

        try:
            channel_id = resolve_channel(channel)
            uploads_playlist_id, channel_title = get_channel_meta(channel_id)
            videos = get_uploaded_videos(uploads_playlist_id, MAX_VIDEOS_PER_CHANNEL)
            totals["channels"] += 1
            totals["videos"] += len(videos)

            print(f"Resolved channel_id={channel_id}")
            print(f"Uploads playlist={uploads_playlist_id}")
            print(f"Channel title={channel_title}")
            print(f"Videos queued={len(videos)}")

            for idx, video in enumerate(videos, start=1):
                video_id = video["video_id"]
                title = video["title"]

                try:
                    if transcript_exists(video_id):
                        print(f"[{idx}/{len(videos)}] SKIP existing {video_id} | {title}")
                        totals["skipped"] += 1
                        continue

                    result = ingest_one(channel_id, channel_title, video)
                    print(f"[{idx}/{len(videos)}] OK {video_id} | {title} | {result}")
                    totals["success"] += 1
                    time.sleep(0.5)

                except Exception as err:
                    try:
                        result = ingest_video_metadata(channel_id, channel_title, video, str(err))
                        print(f"[{idx}/{len(videos)}] METADATA_ONLY {video_id} | {title} | {result}")
                        totals["metadata_only"] += 1
                    except Exception as fallback_err:
                        print(f"[{idx}/{len(videos)}] FAIL {video_id} | {title} | transcript={err} | metadata={fallback_err}")
                        totals["failed"] += 1

        except Exception as err:
            print(f"CHANNEL FAIL {name} | {err}")
            totals["failed"] += 1

    print("\nDONE")
    print(totals)


if __name__ == "__main__":
    main()

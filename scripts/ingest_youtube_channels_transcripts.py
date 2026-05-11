import os
import re
import time
import requests
from youtube_transcript_api import YouTubeTranscriptApi

YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
WORKER_BASE_URL = os.environ["WORKER_BASE_URL"].rstrip("/")
WORKER_API_KEY = os.environ["WORKER_API_KEY"]

MAX_VIDEOS_PER_CHANNEL = int(os.environ.get("YT_MAX_VIDEOS_PER_CHANNEL", "10"))
CHANNEL_FILTER = {
    item.strip().lower()
    for item in os.environ.get("YT_CHANNEL_FILTER", "").split(",")
    if item.strip()
}

CHANNELS = [
    {
        "name": "Kitco News",
        "handle_url": "https://www.youtube.com/@kitco",
        "channel_id": "UCzH5n3I2P5J8R9H0pE0hL5A",
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
    return resp.json()


def resolve_channel(channel: dict):
    if channel.get("channel_id"):
        return channel["channel_id"]
    if channel.get("handle_url"):
        return resolve_channel_id_from_handle(channel["handle_url"])
    if channel.get("query"):
        return resolve_channel_id_from_query(channel["query"])
    raise RuntimeError(f"Channel config missing resolver: {channel}")


def main():
    totals = {"success": 0, "skipped": 0, "failed": 0, "channels": 0, "videos": 0}

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
                    print(f"[{idx}/{len(videos)}] FAIL {video_id} | {title} | {err}")
                    totals["failed"] += 1

        except Exception as err:
            print(f"CHANNEL FAIL {name} | {err}")
            totals["failed"] += 1

    print("\nDONE")
    print(totals)


if __name__ == "__main__":
    main()

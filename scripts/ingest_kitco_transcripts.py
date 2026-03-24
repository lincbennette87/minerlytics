import os
import re
import time
import requests
from youtube_transcript_api import YouTubeTranscriptApi

CHANNEL_HANDLE_URL = "https://www.youtube.com/@kitco"

YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
WORKER_BASE_URL = os.environ["WORKER_BASE_URL"].rstrip("/")
WORKER_API_KEY = os.environ["WORKER_API_KEY"]

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 transcript-ingest/1.0"
})


def resolve_channel_id_from_handle(channel_url: str) -> str:
    """
    Resolve https://www.youtube.com/@kitco -> UC...
    This uses the public channel page HTML.
    """
    resp = SESSION.get(channel_url, timeout=30)
    resp.raise_for_status()
    html = resp.text

    # Common YouTube HTML field
    m = re.search(r'"externalId":"(UC[a-zA-Z0-9_-]{22})"', html)
    if m:
        return m.group(1)

    # Backup pattern
    m = re.search(r'https://www\.youtube\.com/channel/(UC[a-zA-Z0-9_-]{22})', html)
    if m:
        return m.group(1)

    raise RuntimeError(f"Could not resolve channel id from {channel_url}")


def get_uploads_playlist_id(channel_id: str) -> str:
    url = "https://www.googleapis.com/youtube/v3/channels"
    params = {
        "part": "contentDetails,snippet",
        "id": channel_id,
        "key": YOUTUBE_API_KEY,
    }
    resp = SESSION.get(url, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    items = data.get("items", [])
    if not items:
        raise RuntimeError(f"No channel found for id {channel_id}")

    item = items[0]
    uploads = item["contentDetails"]["relatedPlaylists"]["uploads"]
    title = item["snippet"].get("title", "")
    return uploads, title


def get_all_uploaded_videos(uploads_playlist_id: str):
    """
    Returns a list of dicts with video_id, title, published_at, channel_title
    """
    videos = []
    page_token = None

    while True:
        url = "https://www.googleapis.com/youtube/v3/playlistItems"
        params = {
            "part": "snippet",
            "playlistId": uploads_playlist_id,
            "maxResults": 50,
            "key": YOUTUBE_API_KEY,
        }
        if page_token:
            params["pageToken"] = page_token

        resp = SESSION.get(url, params=params, timeout=30)
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

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return videos


def transcript_exists(video_id: str) -> bool:
    url = f"{WORKER_BASE_URL}/api/youtube-transcript/exists"
    resp = SESSION.get(
        url,
        params={"video_id": video_id},
        headers={"x-api-key": WORKER_API_KEY},
        timeout=30
    )
    resp.raise_for_status()
    return bool(resp.json().get("exists"))


def fetch_transcript(video_id: str):
    """
    Returns (full_text, language_code, is_generated)
    """
    ytt = YouTubeTranscriptApi()

    # Prefer English, but fall back to other languages if needed by listing.
    try:
        transcript = ytt.fetch(video_id, languages=["en"])
        rows = transcript.to_raw_data()
        full_text = "\n".join(
            row.get("text", "").strip() for row in rows if row.get("text", "").strip()
        ).strip()
        return full_text, transcript.language_code, transcript.is_generated
    except Exception:
        # fallback: inspect available transcripts, prefer English, then first available
        transcript_list = ytt.list(video_id)

        chosen = None
        try:
            chosen = transcript_list.find_transcript(["en"])
        except Exception:
            pass

        if chosen is None:
            for t in transcript_list:
                chosen = t
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


def main():
    channel_id = resolve_channel_id_from_handle(CHANNEL_HANDLE_URL)
    uploads_playlist_id, channel_title = get_uploads_playlist_id(channel_id)

    print(f"Resolved channel_id={channel_id}")
    print(f"Uploads playlist={uploads_playlist_id}")
    print(f"Channel title={channel_title}")

    videos = get_all_uploaded_videos(uploads_playlist_id)[:5]
    print(f"Found {len(videos)} uploaded videos")

    success = 0
    skipped = 0
    failed = 0

    for idx, video in enumerate(videos, start=1):
        video_id = video["video_id"]
        title = video["title"]

        try:
            if transcript_exists(video_id):
                print(f"[{idx}/{len(videos)}] SKIP existing {video_id} | {title}")
                skipped += 1
                continue

            result = ingest_one(channel_id, channel_title, video)
            print(f"[{idx}/{len(videos)}] OK {video_id} | {title} | {result}")
            success += 1

            # tiny delay to be polite
            time.sleep(0.5)

        except Exception as e:
            print(f"[{idx}/{len(videos)}] FAIL {video_id} | {title} | {e}")
            failed += 1
            continue

    print("DONE")
    print({
        "success": success,
        "skipped": skipped,
        "failed": failed,
        "total": len(videos),
    })


if __name__ == "__main__":
    main()

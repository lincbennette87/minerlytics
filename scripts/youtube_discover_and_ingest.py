import os, json, time, requests
from youtube_transcript_api import YouTubeTranscriptApi
import youtube_transcript_api

print("youtube_transcript_api loaded from:", youtube_transcript_api.__file__)
print("youtube_transcript_api version:", getattr(youtube_transcript_api, "__version__", "unknown"))

YT_KEY = os.environ["YOUTUBE_API_KEY"]
WORKER_INGEST_URL = os.environ["WORKER_INGEST_URL"]   # https://.../api/ingest/youtube
WORKER_API_KEY = os.environ["WORKER_API_KEY"]         # simple secret

# Only ingest 5 videos per channel
MAX_VIDEOS_PER_CHANNEL = 5

# Channels we care about (we'll resolve channel IDs via API)
TARGET_CHANNELS = [
    {"name": "Kitco NEWS",   "query": "Kitco NEWS",   "tag": "KITCO_NEWS"},
    {"name": "Kitco Mining", "query": "Kitco Mining", "tag": "KITCO_MINING"},
]


def yt_search(params):
    """Generic wrapper for YouTube Data API v3 search endpoint."""
    url = "https://www.googleapis.com/youtube/v3/search"
    params = {**params, "key": YT_KEY}
    r = requests.get(url, params=params, timeout=30)
    if r.status_code != 200:
        print("YT_SEARCH_ERROR:", r.status_code, r.text[:500])
    r.raise_for_status()
    return r.json()


def resolve_channel_id(channel_query: str) -> str:
    """
    Resolve a channel's UC id using YouTube search (type=channel).
    This avoids hardcoding channel IDs (especially for custom URLs / handles).
    """
    data = yt_search({
        "part": "snippet",
        "q": channel_query,
        "type": "channel",
        "maxResults": 1,
        "order": "relevance",
    })
    items = data.get("items", []) or []
    if not items:
        raise RuntimeError(f"Could not resolve channel_id for query: {channel_query}")

    chan_id = ((items[0] or {}).get("id") or {}).get("channelId")
    if not chan_id:
        raise RuntimeError(f"Bad channel search response for: {channel_query}")

    return chan_id


def yt_latest_videos_from_channel(channel_id: str, max_results: int = 5):
    """Get latest videos from a specific channel."""
    data = yt_search({
        "part": "snippet",
        "channelId": channel_id,
        "type": "video",
        "maxResults": max_results,
        "order": "date",
    })
    return data.get("items", []) or []


def worker_seen(video_id):
    base = WORKER_INGEST_URL.replace("/api/ingest/youtube", "")
    seen_url = f"{base}/api/youtube/seen?video_id={video_id}"

    r = requests.get(
        seen_url,
        headers={"x-api-key": WORKER_API_KEY},
        timeout=20,
    )

    if r.status_code != 200:
        print("SEEN_CHECK_ERROR:", video_id, r.status_code, r.text[:300])
        return False

    try:
        data = r.json()
    except Exception as e:
        print("SEEN_CHECK_BAD_JSON:", video_id, str(e), r.text[:300])
        return False

    return data.get("seen") is True


def ingest(video_id, title, channel, published_at, tag):
    try:
        segs = YouTubeTranscriptApi.get_transcript(video_id)
        print("TRANSCRIPT_OK:", video_id, "segments:", len(segs))
    except Exception as e:
        print("TRANSCRIPT_FAIL:", video_id, str(e))
        return False

    segments = [
        {
            "start": s["start"],
            "duration": s.get("duration", 0),
            "text": s["text"]
        }
        for s in segs
    ]

    payload = {
        "video_id": video_id,
        "title": title,
        "channel": channel,
        "published_at": published_at,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "symbol_tags": [tag],     # keep your worker contract; tag by channel
        "segments": segments,
    }

    r = requests.post(
        WORKER_INGEST_URL,
        headers={
            "content-type": "application/json",
            "x-api-key": WORKER_API_KEY
        },
        data=json.dumps(payload),
        timeout=60,
    )

    print("INGEST_STATUS:", video_id, r.status_code)
    r.raise_for_status()
    return True


def main():
    total_found = 0
    total_skipped_seen = 0
    total_ingested = 0
    total_failed = 0

    # Local dedupe within this run
    seen_in_run = set()

    for ch in TARGET_CHANNELS:
        print(f"\n=== CHANNEL: {ch['name']} | pulling latest {MAX_VIDEOS_PER_CHANNEL} videos ===")

        try:
            channel_id = resolve_channel_id(ch["query"])
            print("RESOLVED_CHANNEL_ID:", ch["name"], "->", channel_id)
        except Exception as e:
            total_failed += 1
            print("CHANNEL_RESOLVE_FAILED:", ch["name"], str(e))
            continue

        try:
            items = yt_latest_videos_from_channel(channel_id, max_results=MAX_VIDEOS_PER_CHANNEL)
            print("VIDEOS_FOUND:", ch["name"], len(items))
        except Exception as e:
            total_failed += 1
            print("CHANNEL_VIDEO_FETCH_FAILED:", ch["name"], str(e))
            continue

        for item in items:
            vid = (((item or {}).get("id") or {}).get("videoId")) or ""
            snip = (item or {}).get("snippet") or {}
            if not vid:
                continue

            if vid in seen_in_run:
                continue
            seen_in_run.add(vid)

            total_found += 1

            # Skip if already in DB
            try:
                if worker_seen(vid):
                    total_skipped_seen += 1
                    continue
            except Exception as e:
                print("SEEN_CHECK_EXCEPTION:", vid, str(e))

            try:
                ok = ingest(
                    vid,
                    snip.get("title"),
                    snip.get("channelTitle"),
                    snip.get("publishedAt"),
                    ch["tag"],
                )
                if ok:
                    total_ingested += 1
                else:
                    total_failed += 1
                time.sleep(0.2)
            except Exception as e:
                total_failed += 1
                print("INGEST_FAILED:", vid, str(e))

    print("\n=== DONE ===")
    print("total_found:", total_found)
    print("total_skipped_seen:", total_skipped_seen)
    print("total_ingested:", total_ingested)
    print("total_failed:", total_failed)
    if total_ingested == 0:
        raise SystemExit("No videos ingested (check errors above).")


if __name__ == "__main__":
    main()

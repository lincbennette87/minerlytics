import os, json, time, requests

YT_KEY = os.environ.get("YOUTUBE_API_KEY", "")
WORKER_INGEST_URL = os.environ["WORKER_INGEST_URL"]   # https://.../api/ingest/youtube
WORKER_API_KEY = os.environ["WORKER_API_KEY"]         # simple secret

# TEST MODE: set True to push a fake transcript through your Worker/D1
TEST_MODE = True

# Channels we care about (kept here in case you switch TEST_MODE off later)
TARGET_CHANNELS = [
    {"name": "Kitco NEWS",   "query": "Kitco NEWS",   "tag": "KITCO_NEWS"},
    {"name": "Kitco Mining", "query": "Kitco Mining", "tag": "KITCO_MINING"},
]

MAX_INGEST_PER_CHANNEL = 5
CANDIDATES_PER_CHANNEL = 25


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
    """Resolve a channel's UC id using YouTube search (type=channel)."""
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


def yt_latest_videos_from_channel(channel_id: str, max_results: int):
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
    """Check if your Worker/D1 already has this video."""
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
    """
    Sends a payload to your Cloudflare Worker ingest endpoint.

    In TEST_MODE we bypass YouTube transcripts and send a fake transcript,
    so you can verify youtube_videos + youtube_video_symbols + youtube_segments
    inserts all work end-to-end.
    """

    if TEST_MODE:
        segments = [
            {"start": 0.0, "duration": 4.0, "text": "Welcome to Kitco News. Gold prices are showing strength today."},
            {"start": 4.0, "duration": 5.5, "text": "Analysts believe inflation concerns are supporting precious metals."},
            {"start": 9.5, "duration": 6.0, "text": "Agnico Eagle and Gold Fields stocks are trending higher."},
        ]
        transcript_status = "test_sample"
        print("USING_TEST_TRANSCRIPT:", video_id, "segments:", len(segments))
    else:
        # If you later switch TEST_MODE off, you'll likely add back:
        # from youtube_transcript_api import YouTubeTranscriptApi
        # segs = YouTubeTranscriptApi.get_transcript(video_id)
        # segments = [{"start": s["start"], "duration": s.get("duration", 0), "text": s["text"]} for s in segs]
        raise RuntimeError("TEST_MODE is False but real transcript fetch is not enabled in this file.")

    payload = {
        "video_id": video_id,
        "title": title,
        "channel": channel,
        "published_at": published_at,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "symbol_tags": [tag],
        "segments": segments,
        "transcript_status": transcript_status,  # optional; safe if Worker ignores unknown fields
    }

    r = requests.post(
        WORKER_INGEST_URL,
        headers={"content-type": "application/json", "x-api-key": WORKER_API_KEY},
        data=json.dumps(payload),
        timeout=60,
    )

    print("INGEST_STATUS:", video_id, r.status_code)
    if r.status_code != 200:
        print("INGEST_ERROR_BODY:", r.text[:500])
    r.raise_for_status()
    return True


def main():
    if TEST_MODE:
        # Use a stable test ID so you can query D1 easily.
        test_video_id = "TEST_VIDEO_001"

        # Optional: skip if already inserted
        try:
            if worker_seen(test_video_id):
                print("TEST_VIDEO_ALREADY_SEEN:", test_video_id, "-> skipping")
                return
        except Exception as e:
            print("SEEN_CHECK_EXCEPTION (test):", str(e)[:200])

        print("TEST MODE: inserting 1 fake transcript into Worker/D1")
        ingest(
            video_id=test_video_id,
            title="Test Kitco Gold Market Update",
            channel="Kitco NEWS",
            published_at="2026-02-21T00:00:00Z",
            tag="KITCO_TEST",
        )
        print("DONE TEST INSERT")
        return

    # If you later want to switch TEST_MODE off and run channel ingestion,
    # you can implement that loop here (not enabled in this test file).
    raise RuntimeError("TEST_MODE is False but channel ingestion is not enabled in this file.")


if __name__ == "__main__":
    main()

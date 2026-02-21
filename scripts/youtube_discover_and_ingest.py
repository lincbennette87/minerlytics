import os, json, time, requests
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    TranscriptsDisabled,
    NoTranscriptFound,
    VideoUnavailable,
    TooManyRequests,
    CouldNotRetrieveTranscript,
)

YT_KEY = os.environ["YOUTUBE_API_KEY"]
WORKER_INGEST_URL = os.environ["WORKER_INGEST_URL"]   # https://.../api/ingest/youtube
WORKER_API_KEY = os.environ["WORKER_API_KEY"]         # simple secret

MAX_INGEST_PER_CHANNEL = 5
CANDIDATES_PER_CHANNEL = 25  # pull more because many will have no captions

TARGET_CHANNELS = [
    {"name": "Kitco NEWS",   "query": "Kitco NEWS",   "tag": "KITCO_NEWS"},
    {"name": "Kitco Mining", "query": "Kitco Mining", "tag": "KITCO_MINING"},
]


def yt_search(params):
    url = "https://www.googleapis.com/youtube/v3/search"
    params = {**params, "key": YT_KEY}
    r = requests.get(url, params=params, timeout=30)
    if r.status_code != 200:
        print("YT_SEARCH_ERROR:", r.status_code, r.text[:500])
    r.raise_for_status()
    return r.json()


def resolve_channel_id(channel_query: str) -> str:
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

    r = requests.get(seen_url, headers={"x-api-key": WORKER_API_KEY}, timeout=20)
    if r.status_code != 200:
        print("SEEN_CHECK_ERROR:", video_id, r.status_code, r.text[:300])
        return False
    try:
        data = r.json()
    except Exception as e:
        print("SEEN_CHECK_BAD_JSON:", video_id, str(e), r.text[:300])
        return False

    return data.get("seen") is True


def fetch_transcript_segments(video_id: str):
    """
    Returns list of segments or None if unavailable.
    """
    try:
        # Try the default transcript selection (auto where available)
        segs = YouTubeTranscriptApi.get_transcript(video_id)
        return [
            {"start": s["start"], "duration": s.get("duration", 0), "text": s["text"]}
            for s in segs
        ]
    except (TranscriptsDisabled, NoTranscriptFound) as e:
        print("TRANSCRIPT_UNAVAILABLE:", video_id, str(e).splitlines()[0])
        return None
    except (VideoUnavailable, CouldNotRetrieveTranscript, TooManyRequests) as e:
        # treat as unavailable for now; you can add retry/backoff if needed
        print("TRANSCRIPT_ERROR:", video_id, type(e).__name__, str(e)[:200])
        return None
    except Exception as e:
        print("TRANSCRIPT_FAIL:", video_id, str(e)[:200])
        return None


def ingest(video_id, title, channel, published_at, tag):
    segments = fetch_transcript_segments(video_id)
    if not segments:
        return False

    payload = {
        "video_id": video_id,
        "title": title,
        "channel": channel,
        "published_at": published_at,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "symbol_tags": [tag],     # keep your worker contract
        "segments": segments,
    }

    r = requests.post(
        WORKER_INGEST_URL,
        headers={"content-type": "application/json", "x-api-key": WORKER_API_KEY},
        data=json.dumps(payload),
        timeout=60,
    )

    print("INGEST_STATUS:", video_id, r.status_code, "| segments:", len(segments))
    r.raise_for_status()
    return True


def main():
    total_found = 0
    total_skipped_seen = 0
    total_ingested = 0
    total_failed = 0
    total_no_transcript = 0

    seen_in_run = set()

    for ch in TARGET_CHANNELS:
        ingested_for_channel = 0
        print(f"\n=== CHANNEL: {ch['name']} | need {MAX_INGEST_PER_CHANNEL} ingests ===")

        try:
            channel_id = resolve_channel_id(ch["query"])
            print("RESOLVED_CHANNEL_ID:", ch["name"], "->", channel_id)
        except Exception as e:
            total_failed += 1
            print("CHANNEL_RESOLVE_FAILED:", ch["name"], str(e))
            continue

        try:
            items = yt_latest_videos_from_channel(channel_id, max_results=CANDIDATES_PER_CHANNEL)
            print("CANDIDATES_FOUND:", ch["name"], len(items))
        except Exception as e:
            total_failed += 1
            print("CHANNEL_VIDEO_FETCH_FAILED:", ch["name"], str(e))
            continue

        for item in items:
            if ingested_for_channel >= MAX_INGEST_PER_CHANNEL:
                break

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
                print("SEEN_CHECK_EXCEPTION:", vid, str(e)[:200])

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
                    ingested_for_channel += 1
                else:
                    total_no_transcript += 1
                time.sleep(0.2)
            except Exception as e:
                total_failed += 1
                print("INGEST_FAILED:", vid, str(e)[:300])

        print(f"CHANNEL_DONE: {ch['name']} ingested={ingested_for_channel}/{MAX_INGEST_PER_CHANNEL}")

    print("\n=== DONE ===")
    print("total_found:", total_found)
    print("total_skipped_seen:", total_skipped_seen)
    print("total_no_transcript:", total_no_transcript)
    print("total_ingested:", total_ingested)
    print("total_failed:", total_failed)

    # IMPORTANT: Don't hard-fail GitHub Actions just because some videos had no transcripts.
    # If you WANT to fail when nothing ingests, change this to raise SystemExit(...)
    if total_ingested == 0:
        print("WARNING: No videos ingested (likely no captions available on recent uploads).")


if __name__ == "__main__":
    main()

import os, json, time, requests
from youtube_transcript_api import YouTubeTranscriptApi

YT_KEY = os.environ["YOUTUBE_API_KEY"]
WORKER_INGEST_URL = os.environ["WORKER_INGEST_URL"]   # https://.../api/ingest/youtube
WORKER_API_KEY = os.environ["WORKER_API_KEY"]         # simple secret
UNIVERSE_PATH = "data/universe.json"


def yt_search(query, max_results=10):
    url = "https://www.googleapis.com/youtube/v3/search"
    params = {
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": max_results,
        "key": YT_KEY,
        "order": "date",
    }
    r = requests.get(url, params=params, timeout=30)
    # Helpful debug if YT key/quota/search fails
    if r.status_code != 200:
        print("YT_SEARCH_ERROR:", r.status_code, r.text[:500])
    r.raise_for_status()
    return r.json()


def worker_seen(video_id):
    # Derive worker base from ingest URL
    base = WORKER_INGEST_URL.replace("/api/ingest/youtube", "")
    seen_url = f"{base}/api/youtube/seen?video_id={video_id}"

    r = requests.get(
        seen_url,
        headers={"x-api-key": WORKER_API_KEY},
        timeout=20,
    )

    # If auth/route/worker error, print it (previously this was silent)
    if r.status_code != 200:
        print("SEEN_CHECK_ERROR:", video_id, r.status_code, r.text[:300])
        return False

    try:
        data = r.json()
    except Exception as e:
        print("SEEN_CHECK_BAD_JSON:", video_id, str(e), r.text[:300])
        return False

    return data.get("seen") is True


def ingest(video_id, title, channel, published_at, symbol):
    # Transcript fetch (often the #1 failure point)
    segs = YouTubeTranscriptApi.get_transcript(video_id)

    payload = {
        "video_id": video_id,
        "title": title or "",
        "channel": channel or "",
        "published_at": published_at or "",
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "symbol_tags": [symbol],
        "segments": [
            {"start": s["start"], "duration": s.get("duration", 0), "text": s["text"]}
            for s in segs
        ],
    }

    r = requests.post(
        WORKER_INGEST_URL,
        headers={"content-type": "application/json", "x-api-key": WORKER_API_KEY},
        data=json.dumps(payload),
        timeout=60,
    )

    # If worker rejects / errors, print it (previously this was silent)
    if r.status_code != 200:
        print("INGEST_WORKER_ERROR:", symbol, video_id, r.status_code, r.text[:500])

    r.raise_for_status()
    print("INGEST_OK:", symbol, video_id, (title or "")[:80])


def main():
    # Make sure universe loads (GitHub Actions working dir matters)
    with open(UNIVERSE_PATH, "r", encoding="utf-8") as f:
        uni = json.load(f)

    total_found = 0
    total_skipped_seen = 0
    total_ingested = 0
    total_failed = 0

    # Local dedupe within this run (search queries overlap a lot)
    seen_in_run = set()

    for symbol, meta in uni.items():
        queries = meta.get("queries", []) or []
        if not queries:
            continue

        print(f"\n=== {symbol} ({meta.get('name','')}) | queries={len(queries)} ===")

        for q in queries:
            try:
                data = yt_search(q, max_results=8)
            except Exception as e:
                total_failed += 1
                print("YT_SEARCH_FAILED:", symbol, q, str(e))
                continue

            items = data.get("items", []) or []
            print(f"Query: {q} -> {len(items)} items")

            for item in items:
                # Defensive parsing
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
                    # worker_seen already logs; keep going
                    print("SEEN_CHECK_EXCEPTION:", symbol, vid, str(e))

                try:
                    ingest(
                        vid,
                        snip.get("title"),
                        snip.get("channelTitle"),
                        snip.get("publishedAt"),
                        symbol,
                    )
                    total_ingested += 1
                    time.sleep(0.2)
                except Exception as e:
                    total_failed += 1
                    # Now we log instead of silently ignoring
                    print("INGEST_FAILED:", symbol, vid, str(e))

    print("\n=== DONE ===")
    print("total_found:", total_found)
    print("total_skipped_seen:", total_skipped_seen)
    print("total_ingested:", total_ingested)
    print("total_failed:", total_failed)


if __name__ == "__main__":
    main()

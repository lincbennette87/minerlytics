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
        "order": "date"
    }
    return requests.get(url, params=params, timeout=30).json()

def worker_seen(video_id):
    r = requests.get(
        f"{WORKER_INGEST_URL.replace('/api/ingest/youtube','')}/api/youtube/seen?video_id={video_id}",
        headers={"x-api-key": WORKER_API_KEY},
        timeout=20
    )
    return r.status_code == 200 and r.json().get("seen") is True

def ingest(video_id, title, channel, published_at, symbol):
    segs = YouTubeTranscriptApi.get_transcript(video_id)
    payload = {
        "video_id": video_id,
        "title": title or "",
        "channel": channel or "",
        "published_at": published_at or "",
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "symbol_tags": [symbol],
        "segments": [{"start": s["start"], "duration": s.get("duration", 0), "text": s["text"]} for s in segs]
    }
    r = requests.post(
        WORKER_INGEST_URL,
        headers={"content-type": "application/json", "x-api-key": WORKER_API_KEY},
        data=json.dumps(payload),
        timeout=60
    )
    r.raise_for_status()

def main():
    uni = json.load(open(UNIVERSE_PATH))
    for symbol, meta in uni.items():
        for q in meta.get("queries", []):
            data = yt_search(q, max_results=8)
            for item in data.get("items", []):
                vid = item["id"]["videoId"]
                snip = item["snippet"]
                if worker_seen(vid):
                    continue
                try:
                    ingest(vid, snip.get("title"), snip.get("channelTitle"), snip.get("publishedAt"), symbol)
                    time.sleep(0.2)
                except Exception:
                    # ignore videos without transcripts / blocked / etc.
                    pass

if __name__ == "__main__":
    main()

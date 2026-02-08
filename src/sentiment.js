const POS = [
  "beat","beats","record","surge","surges","rally","rallies","upgrade","upgraded","strong","strength",
  "profit","profits","positive","higher","growth","raises guidance","outperform","buy"
];

const NEG = [
  "miss","misses","downgrade","downgraded","lawsuit","dilution","offering","plunge","plunges",
  "weak","weaker","loss","losses","negative","lower","cut guidance","bankrupt","bankruptcy","sell"
];

export function headlineSentiment(title) {
  const t = (title || "").toLowerCase();
  let p = 0, n = 0;
  for (const w of POS) if (t.includes(w)) p++;
  for (const w of NEG) if (t.includes(w)) n++;
  if (p === 0 && n === 0) return "neutral";
  if (p > n) return "bullish";
  if (n > p) return "bearish";
  return "neutral";
}

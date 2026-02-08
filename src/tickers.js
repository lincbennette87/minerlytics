export const TICKERS = {
  AEM: { name: "Agnico Eagle Mines", q: '(AEM OR "Agnico Eagle") (stock OR shares OR earnings OR mining)' },
  PZG: { name: "Paramount Gold Nevada", q: '(PZG OR "Paramount Gold") (stock OR shares OR mining)' },
  GAYMF: { name: "GAYMF", q: '(GAYMF) (stock OR shares OR mining)' },
  GFI: { name: "Gold Fields", q: '(GFI OR "Gold Fields") (stock OR shares OR earnings OR mining)' },
  DSVSF: { name: "DSVSF", q: '(DSVSF) (stock OR shares OR mining)' },

  HYMC: { name: "Hycroft Mining", q: '(HYMC OR "Hycroft") (stock OR mining OR dilution OR earnings)' },
  CDE: { name: "Coeur Mining", q: '(CDE OR "Coeur Mining") (stock OR mining OR earnings)' },
  WPM: { name: "Wheaton Precious Metals", q: '(WPM OR "Wheaton Precious Metals") (stock OR earnings)' },
  HL: { name: "Hecla Mining", q: '(HL OR "Hecla Mining") (stock OR mining OR earnings)' },
  SLVR: { name: "SLVR", q: '(SLVR) (stock OR mining OR silver)' },

  PSLV: { name: "Sprott Physical Silver Trust", q: '(PSLV OR "Sprott Physical Silver") (ETF OR fund OR silver)' },
  SIL:  { name: "Global X Silver Miners ETF", q: '(SIL OR "Global X Silver Miners") (ETF OR fund OR holdings)' },
  SILJ: { name: "Amplify Junior Silver Miners ETF", q: '(SILJ OR "Junior Silver Miners") (ETF OR fund OR holdings)' },
  SIVR: { name: "abrdn Physical Silver Shares", q: '(SIVR OR "abrdn Physical Silver") (ETF OR fund OR silver)' },
  SLV:  { name: "iShares Silver Trust", q: '(SLV OR "iShares Silver Trust") (ETF OR fund OR silver)' }
};

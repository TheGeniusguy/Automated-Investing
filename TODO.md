# TODO

Outstanding work for Automated-Investing. Organized by priority. Tick `[x]`
as items ship; add new ones at the bottom of their section.

---

## 0. Setup (one-time, unlocks live data)

- [ ] **Register a free FRED API key**
      → https://fredaccount.stlouisfed.org/apikeys (takes ~30 seconds)
- [ ] **Add `ANTHROPIC_API_KEY`** to `.env`
      → https://console.anthropic.com/
- [ ] **Create `.env`** if it doesn't exist:
  ```bash
  cp .env.example .env
  # then edit FRED_API_KEY and ANTHROPIC_API_KEY
  ```
- [ ] **Restart backend** after setting keys; macro tiles + Claude briefing
      + chat all light up.

Without keys, the terminal still runs in degraded mode: yfinance + EDGAR
flow live, but FRED macro tiles show `—` and Claude surfaces show
"configure key" messages.

---

## 1. High-impact data expansions

- [ ] **EIA Open Data API** (free key) for per-region energy intelligence:
      Permian/Bakken/Eagle Ford production, rig counts, refinery utilization
      by PADD, electricity generation by source
- [ ] **BLS API direct integration** for state-/MSA-level employment,
      industry-level wages, occupation data
- [ ] **Treasury Direct fiscal data**: auctions calendar, foreign-held
      Treasury debt, daily Treasury statement
- [ ] **CoinGecko crypto depth**: top-250 coins, DeFi TVL, fear/greed
      index, funding rates
- [ ] **Census Bureau API**: advance retail sales, construction spending,
      housing characteristics
- [ ] **FINRA short interest** (biweekly): days-to-cover, squeeze candidates

## 2. Intelligence layer improvements

- [ ] **APScheduler daily refresh** of all 130 FRED series so the macro
      explorer opens instantly
- [ ] **Pre-compute daily briefing** at 7am local — wakes up ready to read
      with coffee
- [ ] **News + sentiment persisted to DuckDB** → trend lines of per-ticker
      sentiment over weeks/months
- [ ] **Insider transaction analytics**: aggregate Form 4 buys/sells per
      ticker over rolling windows, detect insider clusters
- [ ] **13F institutional positioning panel**: every fund manager's
      quarterly holdings disclosure (free via EDGAR)
- [ ] **Historical pattern detection**: "find regimes like today's" across
      the accumulated macro history in DuckDB
- [ ] **Macro nowcasting composite**: combine CFNAI + ISM + employment +
      retail into a real-time GDP-tracking gauge
- [ ] **Leading indicator dashboard**: yield curve / claims / housing
      starts / consumer sentiment — the classic recession trifecta

## 3. New panels worth building

- [ ] **Sector Rotation panel**: relative strength across the 11 XL*
      sectors over 1m / 3m / 6m / 1y windows
- [ ] **Earnings Season Heat Map**: calendar grid showing all S&P
      companies' earnings dates with surprise + reaction visualization
- [ ] **Technical Indicators** layer: RSI, MACD, Bollinger, MA crossovers
      computed locally from `prices_daily`
- [ ] **Single-Ticker "Why is X moving?"** analyzer: pulls today's price
      action + sector move + news + filings → Claude one-paragraph synthesis
- [ ] **Screener**: SQL over DuckDB — "stocks with revenue YoY > 25%,
      gross margin > 50%, no insider sales in 90d"
- [ ] **Trade Journal**: persist decisions + theses, pattern-match own
      thinking over time
- [ ] **Calendar Aggregator**: earnings + economic releases + Fed meetings
      + dividend ex-dates in one timeline

## 4. Productionization

- [ ] **Custom watchlists** beyond hardcoded defaults — per-user storage
- [ ] **Alerts engine**: push to OS notifications / Slack / email when
      regime changes, correlation breaks, material 8-K, etc.
- [ ] **Mobile companion**: daily briefing email or PWA so the terminal
      works on phone
- [ ] **Authentication** if ever multi-user
- [ ] **Cloud deploy** option (Docker / fly.io / Render) for non-local
      access
- [ ] **HMM regime model** (gated on NBER validation per design doc) —
      upgrade from the current rule-based 3-state classifier

## 5. Polish / nice-to-haves

- [ ] Code-split the frontend bundle (current ~530KB → smaller chunks)
- [ ] Per-tile drill-down chart in the Macro Explorer (full TradingView
      chart for any FRED series, not just the sparkline)
- [ ] Save & restore panel layout per user
- [ ] Dark/light theme toggle (currently dark only by design)
- [ ] Keyboard shortcuts for common navigation
- [ ] Export panel snapshots as PNG / share links

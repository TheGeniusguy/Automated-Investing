"""ETF tracking dashboard engine (Feature D).

Builds a per-ETF view (name, performance over trailing windows, expense ratio,
AUM, yield, top sector exposures, top holdings, tracking error vs SPY, beta),
PLUS a pairwise holdings-overlap matrix across the tracked ETFs and a set of
normalized growth curves (base 100).

Live path: prices via app.data.macro_data.fetch_arbitrary_ticker, metadata via
yfinance .info / .funds_data (guarded). When a live source is unavailable we
degrade to rich, realistic SAMPLE data held in clearly-named SAMPLE_ETF_*
constants so the panel is fully populated for screenshots. This module never
raises - it always returns a populated payload and tags it with
data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import cache
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

BENCHMARK = "SPY"
TRADING_DAYS = 252
MIN_POINTS = 20
ETF_TTL = 60 * 30  # 30 minutes - metadata + curves move slowly

# Trailing-window lengths (in trading days) used for the perf grid.
PERF_WINDOWS = {"1M": 21, "3M": 63, "6M": 126, "1Y": 252}


# ---------------------------------------------------------------------------
# SAMPLE data (clearly namespaced). Realistic as of recent market conditions.
# expense_ratio / dividend_yield are decimal fractions (yfinance convention).
# aum is in raw dollars. ann_return / ann_vol drive the synthetic price walk.
# ---------------------------------------------------------------------------

SAMPLE_ETF_META: dict[str, dict] = {
    "SPY": {"name": "SPDR S&P 500 ETF Trust", "expense_ratio": 0.000945, "aum": 555_000_000_000, "dividend_yield": 0.0125, "beta": 1.00, "ann_return": 0.105, "ann_vol": 0.150},
    "VOO": {"name": "Vanguard S&P 500 ETF", "expense_ratio": 0.0003, "aum": 490_000_000_000, "dividend_yield": 0.0130, "beta": 1.00, "ann_return": 0.106, "ann_vol": 0.150},
    "IVV": {"name": "iShares Core S&P 500 ETF", "expense_ratio": 0.0003, "aum": 480_000_000_000, "dividend_yield": 0.0128, "beta": 1.00, "ann_return": 0.106, "ann_vol": 0.150},
    "VTI": {"name": "Vanguard Total Stock Market ETF", "expense_ratio": 0.0003, "aum": 410_000_000_000, "dividend_yield": 0.0132, "beta": 1.02, "ann_return": 0.103, "ann_vol": 0.155},
    "QQQ": {"name": "Invesco QQQ Trust", "expense_ratio": 0.0020, "aum": 290_000_000_000, "dividend_yield": 0.0058, "beta": 1.17, "ann_return": 0.150, "ann_vol": 0.205},
    "QQQM": {"name": "Invesco NASDAQ 100 ETF", "expense_ratio": 0.0015, "aum": 38_000_000_000, "dividend_yield": 0.0061, "beta": 1.17, "ann_return": 0.150, "ann_vol": 0.205},
    "DIA": {"name": "SPDR Dow Jones Industrial Average ETF", "expense_ratio": 0.0016, "aum": 38_000_000_000, "dividend_yield": 0.0170, "beta": 0.95, "ann_return": 0.088, "ann_vol": 0.140},
    "IWM": {"name": "iShares Russell 2000 ETF", "expense_ratio": 0.0019, "aum": 68_000_000_000, "dividend_yield": 0.0130, "beta": 1.18, "ann_return": 0.075, "ann_vol": 0.215},
    "IJR": {"name": "iShares Core S&P Small-Cap ETF", "expense_ratio": 0.0006, "aum": 88_000_000_000, "dividend_yield": 0.0155, "beta": 1.15, "ann_return": 0.082, "ann_vol": 0.205},
    "VUG": {"name": "Vanguard Growth ETF", "expense_ratio": 0.0004, "aum": 150_000_000_000, "dividend_yield": 0.0045, "beta": 1.12, "ann_return": 0.140, "ann_vol": 0.195},
    "VTV": {"name": "Vanguard Value ETF", "expense_ratio": 0.0004, "aum": 130_000_000_000, "dividend_yield": 0.0220, "beta": 0.88, "ann_return": 0.082, "ann_vol": 0.135},
    "SCHD": {"name": "Schwab US Dividend Equity ETF", "expense_ratio": 0.0006, "aum": 68_000_000_000, "dividend_yield": 0.0360, "beta": 0.82, "ann_return": 0.078, "ann_vol": 0.140},
    "ARKK": {"name": "ARK Innovation ETF", "expense_ratio": 0.0075, "aum": 6_000_000_000, "dividend_yield": 0.0000, "beta": 1.55, "ann_return": 0.060, "ann_vol": 0.420},
    "XLK": {"name": "Technology Select Sector SPDR Fund", "expense_ratio": 0.0009, "aum": 72_000_000_000, "dividend_yield": 0.0065, "beta": 1.20, "ann_return": 0.165, "ann_vol": 0.220},
    "XLF": {"name": "Financial Select Sector SPDR Fund", "expense_ratio": 0.0009, "aum": 48_000_000_000, "dividend_yield": 0.0155, "beta": 1.05, "ann_return": 0.105, "ann_vol": 0.180},
    "XLE": {"name": "Energy Select Sector SPDR Fund", "expense_ratio": 0.0009, "aum": 38_000_000_000, "dividend_yield": 0.0330, "beta": 0.85, "ann_return": 0.070, "ann_vol": 0.260},
    "GLD": {"name": "SPDR Gold Shares", "expense_ratio": 0.0040, "aum": 78_000_000_000, "dividend_yield": 0.0000, "beta": 0.10, "ann_return": 0.090, "ann_vol": 0.135},
    "TLT": {"name": "iShares 20+ Year Treasury Bond ETF", "expense_ratio": 0.0015, "aum": 52_000_000_000, "dividend_yield": 0.0410, "beta": -0.25, "ann_return": 0.020, "ann_vol": 0.155},
    "EFA": {"name": "iShares MSCI EAFE ETF", "expense_ratio": 0.0033, "aum": 58_000_000_000, "dividend_yield": 0.0290, "beta": 0.88, "ann_return": 0.070, "ann_vol": 0.160},
    "EEM": {"name": "iShares MSCI Emerging Markets ETF", "expense_ratio": 0.0070, "aum": 18_000_000_000, "dividend_yield": 0.0260, "beta": 0.95, "ann_return": 0.055, "ann_vol": 0.195},
}

# Top holdings per ETF: list of {symbol, name, weight} (weight in percent).
SAMPLE_ETF_HOLDINGS: dict[str, list[dict]] = {
    "SPY": [
        {"symbol": "AAPL", "name": "Apple Inc.", "weight": 7.1},
        {"symbol": "MSFT", "name": "Microsoft Corp.", "weight": 6.5},
        {"symbol": "NVDA", "name": "NVIDIA Corp.", "weight": 6.2},
        {"symbol": "AMZN", "name": "Amazon.com Inc.", "weight": 3.6},
        {"symbol": "META", "name": "Meta Platforms Inc.", "weight": 2.5},
        {"symbol": "GOOGL", "name": "Alphabet Inc. Class A", "weight": 2.1},
        {"symbol": "AVGO", "name": "Broadcom Inc.", "weight": 1.8},
        {"symbol": "GOOG", "name": "Alphabet Inc. Class C", "weight": 1.7},
        {"symbol": "TSLA", "name": "Tesla Inc.", "weight": 1.6},
        {"symbol": "BRK.B", "name": "Berkshire Hathaway Inc.", "weight": 1.6},
    ],
    "QQQ": [
        {"symbol": "AAPL", "name": "Apple Inc.", "weight": 8.9},
        {"symbol": "MSFT", "name": "Microsoft Corp.", "weight": 8.1},
        {"symbol": "NVDA", "name": "NVIDIA Corp.", "weight": 7.8},
        {"symbol": "AMZN", "name": "Amazon.com Inc.", "weight": 5.2},
        {"symbol": "AVGO", "name": "Broadcom Inc.", "weight": 4.7},
        {"symbol": "META", "name": "Meta Platforms Inc.", "weight": 4.6},
        {"symbol": "TSLA", "name": "Tesla Inc.", "weight": 3.1},
        {"symbol": "GOOGL", "name": "Alphabet Inc. Class A", "weight": 2.6},
        {"symbol": "GOOG", "name": "Alphabet Inc. Class C", "weight": 2.5},
        {"symbol": "COST", "name": "Costco Wholesale Corp.", "weight": 2.5},
    ],
    "DIA": [
        {"symbol": "UNH", "name": "UnitedHealth Group Inc.", "weight": 8.6},
        {"symbol": "GS", "name": "Goldman Sachs Group Inc.", "weight": 7.3},
        {"symbol": "MSFT", "name": "Microsoft Corp.", "weight": 6.4},
        {"symbol": "HD", "name": "Home Depot Inc.", "weight": 6.0},
        {"symbol": "CAT", "name": "Caterpillar Inc.", "weight": 5.6},
        {"symbol": "CRM", "name": "Salesforce Inc.", "weight": 5.1},
        {"symbol": "V", "name": "Visa Inc.", "weight": 4.6},
        {"symbol": "AXP", "name": "American Express Co.", "weight": 4.4},
        {"symbol": "AMGN", "name": "Amgen Inc.", "weight": 4.3},
        {"symbol": "MCD", "name": "McDonald's Corp.", "weight": 4.1},
    ],
    "IWM": [
        {"symbol": "FTAI", "name": "FTAI Aviation Ltd.", "weight": 0.55},
        {"symbol": "SFM", "name": "Sprouts Farmers Market Inc.", "weight": 0.48},
        {"symbol": "INSM", "name": "Insmed Inc.", "weight": 0.45},
        {"symbol": "FLR", "name": "Fluor Corp.", "weight": 0.40},
        {"symbol": "VKTX", "name": "Viking Therapeutics Inc.", "weight": 0.38},
        {"symbol": "MLI", "name": "Mueller Industries Inc.", "weight": 0.36},
        {"symbol": "ANF", "name": "Abercrombie & Fitch Co.", "weight": 0.34},
        {"symbol": "RBC", "name": "RBC Bearings Inc.", "weight": 0.33},
        {"symbol": "SSB", "name": "SouthState Corp.", "weight": 0.32},
        {"symbol": "CRS", "name": "Carpenter Technology Corp.", "weight": 0.31},
    ],
    "VTI": [
        {"symbol": "AAPL", "name": "Apple Inc.", "weight": 6.2},
        {"symbol": "MSFT", "name": "Microsoft Corp.", "weight": 5.7},
        {"symbol": "NVDA", "name": "NVIDIA Corp.", "weight": 5.4},
        {"symbol": "AMZN", "name": "Amazon.com Inc.", "weight": 3.1},
        {"symbol": "META", "name": "Meta Platforms Inc.", "weight": 2.2},
        {"symbol": "GOOGL", "name": "Alphabet Inc. Class A", "weight": 1.8},
        {"symbol": "AVGO", "name": "Broadcom Inc.", "weight": 1.6},
        {"symbol": "GOOG", "name": "Alphabet Inc. Class C", "weight": 1.5},
        {"symbol": "TSLA", "name": "Tesla Inc.", "weight": 1.4},
        {"symbol": "BRK.B", "name": "Berkshire Hathaway Inc.", "weight": 1.3},
    ],
    "XLK": [
        {"symbol": "NVDA", "name": "NVIDIA Corp.", "weight": 14.8},
        {"symbol": "AAPL", "name": "Apple Inc.", "weight": 13.9},
        {"symbol": "MSFT", "name": "Microsoft Corp.", "weight": 12.7},
        {"symbol": "AVGO", "name": "Broadcom Inc.", "weight": 4.6},
        {"symbol": "CRM", "name": "Salesforce Inc.", "weight": 2.7},
        {"symbol": "ORCL", "name": "Oracle Corp.", "weight": 2.6},
        {"symbol": "AMD", "name": "Advanced Micro Devices Inc.", "weight": 2.4},
        {"symbol": "ADBE", "name": "Adobe Inc.", "weight": 2.2},
        {"symbol": "ACN", "name": "Accenture Plc", "weight": 2.1},
        {"symbol": "QCOM", "name": "Qualcomm Inc.", "weight": 1.9},
    ],
}

# Sector exposures per ETF: list of {sector, weight} (weight in percent).
SAMPLE_ETF_SECTORS: dict[str, list[dict]] = {
    "SPY": [
        {"sector": "Technology", "weight": 31.5},
        {"sector": "Financials", "weight": 13.1},
        {"sector": "Health Care", "weight": 11.2},
        {"sector": "Consumer Discretionary", "weight": 10.3},
        {"sector": "Communication Services", "weight": 9.2},
        {"sector": "Industrials", "weight": 8.4},
        {"sector": "Consumer Staples", "weight": 5.9},
        {"sector": "Energy", "weight": 3.6},
    ],
    "QQQ": [
        {"sector": "Technology", "weight": 50.6},
        {"sector": "Communication Services", "weight": 16.1},
        {"sector": "Consumer Discretionary", "weight": 13.8},
        {"sector": "Health Care", "weight": 6.2},
        {"sector": "Consumer Staples", "weight": 4.9},
        {"sector": "Industrials", "weight": 4.5},
    ],
    "DIA": [
        {"sector": "Financials", "weight": 22.4},
        {"sector": "Health Care", "weight": 18.1},
        {"sector": "Technology", "weight": 17.6},
        {"sector": "Industrials", "weight": 14.2},
        {"sector": "Consumer Discretionary", "weight": 13.5},
        {"sector": "Consumer Staples", "weight": 7.3},
        {"sector": "Energy", "weight": 3.1},
    ],
    "IWM": [
        {"sector": "Financials", "weight": 17.4},
        {"sector": "Industrials", "weight": 16.2},
        {"sector": "Health Care", "weight": 15.1},
        {"sector": "Technology", "weight": 13.2},
        {"sector": "Consumer Discretionary", "weight": 10.8},
        {"sector": "Energy", "weight": 6.9},
        {"sector": "Real Estate", "weight": 6.1},
        {"sector": "Materials", "weight": 4.6},
    ],
    "VTI": [
        {"sector": "Technology", "weight": 30.1},
        {"sector": "Financials", "weight": 13.4},
        {"sector": "Health Care", "weight": 11.6},
        {"sector": "Consumer Discretionary", "weight": 10.4},
        {"sector": "Industrials", "weight": 9.3},
        {"sector": "Communication Services", "weight": 8.4},
        {"sector": "Consumer Staples", "weight": 5.4},
        {"sector": "Energy", "weight": 3.8},
    ],
    "XLK": [
        {"sector": "Technology", "weight": 99.5},
        {"sector": "Communication Services", "weight": 0.5},
    ],
}

# Generic sector mixes for symbols without a bespoke breakdown above.
SAMPLE_SECTORS_BROAD = SAMPLE_ETF_SECTORS["SPY"]
SAMPLE_SECTORS_GROWTH = [
    {"sector": "Technology", "weight": 48.2},
    {"sector": "Consumer Discretionary", "weight": 19.6},
    {"sector": "Communication Services", "weight": 13.1},
    {"sector": "Industrials", "weight": 7.2},
    {"sector": "Health Care", "weight": 6.4},
    {"sector": "Financials", "weight": 3.1},
]
SAMPLE_SECTORS_VALUE = [
    {"sector": "Financials", "weight": 21.3},
    {"sector": "Health Care", "weight": 18.7},
    {"sector": "Industrials", "weight": 13.4},
    {"sector": "Consumer Staples", "weight": 10.9},
    {"sector": "Energy", "weight": 8.1},
    {"sector": "Utilities", "weight": 6.8},
    {"sector": "Technology", "weight": 6.2},
]


# ---------------------------------------------------------------------------
# Sample price-curve synthesis (deterministic per symbol, market-correlated)
# ---------------------------------------------------------------------------

def _seed(symbol: str) -> int:
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _sample_dates(days: int) -> list[str]:
    """Generate `days` trading-day date strings ending today (weekdays only)."""
    out: list[str] = []
    d = date.today()
    while len(out) < days + 1:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _market_returns(n: int) -> np.ndarray:
    """Shared synthetic market (SPY) daily returns - fixed seed for stability."""
    rng = np.random.default_rng(20260601)
    meta = SAMPLE_ETF_META["SPY"]
    mu = meta["ann_return"] / TRADING_DAYS
    sig = meta["ann_vol"] / np.sqrt(TRADING_DAYS)
    return rng.normal(mu, sig, n)


def _sample_returns(symbol: str, market_rets: np.ndarray) -> np.ndarray:
    """ETF daily returns built off the market: beta exposure + idiosyncratic
    noise scaled so total vol matches the symbol's sample profile."""
    meta = SAMPLE_ETF_META.get(symbol, {"beta": 1.0, "ann_return": 0.08, "ann_vol": 0.18})
    beta = float(meta["beta"])
    mkt_vol = SAMPLE_ETF_META["SPY"]["ann_vol"] / np.sqrt(TRADING_DAYS)
    total_var = (meta["ann_vol"] / np.sqrt(TRADING_DAYS)) ** 2
    idio_var = max(total_var - (beta * mkt_vol) ** 2, (0.02 / np.sqrt(TRADING_DAYS)) ** 2)
    rng = np.random.default_rng(_seed(symbol))
    idio = rng.normal(0.0, np.sqrt(idio_var), len(market_rets))
    # alpha so the realized annual drift lands near the symbol's target return
    target_daily = meta["ann_return"] / TRADING_DAYS
    alpha = target_daily - beta * float(np.mean(market_rets))
    return alpha + beta * market_rets + idio


def _sample_prices(symbol: str, market_rets: np.ndarray, base: float = 100.0) -> np.ndarray:
    rets = _sample_returns(symbol, market_rets)
    return base * np.cumprod(1.0 + np.concatenate([[0.0], rets]))


# ---------------------------------------------------------------------------
# Live price + metadata helpers
# ---------------------------------------------------------------------------

def _fetch_prices(symbol: str, days: int) -> dict[str, float]:
    pts = fetch_arbitrary_ticker(symbol, days=days + 5)
    return {p["date"]: float(p["value"]) for p in pts if p.get("value") is not None}


def _live_meta(symbol: str) -> dict:
    """Best-effort yfinance metadata. Returns only the fields it could resolve;
    callers merge over the SAMPLE defaults. Never raises."""
    out: dict = {}
    try:
        import yfinance as yf
        t = yf.Ticker(symbol)
        info = {}
        try:
            info = t.info or {}
        except Exception:
            info = {}

        name = info.get("longName") or info.get("shortName")
        if name:
            out["name"] = name
        # yfinance unit quirk: annualReportExpenseRatio is a fraction (0.000945),
        # but netExpenseRatio is in percent (0.0945 = 0.0945%). Normalize to a
        # decimal fraction to match the SAMPLE convention.
        if info.get("annualReportExpenseRatio") is not None:
            out["expense_ratio"] = float(info["annualReportExpenseRatio"])
        elif info.get("netExpenseRatio") is not None:
            out["expense_ratio"] = float(info["netExpenseRatio"]) / 100.0
        aum = info.get("totalAssets")
        if aum is not None:
            out["aum"] = float(aum)
        # Same quirk: 'yield' is a fraction (0.0098), 'dividendYield' is percent (0.98).
        if info.get("yield") is not None:
            out["dividend_yield"] = float(info["yield"])
        elif info.get("dividendYield") is not None:
            out["dividend_yield"] = float(info["dividendYield"]) / 100.0
        beta = info.get("beta3Year") or info.get("beta")
        if beta is not None:
            out["beta_reported"] = float(beta)

        # funds_data carries sector weightings + top holdings for ETFs
        try:
            fd = t.funds_data
            sw = getattr(fd, "sector_weightings", None)
            if isinstance(sw, dict) and sw:
                sectors = [
                    {"sector": str(k).replace("_", " ").title(), "weight": round(float(v) * 100, 2)}
                    for k, v in sw.items() if v
                ]
                sectors.sort(key=lambda x: x["weight"], reverse=True)
                if sectors:
                    out["sectors"] = sectors[:10]
            th = getattr(fd, "top_holdings", None)
            if th is not None and getattr(th, "empty", True) is False:
                holds: list[dict] = []
                for sym, row in th.iterrows():
                    w = row.get("Holding Percent")
                    holds.append({
                        "symbol": str(sym),
                        "name": str(row.get("Name", sym)),
                        "weight": round(float(w) * 100, 3) if w is not None else None,
                    })
                if holds:
                    out["holdings"] = holds[:10]
        except Exception:
            pass
    except Exception as e:
        log.warning("yfinance metadata failed for %s: %s", symbol, e)
    return out


# ---------------------------------------------------------------------------
# Metric computation
# ---------------------------------------------------------------------------

def _rolling_perf(dates: list[str], prices: list[float]) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    n = len(prices)
    for key, w in PERF_WINDOWS.items():
        if n >= w + 1 and prices[-(w + 1)]:
            out[key] = round(float(prices[-1] / prices[-(w + 1)] - 1) * 100, 3)
        else:
            out[key] = None
    # YTD
    jan1 = str(date(date.today().year, 1, 1))
    ytd = [(d, p) for d, p in zip(dates, prices) if d >= jan1 and p]
    out["YTD"] = round(float(ytd[-1][1] / ytd[0][1] - 1) * 100, 3) if len(ytd) >= 2 and ytd[0][1] else None
    # ALL (full window shown)
    out["ALL"] = round(float(prices[-1] / prices[0] - 1) * 100, 3) if n >= 2 and prices[0] else None
    return out


def _returns(prices: np.ndarray) -> np.ndarray:
    return np.diff(prices) / prices[:-1]


def _beta_te(etf_prices: np.ndarray, bench_prices: np.ndarray) -> tuple[float | None, float | None]:
    """Return (beta_vs_SPY, tracking_error_pct) on aligned price arrays."""
    if len(etf_prices) != len(bench_prices) or len(etf_prices) < MIN_POINTS:
        return None, None
    r = _returns(etf_prices)
    b = _returns(bench_prices)
    if len(r) < MIN_POINTS:
        return None, None
    var_b = float(np.var(b, ddof=1))
    beta = float(np.cov(r, b, ddof=1)[0, 1] / var_b) if var_b > 0 else None
    te = float(np.std(r - b, ddof=1) * np.sqrt(TRADING_DAYS) * 100)
    return (round(beta, 4) if beta is not None else None), round(te, 4)


def _overlap_matrix(symbols: list[str], holdings: dict[str, list[dict]]) -> list[list[float]]:
    """Pairwise holdings overlap: sum of min(weight_a, weight_b) over shared
    holdings, expressed in percent (0-100). Diagonal is 100."""
    n = len(symbols)
    mat = [[0.0] * n for _ in range(n)]
    weight_maps: dict[str, dict[str, float]] = {}
    for s in symbols:
        weight_maps[s] = {h["symbol"]: float(h.get("weight") or 0.0) for h in holdings.get(s, [])}
    for i, si in enumerate(symbols):
        mat[i][i] = 100.0
        for j in range(i + 1, n):
            sj = symbols[j]
            wa, wb = weight_maps[si], weight_maps[sj]
            shared = set(wa) & set(wb)
            ov = round(sum(min(wa[k], wb[k]) for k in shared), 3)
            mat[i][j] = ov
            mat[j][i] = ov
    return mat


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def track_etfs(symbols: list[str], days: int = 365) -> dict:
    """Track a basket of ETFs. See module docstring for the full contract.

    Never raises - degrades to SAMPLE data and tags the payload with
    data_mode / as_of / source.
    """
    try:
        return _track_etfs(symbols, days)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("track_etfs failed hard, returning sample: %s", e)
        return _track_etfs_sample([s.upper() for s in (symbols or ["SPY", "QQQ", "IWM", "DIA"])], days)


def _track_etfs(symbols: list[str], days: int) -> dict:
    symbols = [s.strip().upper() for s in symbols if s and s.strip()]
    if not symbols:
        symbols = ["SPY", "QQQ", "IWM", "DIA"]
    # de-dupe, preserve order
    symbols = list(dict.fromkeys(symbols))

    cache_key = f"etf_track:{','.join(symbols)}:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    # --- Attempt live prices for every symbol + the SPY benchmark ---
    fetch_set = list(dict.fromkeys([*symbols, BENCHMARK]))
    prices_map: dict[str, dict[str, float]] = {}
    for sym in fetch_set:
        try:
            prices_map[sym] = _fetch_prices(sym, days)
        except Exception:
            prices_map[sym] = {}

    date_sets = [set(prices_map[s]) for s in fetch_set if prices_map.get(s)]
    common = sorted(set.intersection(*date_sets)) if len(date_sets) == len(fetch_set) else []
    if len(common) > days:
        common = common[-days:]

    live_ok = (
        len(common) >= MIN_POINTS
        and all(prices_map.get(s) for s in fetch_set)
        and all(all(prices_map[s].get(d) is not None for d in common) for s in fetch_set)
    )

    if not live_ok:
        result = _track_etfs_sample(symbols, days)
        cache.set(cache_key, result, ETF_TTL)
        return result

    # --- LIVE path ---
    bench_arr = np.array([prices_map[BENCHMARK][d] for d in common], dtype=float)

    etfs: dict[str, dict] = {}
    curves_series: dict[str, list[float]] = {}
    holdings_for_overlap: dict[str, list[dict]] = {}

    for sym in symbols:
        arr = np.array([prices_map[sym][d] for d in common], dtype=float)
        base = arr[0]
        curves_series[sym] = [round(float(p / base * 100), 4) for p in arr] if base else []

        beta, te = _beta_te(arr, bench_arr)
        if sym == BENCHMARK:
            te = 0.0

        meta = _build_meta(sym, beta)
        holdings_for_overlap[sym] = meta["holdings"]
        etfs[sym] = {
            "symbol": sym,
            "name": meta["name"],
            "perf": _rolling_perf(common, list(arr)),
            "expense_ratio": meta["expense_ratio"],
            "expense_ratio_pct": _pct(meta["expense_ratio"]),
            "aum": meta["aum"],
            "aum_display": _humanize_aum(meta["aum"]),
            "yield": meta["dividend_yield"],
            "yield_pct": _pct(meta["dividend_yield"]),
            "sectors": meta["sectors"],
            "holdings": meta["holdings"],
            "tracking_error": te,
            "beta": beta if beta is not None else meta["beta"],
            "data_mode": meta["data_mode"],
        }

    payload = _assemble(symbols, common, curves_series, etfs, holdings_for_overlap,
                        days, data_mode="live", source="yfinance")
    cache.set(cache_key, payload, ETF_TTL)
    return payload


def _track_etfs_sample(symbols: list[str], days: int) -> dict:
    symbols = list(dict.fromkeys([s.strip().upper() for s in symbols if s and s.strip()])) or ["SPY", "QQQ", "IWM", "DIA"]
    dates = _sample_dates(days)
    n = len(dates) - 1
    market = _market_returns(n)
    bench_arr = _sample_prices(BENCHMARK, market)

    etfs: dict[str, dict] = {}
    curves_series: dict[str, list[float]] = {}
    holdings_for_overlap: dict[str, list[dict]] = {}

    for sym in symbols:
        arr = _sample_prices(sym, market)
        curves_series[sym] = [round(float(p / arr[0] * 100), 4) for p in arr]
        beta, te = _beta_te(arr, bench_arr)
        if sym == BENCHMARK:
            te = 0.0
        meta = _sample_meta(sym)
        holdings_for_overlap[sym] = meta["holdings"]
        etfs[sym] = {
            "symbol": sym,
            "name": meta["name"],
            "perf": _rolling_perf(dates, list(arr)),
            "expense_ratio": meta["expense_ratio"],
            "expense_ratio_pct": _pct(meta["expense_ratio"]),
            "aum": meta["aum"],
            "aum_display": _humanize_aum(meta["aum"]),
            "yield": meta["dividend_yield"],
            "yield_pct": _pct(meta["dividend_yield"]),
            "sectors": meta["sectors"],
            "holdings": meta["holdings"],
            "tracking_error": te if sym != BENCHMARK else 0.0,
            "beta": beta if beta is not None else meta["beta"],
            "data_mode": "sample",
        }

    return _assemble(symbols, dates, curves_series, etfs, holdings_for_overlap,
                     days, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Metadata assembly
# ---------------------------------------------------------------------------

def _sample_meta(symbol: str) -> dict:
    base = SAMPLE_ETF_META.get(symbol)
    if base is None:
        base = {"name": f"{symbol} ETF", "expense_ratio": 0.0035, "aum": 5_000_000_000,
                "dividend_yield": 0.015, "beta": 1.0, "ann_return": 0.08, "ann_vol": 0.18}
    sectors = SAMPLE_ETF_SECTORS.get(symbol)
    if sectors is None:
        b = base["beta"]
        sectors = SAMPLE_SECTORS_GROWTH if b >= 1.1 else (SAMPLE_SECTORS_VALUE if b <= 0.9 else SAMPLE_SECTORS_BROAD)
    holdings = SAMPLE_ETF_HOLDINGS.get(symbol, SAMPLE_ETF_HOLDINGS["SPY"])
    return {
        "name": base["name"],
        "expense_ratio": base["expense_ratio"],
        "aum": base["aum"],
        "dividend_yield": base["dividend_yield"],
        "beta": base["beta"],
        "sectors": sectors,
        "holdings": holdings,
    }


def _build_meta(symbol: str, computed_beta: float | None) -> dict:
    """Sample defaults overlaid with any live yfinance fields. Per-field data_mode
    collapses to 'live' only when at least one core live field resolved."""
    meta = _sample_meta(symbol)
    meta["data_mode"] = "sample"
    live = _live_meta(symbol)
    if live:
        for k in ("name", "expense_ratio", "aum", "dividend_yield", "sectors", "holdings"):
            if live.get(k):
                meta[k] = live[k]
        if "beta_reported" in live:
            meta["beta"] = live["beta_reported"]
        # consider it 'live' if any of the substantive financial fields came back
        if any(live.get(k) is not None for k in ("expense_ratio", "aum", "dividend_yield", "sectors", "holdings")):
            meta["data_mode"] = "live"
    if computed_beta is not None:
        meta["beta"] = computed_beta
    return meta


# ---------------------------------------------------------------------------
# Formatting + final assembly
# ---------------------------------------------------------------------------

def _pct(decimal_value: float | None) -> float | None:
    return round(float(decimal_value) * 100, 4) if decimal_value is not None else None


def _humanize_aum(aum: float | None) -> str | None:
    if aum is None:
        return None
    a = float(aum)
    if a >= 1e12:
        return f"${a / 1e12:.2f}T"
    if a >= 1e9:
        return f"${a / 1e9:.1f}B"
    if a >= 1e6:
        return f"${a / 1e6:.1f}M"
    return f"${a:,.0f}"


def _assemble(symbols, dates, curves_series, etfs, holdings_for_overlap,
              days, *, data_mode, source) -> dict:
    overlap = _overlap_matrix(symbols, holdings_for_overlap)
    return {
        "symbols": symbols,
        "benchmark": BENCHMARK,
        "days": days,
        "data_points": len(dates),
        "etfs": etfs,
        "curves": {
            "dates": dates,
            "series": curves_series,
        },
        "overlap_matrix": {
            "labels": symbols,
            "matrix": overlap,
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }

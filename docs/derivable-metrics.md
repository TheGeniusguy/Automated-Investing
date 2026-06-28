# Derivable Metrics - Validation Report

This is the validation deliverable for Feature A: a catalog of every analytics
metric the system can compute from data it already has, grouped by category,
with the formula and the existing data source / endpoint that feeds it.

The core idea: the system already ships one universal price entrypoint and
several derived statistics modules. Any metric that can be expressed as a
function of a daily return series (and optionally a benchmark series) is
therefore derivable today, with no new data dependencies.

## Existing data foundation

Every metric below is built from data the repo already produces:

| Source | What it gives us | Where it lives |
| --- | --- | --- |
| `fetch_arbitrary_ticker(ticker, days)` | Daily close price history for any symbol or index (sqlite-cached, yfinance fallback, >2y date-range switch). The universal price entrypoint. | `app/data/macro_data.py` |
| `fetch_series(series, days)` | FRED macro series (e.g. `DGS3MO` 3-month T-bill for the risk-free rate). | `app/data/macro_data.py` |
| `build_equity_curve(transactions, initial_cash, lookback_days)` | Daily portfolio NAV series + normalized benchmark curves (SPY, QQQ). | `app/portfolio/analytics.py` |
| `compute_performance_metrics(...)` | Existing first-tier stats: Sharpe, Sortino, Calmar, alpha/beta/R2, max drawdown, rolling returns. | `app/portfolio/analytics.py` |
| `compute_portfolio_risk(...)` | VaR/CVaR, portfolio vol, per-position betas, correlation matrix, factor OLS exposures, Herfindahl. | `app/portfolio/risk.py` |
| `compare_tickers(...)` | ETF/ticker comparison: normalized curves, up/down capture, monthly heatmap, factor exposures. | `app/etf/compare.py` |
| `compute_positions(transactions)` | FIFO lots, realized P&L, cash delta - source of any holdings-derived series. | `app/portfolio/positions.py` |

A daily return series is `r_t = (P_t - P_{t-1}) / P_{t-1}` derived from any of
the price/NAV sources above. A benchmark series (default SPY) is the same
transform on `fetch_arbitrary_ticker("SPY", days)`. The risk-free rate comes
from the FRED `DGS3MO` series (falls back to 5 percent when no FRED key).

## Feature A endpoint

`compute_extended_metrics(returns, benchmark_returns=None, rf_annual=0.0, periods_per_year=252)`
in `app/portfolio/metrics_ext.py` computes all of the metrics in the
"Extended (newly implemented)" tables below. `validate_available_metrics()` in
the same module returns this catalog as structured data. Both are exposed via:

- `GET /api/analytics/advanced?symbol=SPY&benchmark=SPY&days=756` - builds the
  subject + benchmark return series via `fetch_arbitrary_ticker` and returns
  the full metric set plus the rolling Sharpe series.
- `GET /api/analytics/catalog` - returns `validate_available_metrics()`.

Notation used throughout: `r` = subject daily returns, `b` = benchmark daily
returns, `rf` = per-period risk-free rate, `ppy` = periods per year (252),
`std(.., ddof=1)` = sample standard deviation, `prod` = product over the
series, `cummax` = running maximum.

---

## Extended (newly implemented in metrics_ext.py)

### Return

| Key | Name | Formula | Inputs (existing source) |
| --- | --- | --- | --- |
| `cagr` | CAGR | `prod(1 + r)**(ppy / n) - 1` | return series from `fetch_arbitrary_ticker` / `build_equity_curve` |
| `ann_vol` | Annualized volatility | `std(r, ddof=1) * sqrt(ppy)` | same return series |

### Risk-Adjusted

| Key | Name | Formula | Inputs (existing source) |
| --- | --- | --- | --- |
| `information_ratio` | Information ratio | `mean(r - b) * ppy / (std(r - b, ddof=1) * sqrt(ppy))` | subject + benchmark (`fetch_arbitrary_ticker("SPY")`) |
| `treynor_ratio` | Treynor ratio | `(cagr - rf_annual) / beta`, `beta = cov(r,b)/var(b)` | subject + benchmark + `DGS3MO` rf |
| `omega_ratio` | Omega ratio (T=0) | `sum(max(r - T, 0)) / sum(max(T - r, 0))`, `T = 0` | return series |
| `martin_ratio` | Martin ratio (UPI) | `(cagr * 100) / ulcer_index` | return series |
| `gain_to_pain` | Gain-to-pain ratio | `sum(r) / sum(|r| for r < 0)` | return series |
| `common_sense_ratio` | Common sense ratio | `tail_ratio * gain_to_pain` | return series |
| `kelly_fraction` | Kelly fraction | `mean(r) / var(r)` | return series |

### Drawdown

| Key | Name | Formula | Inputs (existing source) |
| --- | --- | --- | --- |
| `ulcer_index` | Ulcer index | `sqrt(mean(drawdown_pct**2))`, `drawdown = (equity - cummax)/cummax` | return series |
| `max_drawdown` | Maximum drawdown | `min((equity - cummax(equity)) / cummax(equity))` | return series (mirrors `compute_performance_metrics` max DD) |
| `max_drawdown_duration_days` | Max drawdown duration | longest consecutive run with `drawdown < 0` | return series |
| `recovery_days` | Recovery days | periods from the max-drawdown trough to a new equity high | return series |

### Distribution

| Key | Name | Formula | Inputs (existing source) |
| --- | --- | --- | --- |
| `skew` | Skewness (bias-corrected) | `n/((n-1)(n-2)) * sum(((r-mean)/std)**3)` | return series |
| `kurtosis` | Excess kurtosis (bias-corrected) | `(n+1)n/((n-1)(n-2)(n-3)) * sum(z**4) - 3(n-1)**2/((n-2)(n-3))` | return series |
| `tail_ratio` | Tail ratio | `percentile(r, 95) / |percentile(r, 5)|` | return series |
| `downside_deviation` | Downside deviation | `sqrt(mean(min(r - rf, 0)**2)) * sqrt(ppy)` | return series + `DGS3MO` rf |

### Capture

| Key | Name | Formula | Inputs (existing source) |
| --- | --- | --- | --- |
| `upside_capture` | Upside capture ratio | `(prod(1+r | b>0) - 1) / (prod(1+b | b>0) - 1)` | subject + benchmark series |
| `downside_capture` | Downside capture ratio | `(prod(1+r | b<0) - 1) / (prod(1+b | b<0) - 1)` | subject + benchmark series |

### Time Series

| Key | Name | Formula | Inputs (existing source) |
| --- | --- | --- | --- |
| `rolling_sharpe` | Rolling Sharpe (63d) | per window: `mean(r - rf) / std(r - rf, ddof=1) * sqrt(ppy)` | return series + `DGS3MO` rf |

---

## Already shipped (derivable, computed elsewhere)

These metrics are also derivable from the same data and are already produced by
existing modules. Listed here for a complete validation picture so the catalog
does not double-count them.

### Risk-Adjusted (analytics.py)

| Name | Formula | Source endpoint |
| --- | --- | --- |
| Sharpe ratio | `mean(r - rf) / std(r - rf, ddof=1) * sqrt(ppy)` | `GET /api/portfolio/{id}/performance` |
| Sortino ratio | `(ann_return - rf) / (sqrt(mean(min(r-rf,0)**2)) * sqrt(ppy))` | `GET /api/portfolio/{id}/performance` |
| Calmar ratio | `(ann_return - rf) / |max_drawdown|` | `GET /api/portfolio/{id}/performance` |
| Alpha / Beta / R2 | OLS of portfolio returns on SPY via `lstsq` | `GET /api/portfolio/{id}/performance` |
| Tracking error | `std(r - b, ddof=1) * sqrt(ppy)` | `GET /api/portfolio/{id}/performance` |
| Win rate vs SPY | `mean(r > b) * 100` | `GET /api/portfolio/{id}/performance` |
| Rolling returns (1d..all, YTD) | window price ratios on NAV vs SPY/QQQ | `GET /api/portfolio/{id}/performance` |

### Risk (risk.py)

| Name | Formula | Source endpoint |
| --- | --- | --- |
| VaR 95 / 99 (daily, annual) | empirical `percentile(port_ret, 1-conf)` | `GET /api/portfolio/{id}/risk` |
| CVaR 95 / 99 | `mean(r <= VaR_threshold)` | `GET /api/portfolio/{id}/risk` |
| Portfolio volatility | `std(port_ret, ddof=1) * sqrt(ppy)` | `GET /api/portfolio/{id}/risk` |
| Per-position beta | `cov(asset, SPY) / var(SPY)` | `GET /api/portfolio/{id}/risk` |
| Correlation matrix | pairwise Pearson `corrcoef` | `GET /api/portfolio/{id}/risk` |
| Factor exposures (6 ETFs) | OLS betas to SPY/QQQ/IWM/HYG/GLD/TLT | `GET /api/portfolio/{id}/risk` |
| Concentration (Herfindahl, top3, max) | `sum(w**2)`, `sum(sort(w)[:3])`, `max(w)` | `GET /api/portfolio/{id}/risk` |

### ETF comparison (etf/compare.py)

| Name | Formula | Source endpoint |
| --- | --- | --- |
| Up / down capture ratio | geometric capture on benchmark up/down days | `GET /api/etf/compare?symbols=...` |
| Monthly returns heatmap | calendar-month compounded returns | `GET /api/etf/compare?symbols=...` |
| 16 per-ticker metrics | CAGR, vol, Sharpe, Sortino, max DD, beta/alpha, etc. | `GET /api/etf/compare?symbols=...` |

### Fundamentals / income (fundamentals.py, dividends.py)

| Name | Source | Source endpoint |
| --- | --- | --- |
| 25 fundamental fields (PE, margins, growth, ROE, yield) | yfinance `.info` mapping | `GET /api/portfolio/{id}/fundamentals` |
| Dividend income, yield, monthly projection | computed from enriched positions | `GET /api/portfolio/{id}/dividends` |

---

## Summary

Feature A adds 20 catalog metrics (19 scalars + the rolling Sharpe series),
all of which are pure functions of return series the system already fetches.
No new pip dependencies and no new data sources are required - every formula
above resolves to data already available through `fetch_arbitrary_ticker`,
`fetch_series` (FRED risk-free), and the existing portfolio / risk / ETF
modules. This confirms the "what else can be calculated" scope: the catalog is
complete with respect to single-series and benchmark-relative statistics
derivable from the current data foundation.

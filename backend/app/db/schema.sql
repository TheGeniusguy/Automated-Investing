-- Automated-Investing DuckDB schema.
-- All tables are idempotent (CREATE IF NOT EXISTS). Indexes follow the
-- access patterns of the API: by symbol + date for prices/fundamentals,
-- by symbol for instruments lookups.

-- The universe table. Bootstrapped from SEC EDGAR (~13k US filers) plus
-- whatever non-SEC symbols (ETFs, futures, crypto) we ingest on demand.
CREATE TABLE IF NOT EXISTS instruments (
    symbol         VARCHAR PRIMARY KEY,
    cik            VARCHAR,                 -- SEC CIK if known
    name           VARCHAR,
    type           VARCHAR,                 -- equity | etf | future | crypto | index | unknown
    exchange       VARCHAR,
    sector         VARCHAR,
    industry       VARCHAR,
    country        VARCHAR,
    currency       VARCHAR,
    source         VARCHAR,                 -- edgar | yfinance | manual
    metadata       JSON,
    first_seen_at  TIMESTAMP DEFAULT current_timestamp,
    last_seen_at   TIMESTAMP DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS instruments_name_idx ON instruments(name);
CREATE INDEX IF NOT EXISTS instruments_cik_idx  ON instruments(cik);
CREATE INDEX IF NOT EXISTS instruments_type_idx ON instruments(type);


-- Daily OHLCV bars. (symbol, date) PK; backfilled from yfinance.
CREATE TABLE IF NOT EXISTS prices_daily (
    symbol      VARCHAR,
    date        DATE,
    open        DOUBLE,
    high        DOUBLE,
    low         DOUBLE,
    close       DOUBLE,
    adj_close   DOUBLE,
    volume      BIGINT,
    source      VARCHAR DEFAULT 'yfinance',
    ingested_at TIMESTAMP DEFAULT current_timestamp,
    PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS prices_daily_date_idx ON prices_daily(date);


-- Quarterly fundamentals. We persist a wide row per (symbol, period_end).
-- Period_end is the fiscal quarter end; period_label is "Q1 FY24" style.
CREATE TABLE IF NOT EXISTS fundamentals_quarterly (
    symbol           VARCHAR,
    period_end       DATE,
    period_label     VARCHAR,
    -- Income statement
    revenue          DOUBLE,
    gross_profit     DOUBLE,
    operating_income DOUBLE,
    net_income       DOUBLE,
    eps_basic        DOUBLE,
    eps_diluted      DOUBLE,
    -- Balance sheet
    total_assets       DOUBLE,
    total_liabilities  DOUBLE,
    total_equity       DOUBLE,
    cash_and_equiv     DOUBLE,
    long_term_debt     DOUBLE,
    -- Cash flow
    operating_cash_flow  DOUBLE,
    capex                DOUBLE,
    free_cash_flow       DOUBLE,
    -- Derived margins (computed when revenue is non-zero)
    gross_margin     DOUBLE,
    operating_margin DOUBLE,
    net_margin       DOUBLE,
    -- Metadata
    source           VARCHAR DEFAULT 'yfinance',
    ingested_at      TIMESTAMP DEFAULT current_timestamp,
    PRIMARY KEY (symbol, period_end)
);


-- Corporate actions (splits, dividends).
CREATE TABLE IF NOT EXISTS corporate_actions (
    symbol      VARCHAR,
    date        DATE,
    action_type VARCHAR,                    -- split | dividend
    value       DOUBLE,                     -- split ratio (e.g., 4.0 for 4:1) or dividend per share
    source      VARCHAR DEFAULT 'yfinance',
    ingested_at TIMESTAMP DEFAULT current_timestamp,
    PRIMARY KEY (symbol, date, action_type)
);


-- Macro time series (FRED-style). One row per (series_id, date).
-- We keep this separate from prices_daily because units/scale vary wildly.
CREATE TABLE IF NOT EXISTS macro_series_history (
    series_id   VARCHAR,
    date        DATE,
    value       DOUBLE,
    source      VARCHAR DEFAULT 'fred',
    ingested_at TIMESTAMP DEFAULT current_timestamp,
    PRIMARY KEY (series_id, date)
);


-- Archive of SEC filings we've seen. Allows us to detect new filings since
-- last fetch and to compute insider-trading aggregates over time.
CREATE TABLE IF NOT EXISTS filings_archive (
    symbol       VARCHAR,
    cik          VARCHAR,
    accession    VARCHAR,
    form         VARCHAR,
    filing_date  DATE,
    report_date  DATE,
    description  VARCHAR,
    items        VARCHAR,
    url          VARCHAR,
    archived_at  TIMESTAMP DEFAULT current_timestamp,
    PRIMARY KEY (accession)
);

CREATE INDEX IF NOT EXISTS filings_symbol_date_idx ON filings_archive(symbol, filing_date);


-- ETL run history — what ran, when, how long, what it touched.
CREATE SEQUENCE IF NOT EXISTS etl_runs_id_seq START 1;

CREATE TABLE IF NOT EXISTS etl_runs (
    id           BIGINT DEFAULT nextval('etl_runs_id_seq'),
    source       VARCHAR,                   -- universe | prices | fundamentals | actions | filings | macro
    started_at   TIMESTAMP DEFAULT current_timestamp,
    completed_at TIMESTAMP,
    status       VARCHAR,                   -- running | ok | error
    rows_in      BIGINT DEFAULT 0,
    rows_out     BIGINT DEFAULT 0,
    target       VARCHAR,                   -- the symbol(s) or scope of this run
    note         VARCHAR,                   -- error message or summary
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS etl_runs_source_idx ON etl_runs(source, started_at);


-- Daily briefings (Panel 10) — one row per (date, briefing_kind).
-- Persisted so the panel can show today's brief instantly + scroll history.
CREATE TABLE IF NOT EXISTS daily_briefings (
    date         DATE,
    kind         VARCHAR,                   -- 'morning' | 'on_demand'
    regime_label VARCHAR,
    summary      VARCHAR,                   -- Claude-authored markdown briefing
    context_json JSON,                      -- structured context fed to Claude
    generated_at TIMESTAMP DEFAULT now(),
    source       VARCHAR DEFAULT 'claude',
    PRIMARY KEY (date, kind)
);

CREATE INDEX IF NOT EXISTS daily_briefings_date_idx ON daily_briefings(date);


-- Multi-watchlist support (replaces the singleton JSON file model for the UI).
-- The legacy watchlist.py + watchlist.json is still the default fallback for
-- downstream panels until they migrate to picking an "active" DB watchlist.
CREATE SEQUENCE IF NOT EXISTS watchlists_id_seq START 1;

CREATE TABLE IF NOT EXISTS watchlists (
    id          BIGINT DEFAULT nextval('watchlists_id_seq'),
    name        VARCHAR NOT NULL,
    description VARCHAR,
    is_default  BOOLEAN DEFAULT false,
    created_at  TIMESTAMP DEFAULT now(),
    updated_at  TIMESTAMP DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS watchlist_items (
    watchlist_id BIGINT NOT NULL REFERENCES watchlists(id),
    ticker       VARCHAR NOT NULL,
    label        VARCHAR,
    group_name   VARCHAR,
    order_index  INTEGER DEFAULT 0,
    added_at     TIMESTAMP DEFAULT now(),
    PRIMARY KEY (watchlist_id, ticker)
);

CREATE INDEX IF NOT EXISTS watchlist_items_order_idx
    ON watchlist_items(watchlist_id, order_index);


-- Trade journal — broker decisions + theses for Wave 3 (kept here as part of
-- the persistent analytical store; populated by the Trade Journal panel).
CREATE SEQUENCE IF NOT EXISTS trade_journal_id_seq START 1;

CREATE TABLE IF NOT EXISTS trade_journal (
    id         BIGINT DEFAULT nextval('trade_journal_id_seq'),
    entry_date DATE NOT NULL,
    ticker     VARCHAR,
    action     VARCHAR,                      -- buy | sell | watch | thesis | post-mortem
    thesis     VARCHAR,
    notes      VARCHAR,
    outcome    VARCHAR,                      -- positive | negative | neutral | open
    tags       VARCHAR,                      -- comma-separated
    created_at TIMESTAMP DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS trade_journal_date_idx
    ON trade_journal(entry_date);
CREATE INDEX IF NOT EXISTS trade_journal_ticker_idx
    ON trade_journal(ticker, entry_date);


-- Chart drawings — TradingView-style trend lines, fibs, rectangles, etc.
-- One row per drawing, scoped to (symbol, timeframe). Points are stored
-- in a JSON array of {time, price} pairs in the order they were drawn.
-- Style carries color, line width, dash, fill, opacity, label.
CREATE SEQUENCE IF NOT EXISTS chart_drawings_id_seq START 1;

CREATE TABLE IF NOT EXISTS chart_drawings (
    id           BIGINT DEFAULT nextval('chart_drawings_id_seq'),
    symbol       VARCHAR NOT NULL,
    timeframe    VARCHAR NOT NULL DEFAULT '1d',
    drawing_type VARCHAR NOT NULL,            -- trend_line | hline | vline | fib_retracement | rectangle | text
    points       JSON NOT NULL,               -- [{time:..., price:...}, ...]
    style        JSON DEFAULT '{}',           -- {color, line_width, line_style, fill, opacity}
    label        VARCHAR,
    created_at   TIMESTAMP DEFAULT now(),
    updated_at   TIMESTAMP DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS chart_drawings_symbol_idx
    ON chart_drawings(symbol, timeframe);


-- Chart layouts — persists per (symbol, timeframe) the enabled indicators,
-- chart type, scale type, indicator param overrides, comparison symbol, etc.
-- One layout row per (symbol, timeframe).
CREATE TABLE IF NOT EXISTS chart_layouts (
    symbol         VARCHAR NOT NULL,
    timeframe      VARCHAR NOT NULL DEFAULT '1d',
    state          JSON NOT NULL DEFAULT '{}',
    updated_at     TIMESTAMP DEFAULT now(),
    PRIMARY KEY (symbol, timeframe)
);


-- ----------------------------------------------------------------------
-- Wave 5: Macro pinboards — user-defined dashboards of FRED series.
-- ----------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS macro_boards_id_seq START 1;

CREATE TABLE IF NOT EXISTS macro_boards (
    id           BIGINT DEFAULT nextval('macro_boards_id_seq'),
    name         VARCHAR NOT NULL,
    description  VARCHAR,
    series_ids   JSON DEFAULT '[]',           -- ["DGS10", "VIX", ...]
    created_at   TIMESTAMP DEFAULT now(),
    updated_at   TIMESTAMP DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS macro_boards_name_idx ON macro_boards(name);


-- ----------------------------------------------------------------------
-- Insider Transactions (SEC Form 4) — parsed from EDGAR XML.
-- One row per transaction line (a single Form 4 can contain multiple).
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insider_transactions (
    accession       VARCHAR NOT NULL,
    symbol          VARCHAR NOT NULL,
    cik             VARCHAR,
    insider_name    VARCHAR,
    insider_title   VARCHAR,          -- CEO, CFO, Director, 10% Owner, etc.
    is_director     BOOLEAN DEFAULT false,
    is_officer      BOOLEAN DEFAULT false,
    is_ten_pct      BOOLEAN DEFAULT false,
    txn_date        DATE,
    txn_code        VARCHAR,          -- P=purchase, S=sale, A=award, M=exercise, ...
    shares          DOUBLE,
    price_per_share DOUBLE,
    total_value     DOUBLE,
    shares_after    DOUBLE,           -- shares owned after this txn
    ownership_type  VARCHAR,          -- D=direct, I=indirect
    filing_date     DATE,
    form_type       VARCHAR DEFAULT '4',
    source_url      VARCHAR,
    ingested_at     TIMESTAMP DEFAULT now(),
    PRIMARY KEY (accession, symbol, insider_name, txn_date, txn_code, shares)
);

CREATE INDEX IF NOT EXISTS insider_txn_symbol_idx
    ON insider_transactions(symbol, txn_date);
CREATE INDEX IF NOT EXISTS insider_txn_date_idx
    ON insider_transactions(txn_date);
CREATE INDEX IF NOT EXISTS insider_txn_code_idx
    ON insider_transactions(symbol, txn_code);


-- ----------------------------------------------------------------------
-- 13F Institutional Holdings — quarterly positions from SEC 13F-HR filings.
-- One row per (filer CIK, symbol, report_date).
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institutional_holdings (
    filer_cik       VARCHAR NOT NULL,
    filer_name      VARCHAR,
    symbol          VARCHAR NOT NULL,
    cusip           VARCHAR,
    name_of_issuer  VARCHAR,
    share_class     VARCHAR,          -- COM, CL A, CL B, etc.
    shares          BIGINT,
    value_x1000     BIGINT,           -- market value in $1000s (as filed)
    put_call        VARCHAR,          -- PUT, CALL, or NULL for shares
    investment_discretion VARCHAR,    -- SOLE, SHARED, DEFINED
    voting_sole     BIGINT,
    voting_shared   BIGINT,
    voting_none     BIGINT,
    report_date     DATE,             -- quarter end the 13F covers
    filing_date     DATE,             -- when actually filed
    accession       VARCHAR,
    ingested_at     TIMESTAMP DEFAULT now(),
    PRIMARY KEY (filer_cik, symbol, report_date, accession)
);

CREATE INDEX IF NOT EXISTS inst_holdings_symbol_idx
    ON institutional_holdings(symbol, report_date);
CREATE INDEX IF NOT EXISTS inst_holdings_filer_idx
    ON institutional_holdings(filer_cik, report_date);


-- ----------------------------------------------------------------------
-- Portfolio tracker (paper trading / position tracking)
-- Positions are computed on-the-fly from the transaction log (FIFO).
-- ----------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS user_portfolios_id_seq START 1;

CREATE TABLE IF NOT EXISTS user_portfolios (
    id           BIGINT DEFAULT nextval('user_portfolios_id_seq'),
    name         VARCHAR NOT NULL,
    description  VARCHAR,
    cash_balance DOUBLE DEFAULT 0.0,
    created_at   TIMESTAMP DEFAULT now(),
    updated_at   TIMESTAMP DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (name)
);

CREATE SEQUENCE IF NOT EXISTS portfolio_transactions_id_seq START 1;

CREATE TABLE IF NOT EXISTS portfolio_transactions (
    id           BIGINT DEFAULT nextval('portfolio_transactions_id_seq'),
    portfolio_id BIGINT NOT NULL,
    symbol       VARCHAR NOT NULL,
    trade_date   DATE NOT NULL,
    trade_type   VARCHAR NOT NULL,   -- buy | sell | dividend | deposit | withdrawal
    quantity     DOUBLE NOT NULL,
    price        DOUBLE NOT NULL,    -- per-share for buy/sell; total amount for others
    commission   DOUBLE DEFAULT 0.0,
    notes        VARCHAR,
    created_at   TIMESTAMP DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    portfolio_id     BIGINT NOT NULL,
    snapshot_date    DATE NOT NULL,
    total_value      DOUBLE NOT NULL,
    cash_balance     DOUBLE NOT NULL,
    invested_value   DOUBLE NOT NULL,
    total_cost_basis DOUBLE NOT NULL,
    unrealized_pl    DOUBLE NOT NULL,
    realized_pl      DOUBLE NOT NULL,
    PRIMARY KEY (portfolio_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_ptxn_portfolio ON portfolio_transactions(portfolio_id, trade_date);
CREATE INDEX IF NOT EXISTS idx_ptxn_symbol    ON portfolio_transactions(symbol, trade_date);

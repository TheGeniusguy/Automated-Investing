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

"""Alerts engine package.

Self-contained DuckDB-backed alert rules + a triggered-events log. See
``app.alerts.engine`` for the public API consumed by main.py.
"""
from . import engine  # noqa: F401

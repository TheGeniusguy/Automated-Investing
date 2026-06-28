"""IB-level pro forma modeling package.

Public surface:
  build_three_statement(inputs)  -> linked IS / BS / CF projection
  run_dcf(inputs)                -> unlevered DCF + dual TV + sensitivity grid
  build_comps(peers)             -> trading comps + implied valuation
  run_scenario(inputs)           -> base/bull/bear + tornado
  proforma_overview(ticker=None) -> runs all four (sample default, live seed)
"""
from __future__ import annotations

from .model import (
    build_comps,
    build_three_statement,
    proforma_overview,
    run_dcf,
    run_scenario,
)

__all__ = [
    "build_three_statement",
    "run_dcf",
    "build_comps",
    "run_scenario",
    "proforma_overview",
]

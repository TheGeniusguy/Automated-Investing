"""Static supply chain / sector adjacency map.

Defines upstream (inputs), downstream (outputs), and correlated sectors
for each of the 15 sectors in the terminal. Purely editorial -- no live data.

Each entry:
  upstream:   sectors that supply inputs to this one
  downstream: sectors that consume this sector's outputs
  correlated: sectors that tend to move together (macro/sentiment linkage)
  notes:      brief explanation of the key dependencies
"""
from __future__ import annotations

SUPPLY_CHAIN: dict[str, dict] = {
    "technology": {
        "upstream":   ["semiconductors", "materials", "industrials"],
        "downstream": ["consumer_discretionary", "communication_services", "financials"],
        "correlated": ["defense_aerospace", "biotech"],
        "notes": "Semis supply compute; tech exports software/cloud to all sectors.",
    },
    "semiconductors": {
        "upstream":   ["materials", "oil_gas", "industrials"],
        "downstream": ["technology", "consumer_discretionary", "industrials", "clean_energy"],
        "correlated": ["technology", "clean_energy"],
        "notes": "Chips power every digital device. Energy-intensive fabs depend on utilities.",
    },
    "real_estate": {
        "upstream":   ["materials", "industrials", "utilities", "financials"],
        "downstream": ["consumer_discretionary", "consumer_staples"],
        "correlated": ["financials", "utilities"],
        "notes": "Construction draws on materials + industrials. REITs priced vs bond yields.",
    },
    "oil_gas": {
        "upstream":   ["industrials", "materials"],
        "downstream": ["consumer_staples", "industrials", "utilities", "materials"],
        "correlated": ["materials", "clean_energy"],
        "notes": "Feedstock for plastics/chemicals (materials), fuel for transport/power.",
    },
    "financials": {
        "upstream":   ["technology", "utilities"],
        "downstream": ["real_estate", "consumer_discretionary", "industrials"],
        "correlated": ["real_estate", "consumer_discretionary"],
        "notes": "Credit conditions ripple through every capital-intensive sector.",
    },
    "healthcare": {
        "upstream":   ["materials", "technology", "biotech"],
        "downstream": ["consumer_staples"],
        "correlated": ["biotech", "consumer_staples"],
        "notes": "Pharma chemicals from materials; genomics tools from tech.",
    },
    "biotech": {
        "upstream":   ["materials", "technology"],
        "downstream": ["healthcare"],
        "correlated": ["healthcare", "technology"],
        "notes": "Lab chemicals + AI drug discovery tools enable pipeline R&D.",
    },
    "consumer_discretionary": {
        "upstream":   ["consumer_staples", "industrials", "technology"],
        "downstream": [],
        "correlated": ["financials", "communication_services"],
        "notes": "End-consumer sector. Logistics (industrials) and credit (financials) are key enablers.",
    },
    "industrials": {
        "upstream":   ["materials", "oil_gas", "technology"],
        "downstream": ["consumer_discretionary", "defense_aerospace", "real_estate"],
        "correlated": ["materials", "oil_gas"],
        "notes": "Manufacturing hub. Steel from materials, power from energy, automation from tech.",
    },
    "consumer_staples": {
        "upstream":   ["materials", "industrials", "oil_gas"],
        "downstream": [],
        "correlated": ["utilities", "healthcare"],
        "notes": "Packaging from materials, logistics from industrials. Defensive proxy like utilities.",
    },
    "utilities": {
        "upstream":   ["oil_gas", "materials", "industrials", "clean_energy"],
        "downstream": ["industrials", "technology", "consumer_discretionary"],
        "correlated": ["real_estate", "consumer_staples"],
        "notes": "Buys fuel from O&G; grid hardware from industrials. Rate-sensitive bond proxy.",
    },
    "materials": {
        "upstream":   ["oil_gas", "industrials"],
        "downstream": ["industrials", "technology", "clean_energy", "real_estate"],
        "correlated": ["oil_gas", "industrials"],
        "notes": "Commodities (steel, copper, lithium) feed manufacturing and construction.",
    },
    "communication_services": {
        "upstream":   ["technology", "industrials"],
        "downstream": ["consumer_discretionary", "consumer_staples"],
        "correlated": ["technology", "consumer_discretionary"],
        "notes": "Cloud infrastructure from tech; ad revenue tracks consumer confidence.",
    },
    "clean_energy": {
        "upstream":   ["materials", "industrials", "technology"],
        "downstream": ["utilities", "consumer_discretionary"],
        "correlated": ["oil_gas", "utilities"],
        "notes": "Lithium + rare earths from materials. Competes with O&G on grid economics.",
    },
    "defense_aerospace": {
        "upstream":   ["industrials", "technology", "materials"],
        "downstream": [],
        "correlated": ["technology", "industrials"],
        "notes": "Complex supply chain: avionics (tech), airframes (industrials), alloys (materials).",
    },
}

SECTOR_LABELS: dict[str, str] = {
    "technology":             "Technology",
    "semiconductors":         "Semiconductors",
    "real_estate":            "Real Estate",
    "oil_gas":                "Oil & Gas",
    "financials":             "Financials",
    "healthcare":             "Healthcare",
    "biotech":                "Biotech",
    "consumer_discretionary": "Consumer Disc.",
    "industrials":            "Industrials",
    "consumer_staples":       "Consumer Staples",
    "utilities":              "Utilities",
    "materials":              "Materials",
    "communication_services": "Comm. Services",
    "clean_energy":           "Clean Energy",
    "defense_aerospace":      "Defense & Aero.",
}


def supply_chain(sector_id: str, sectors_meta: dict) -> dict:
    """Return upstream/downstream/correlated with ETF tickers attached."""
    chain = SUPPLY_CHAIN.get(sector_id)
    if chain is None:
        return {"error": f"Unknown sector: {sector_id}"}

    def _enrich(ids: list[str]) -> list[dict]:
        result = []
        for sid in ids:
            meta = sectors_meta.get(sid, {})
            result.append({
                "id":    sid,
                "name":  SECTOR_LABELS.get(sid, sid),
                "etf":   meta.get("etf", ""),
            })
        return result

    return {
        "sector_id":  sector_id,
        "upstream":   _enrich(chain["upstream"]),
        "downstream": _enrich(chain["downstream"]),
        "correlated": _enrich(chain["correlated"]),
        "notes":      chain["notes"],
    }

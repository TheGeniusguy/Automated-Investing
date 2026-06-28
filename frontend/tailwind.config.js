/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm "ink" palette - Anthropic-inspired. Re-themed by value only; the
        // token NAMES are kept so every existing class keeps working. Base is a
        // warm near-black with a brown undertone (not cold terminal black);
        // panels sit a step lighter for quiet elevation.
        terminal: {
          bg:        "#181613",
          panel:     "#211e1a",
          border:    "#2e2a24",
          divider:   "#3a352d",
          text:      "#ece7df",
          muted:     "#a39a8c",
          dim:       "#6e665a",
        },
        accent: {
          // Clay / terracotta is the signature Anthropic accent. "amber" is the
          // de-facto primary accent throughout the app, so it now carries clay.
          DEFAULT: "#c9785c",
          amber:   "#c9785c",  // clay (primary brand accent)
          green:   "#5bb97f",  // positive / up / risk-on (sage green)
          red:     "#e5564b",  // negative / down / risk-off (kept vivid + distinct from clay)
          blue:    "#6e92c4",  // muted steel blue (info)
        },
        regime: {
          on:    "#5bb97f",  // risk_on    - sage green
          off:   "#e5564b",  // risk_off   - red
          trans: "#c9785c",  // transition - clay
        },
      },
      fontFamily: {
        // UI/body grotesque (Styrene-like), editorial serif for display + large
        // figures (Tiempos-like), mono reserved for tabular number columns.
        sans:  ["Hanken Grotesk", "system-ui", "-apple-system", "sans-serif"],
        serif: ["Newsreader", "Georgia", "Cambria", "serif"],
        mono:  ["JetBrains Mono", "SF Mono", "Menlo", "Monaco", "monospace"],
      },
      fontSize: {
        "2xs": "10px",
      },
      borderRadius: {
        panel: "10px",
      },
      boxShadow: {
        panel: "0 2px 14px -4px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.35)",
      },
    },
  },
  plugins: [],
};

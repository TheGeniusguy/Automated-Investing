/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Terminal palette — dark base, amber accents, signal colors for regimes.
        terminal: {
          bg:        "#0a0a0a",
          panel:     "#111111",
          border:    "#1f1f1f",
          divider:   "#262626",
          text:      "#e5e5e5",
          muted:     "#8b8b8b",
          dim:       "#525252",
        },
        accent: {
          amber: "#ffb800",
          green: "#22c55e",
          red:   "#ef4444",
          blue:  "#3b82f6",
        },
        regime: {
          on:    "#22c55e",  // risk_on   — green
          off:   "#ef4444",  // risk_off  — red
          trans: "#ffb800",  // transition — amber
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "Monaco", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      fontSize: {
        "2xs": "10px",
      },
    },
  },
  plugins: [],
};

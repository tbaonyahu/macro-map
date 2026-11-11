# Macro Map

Personal market dashboard: watchlist, heatmaps, 3D globe, and a Buffett-style 4-rule stock screener.

## What's in here

| Path | What it is |
|---|---|
| `site/index.html` | The whole website |
| `site/watchlist.json` | The shared watchlist (download a new one from the site's Edit window to update it) |
| `site/scores.json` | Optional: scores made by `buffett_screen.py`. The site now scores stocks live, so this is just a backup |
| `netlify/functions/score.mjs` | Server code: gets SEC filings and scores one stock at `/api/score?t=NVDA` |
| `netlify.toml` | Tells Netlify where the website and server code are |

## Settings in Netlify

- **Environment variable** `SEC_EMAIL` = your email (SEC requires a contact email; it stays on the server, never on the website).

## Rules (change them in `score.mjs`)

1. Debt payoff: long-term debt ≤ 3 years of net income
2. Gross margin ≥ 40%
3. Net income > 0 in each of the last 5 fiscal years
4. ROIC ≥ 15% (after-tax operating profit ÷ (debt + equity − cash))

Passing is a shortlist, not a buy signal: the rules ignore price.

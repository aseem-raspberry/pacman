# Pac-Man × TypeSafe Jev 1.13

2D canvas Pac-Man (no frameworks, zero dependencies, no CDNs) that plays itself. Every junction decision is made by **TypeSafe Jev 1.13**, a System One structured decision model, through the OpenRouter Decisions API. A sidepane shows live Jev statistics: latency, calibrated probabilities per direction, danger estimates, confidence, token usage, and cost.

## Run

Requires Node 18+ (no npm install needed, zero dependencies).

```bash
cp .env.template .env        # put your OpenRouter key in .env
node server.mjs              # serves http://localhost:4317
```

The API key stays on the server; the browser only talks to the local proxy at `/api/decide`.

## How the AI plays

- Pac-Man moves cell to cell on a 19×21 grid.
- At every junction (2+ legal directions) the current state is sent to `POST https://openrouter.ai/api/alpha/decisions` with two questions: a `choice` (which direction next) and a `noul` (is a ghost dangerously close). Requests are routed by provider latency.
- Decisions are pre-fetched: while pacman travels a corridor, the next junction's decision is requested with an anticipated board (segment dots marked eaten, ghost positions PROJECTED forward to arrival time by simulating their movement), so the answer is usually waiting when he arrives. Typical junction wait is ~40ms even though the API takes ~400ms; the sidepane shows per-decision wait and the pre-fetch hit rate.
- The state is a local 7×7 map centered on Pac-Man (with the ghost house marked impassable), ghost distances and headings, and a per-direction corridor analysis (dots, pellets, ghost danger) embedded in the choice criteria.
- Jev returns calibrated probabilities per legal direction; the game plays a temperature-0.5 sample of those probabilities (best move usually, occasional exploration to avoid path loops).
- A deterministic rule layer re-checks the pick against live positions when it is applied (ghosts kept moving during the API round trip): a pursuit check flags paths a ghost could reach at the same time as pacman, a static safety check replaces suicide moves, and a food override replaces empty paths with equally safe, clearly richer ones (points per cell distance: frightened ghost 200 > pellet 50 > dot 10). If a ghost closes in while pacman waits, he reflex-flees without waiting for the API. Overrides and flees are shown in the sidepane and log.
- Corridors (only one legal move) skip the API; on API errors the game falls back to a random legal move.

## Files

- `server.mjs` - static server + Decisions API proxy
- `public/game.js` - 2D canvas renderer, game logic, AI controller, stats
- `public/maze.mjs` - the maze layout (shared with `validate.mjs`)
- `validate.mjs` - maze sanity checks (shape, reachability, connectivity)

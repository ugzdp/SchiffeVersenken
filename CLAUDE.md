# CLAUDE.md — Insel-Schlacht

## Project Overview

**Insel-Schlacht** is a 2D top-down naval battle game for **two players on the same
touch device** (hot-seat, iPad/iPhone via Safari, but must also work with a mouse on
desktop). Visual style: cartoon look inspired by Supercell's Boom Beach — thick dark
outlines, saturated colors, light shallow-water rings around islands, subtle water
animation.

**Tech constraints (hard requirements):**
- Plain HTML5, Canvas 2D and vanilla JavaScript (ES modules). **No frameworks, no
  build tools, no bundlers, no npm dependencies.**
- Must run as static files on **GitHub Pages** — `index.html` at the project root.
- Input via **Pointer Events** so touch and mouse both work.
- iOS Safari friendly: viewport meta tags, no zoom, no scroll, no text selection,
  fullscreen when added to home screen (web app manifest).
- All game data (islands, maps) lives in JSON files — **never hardcode level content
  in JS.**

## Game Rules (authoritative — never contradict these)

### Map generation
- There is a **library of 20–30 predefined island shapes** in `data/islands/`
  (one JSON entry per island shape).
- At game start, a map is assembled by **randomly selecting and placing islands**
  from the library, following placement rules:
  - Minimum distance between islands (no touching/overlapping).
  - The two **base islands** are special shapes (they contain a bay and/or a
    mountain to hide the base ship) and are always placed on **opposite sides**
    of the screen (Player 1 left, Player 2 right).
  - The map must remain playable: open water paths must exist.
- Once generated, the map is **static** for the whole match. Only light water
  animation plays.

### Terrain types (two layers per island)
- **Beach/forest** (yellow/green): blocks ships, but **shots fly over it**.
- **Mountain** (gray): blocks ships **and** blocks shots.
- Each island shape defines its own constellation: beach only, mountain only, or a
  combination (e.g. beach ring with a mountain core).
- Collision logic therefore differs by context:
  - Ship placement tests against the **full land shape** (beach + mountain).
  - Shot trajectories test **only against mountain shapes**.

### Ships and bases
- Each player starts with exactly **one base ship**, spawned at a **fixed
  position every match** (player 1 near the bottom-left corner, player 2 near
  the top-right) — independent of the random map, not tied to a base island's
  bay.
- The base ship is drawn with the **same hull shape** as normal ships, just
  noticeably **larger**, so it reads as "special" at a glance.
- All other ships are spawned during play (see turns). Ships never move after
  being placed.

### Turn structure (strictly alternating)
On their turn, a player does **exactly one** of two actions:

**Action A — Place a new ship (freehand drag path):**
1. The player touches **any of their own ships** (including the base ship) and
   drags a **freehand path** from it — the path strictly follows the finger,
   point by point, with **no backtracking**.
2. The path has a **maximum total length** (not straight-line distance — a
   path that wanders spends its budget faster than a direct one). Once the
   budget is spent the path **freezes** in place; further finger movement is
   ignored until release.
3. The path is allowed to be dragged across an island — it is drawn in red as
   a warning rather than being blocked — but the endpoint must end up on open
   water (not on land, not on another ship) and no segment of the path may
   cross land, or the whole drag is rejected on release (no ship spawns, the
   turn does not end, the player retries). Because the path can curve, this
   is how a ship's placement can route around an island's corner instead of
   being blocked by it.
4. On a legal release, a **new ship spawns at the end of the path**, but the
   turn does not end immediately: a small **"undo" cross** appears next to
   the new ship for about a second (`Phase.CONFIRMING_PLACEMENT`). Tapping it
   removes the ship and returns control to the same player. If it's not
   tapped, control passes to the other player either when the window's timer
   runs out, or immediately if the opponent touches one of their own ships to
   start their turn early — whichever happens first.
5. Fleets therefore grow over the match and spread across the map like a network.

**Action B — Shoot (blind shot):**
1. The player presses the **Shoot button**. Shooting mode becomes visibly active
   (e.g. red screen border).
2. The player puts a finger on **one of their own ships**. At that moment the
   **entire screen turns black** (dark overlay, near-full opacity).
3. While blind, the player must **swipe fast** in a direction. The swipe must be
   completed within a short time limit — if too slow, show a "too slow" warning
   and let the player retry (still their turn, still blind mode restarts from
   touching a ship).
4. **Swipe speed determines shot distance** (with a min and max cap). Swipe
   direction determines shot direction. So the player must blindly judge both
   direction *and* distance.
5. After the shot, the screen becomes visible again and the **shot line is drawn**
   so both players see where it went.
6. Any **enemy ship whose hitbox the shot line crosses sinks** (play a sinking
   animation, remove it from play). Shots stop at mountains; they pass over
   beach/forest and over open water.
7. A **miss, or a friendly-fire sinking of one of the shooter's own ships,
   ends the turn** as normal. **Sinking an enemy ship grants the shooter
   another turn** instead — they stay in `Phase.PLACING` and can immediately
   place a ship or shoot again.

### Win condition
- A player wins by **sinking the opponent's base ship**. Show a victory screen
  and offer a rematch (new random map).

### Open design decisions (ask the user before implementing, do not assume)
- Friendly fire (can a shot sink the shooter's own ships?)
- Whether a single shot can sink multiple ships along its line
- Exact values: max line length, shot speed-to-distance mapping, swipe time limit

## Data Model

### Island library — `data/islands/*.json`
Each island shape is one JSON file:
```json
{
  "id": "island_07",
  "type": "normal",            // "normal" | "base"
  "landShape": [[0.0, 0.1], [0.2, 0.0], ...],   // polygon, local coords 0–1
  "mountainShapes": [ [[0.3, 0.3], ...] ],      // zero or more polygons inside landShape
  "decorations": [ { "kind": "palm", "x": 0.5, "y": 0.2 } ],
  "baseAnchor": { "x": 0.15, "y": 0.5 }         // base ships spawn point, only for type "base"
}
```
- All coordinates are **relative (0–1) in the island's local space**; the map
  generator scales and positions islands, the renderer converts to screen pixels.
- `landShape` = full outline (used for ship/line collision).
- `mountainShapes` = gray zones (used for shot collision, drawn on top).

### Generated map — runtime object (and optionally saved as JSON)
```json
{
  "seed": 123456,
  "islands": [
    { "islandId": "island_07", "x": 0.42, "y": 0.31, "scale": 0.12, "rotation": 1.57 }
  ]
}
```
- Storing the `seed` makes a map reproducible.

## Architecture

```
index.html              entry point (must stay at repo root for GitHub Pages)
css/style.css
data/islands/*.json     island shape library
data/schema.md          documentation of the JSON formats
js/main.js              bootstrap: load data, set up canvas, start loop
js/data/islandLoader.js load + validate island JSONs
js/engine/              PURE game logic — no rendering, no DOM, no Canvas access
  mapGenerator.js       random map assembly with placement rules
  gameState.js          single source of truth: map, ships, current player, phase
  rules.js              constants + pure functions (collision, line-polygon
                        intersection, point-in-polygon, speed→distance)
  actions.js            placeShip(), beginPlacementConfirmation(),
                        commitPlacement(), revertPlacement(), fireShot(),
                        endTurn() — take state + input, return/mutate state,
                        never draw
js/render/              ALL drawing code
  renderer.js           ocean, islands (beach/mountain layers), ships, drag path
  effects.js            water animation, shot line, sinking animation
  ui.js                 turn indicator, shoot button, red border, black overlay,
                        warnings, victory screen
js/input.js             pointer events, routed by current game phase
```

**Separation rule:** `js/engine/` must never import from `js/render/` or touch the
DOM. The engine is the "backend", rendering is the "frontend". This keeps the door
open for a real online backend later.

**Game phases** (state machine in `gameState.js`):
`placing` → (Action A: legal path released) → `confirmingPlacement` ("undo"
cross shown) → next turn (or back to `placing`, same player, if reverted);
`placing` → `aimingShot` (button pressed) → `blindShot` (screen black) →
`shotResolve` (line shown) → next turn, unless the shot sank an enemy ship,
in which case back to `placing` for the same player instead; plus `gameover`.

## Coding Conventions

- Comment all code in **simple English**.
- Small, focused modules; pure functions in the engine wherever possible.
- No global variables except a single game instance created in `main.js`.
- Relative coordinates (0–1) in all data; convert to pixels only in the renderer.
- Test after every feature: `python3 -m http.server` and open in the browser
  (fetch() for JSON requires a server — opening index.html from the file system
  will not work).

## Workflow

- Implement **one feature per request**, keep the game runnable at every step.
- When rules above leave something open, **ask instead of assuming**.
- Priority order for remaining work: map generator with placement rules →
  ship placement (drag line) → turn switching → blind shot mechanic →
  terrain-aware shot collision → win condition → visual polish (Boom Beach look) →
  web app manifest for iPad home screen.

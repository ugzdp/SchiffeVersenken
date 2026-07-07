# Data formats

This project has two related but distinct JSON shapes: the **island library**
(static shape definitions, one file per island) and the **generated map**
(one run's random arrangement of islands, built at runtime by
`js/engine/mapGenerator.js`). See `CLAUDE.md` for the authoritative rules;
this file documents the JSON structures precisely.

## Island library — `data/islands/*.json`

Each file in `data/islands/` describes one reusable island **shape**. The map
generator picks shapes from this library and places instances of them on the
map. A shape file itself has no absolute position — it only describes the
island's own local geometry.

```json
{
  "id": "island_07",
  "type": "normal",
  "landShape": [[0.0, 0.1], [0.2, 0.0], [0.4, 0.05], [0.3, 0.3]],
  "mountainShapes": [
    [[0.25, 0.15], [0.3, 0.12], [0.32, 0.2], [0.26, 0.22]]
  ],
  "decorations": [
    { "kind": "palm", "x": 0.5, "y": 0.2 }
  ],
  "baseAnchor": { "x": 0.15, "y": 0.5 }
}
```

| Field            | Type            | Required            | Description |
|------------------|-----------------|----------------------|-------------|
| `id`             | string          | yes                  | Unique id of this island shape within the library. |
| `type`           | string          | yes                  | `"normal"` or `"base"`. `"base"` shapes contain a bay and/or mountain to hide a base ship visually and are used once per side when generating a map. |
| `landShape`      | array of points | yes                  | Polygon outline of the whole island (beach/forest). One array of `[x, y]` pairs. Blocks ship placement and drag lines; **shots fly over it**. |
| `mountainShapes` | array of polygons | no (default `[]`)  | Zero or more polygons, each an array of `[x, y]` pairs, describing gray mountain zones inside the island. Mountains block both ships **and** shots. Drawn on top of the land shape. |
| `decorations`    | array of objects | no (default `[]`)   | Purely visual extras, e.g. `{ "kind": "palm", "x": 0.5, "y": 0.2 }`. Never affect collision. |
| `baseAnchor`     | `{x, y}`        | only for `type: "base"` | Marks the bay location on this island shape for authoring/visual reference. The base ship itself always spawns at a fixed map-space position (`BASE_SHIP_START` in `js/engine/rules.js`), not here. |

### Coordinate convention

All coordinates in an island shape file — `landShape` points, `mountainShapes`
points, decoration `x`/`y`, and `baseAnchor` — are **relative, in the range
0–1, in the island's own local space** (not the screen, not the map). A point
`[0.5, 0.5]` is always the center of that island's local bounding box,
regardless of how large or where the island ends up once placed on a map.
The map generator scales, rotates and positions these local coordinates; the
renderer is the only place that ever converts anything to actual screen
pixels.

## Generated map — runtime object

Built by `js/engine/mapGenerator.js` at the start of a match (or reproduced
later from a stored `seed`). This is not hand-authored — it references
shapes from the island library by `islandId` and gives each a placement.

```json
{
  "seed": 123456,
  "islands": [
    { "islandId": "island_07", "x": 0.42, "y": 0.31, "scale": 0.12, "rotation": 1.57 }
  ]
}
```

| Field                  | Type   | Description |
|------------------------|--------|-------------|
| `seed`                 | number | Random seed used to generate this map. Storing it makes the exact same map reproducible later. |
| `islands`              | array  | List of placed island instances. |
| `islands[].islandId`   | string | Which library shape (`data/islands/<islandId>.json`) this instance uses. |
| `islands[].x`, `.y`    | number | Placement position on the map, relative 0–1 (0,0 = top-left of the play field, 1,1 = bottom-right). |
| `islands[].scale`      | number | Scale factor applied to the island shape's local coordinates. |
| `islands[].rotation`   | number | Rotation in radians applied around the island's placement point. |

Exactly two placed islands must reference a library shape with
`type: "base"` — one on each side of the map (player 1 left, player 2
right) — so every generated map has exactly one base per player.

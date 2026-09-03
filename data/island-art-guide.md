# Island Art Delivery Guide (for the artist)

This describes exactly how to draw and export each island so it can be
dropped into the game with **zero mismatch** between what players see and
where ships/shots actually collide. Please follow the file structure below
even if it feels redundant — the extra "mask" layers are what let us convert
your art into game data automatically and precisely.

## 1. Canvas setup (same for every island)

- **Square canvas**, e.g. `1024 x 1024` px (2048x2048 also fine if you want
  extra crispness — just keep it square and consistent across all islands).
- Transparent background (PNG with alpha).
- Draw the island roughly centered in the canvas, with a bit of breathing
  room to the edges (don't let art touch the canvas border) — the game
  scales and rotates this square as one unit.

## 2. Deliver each island as a layered file + exported PNGs

Work in whatever tool you like (Photoshop, Affinity, Procreate, Figma,
Illustrator...) but structure your layers like this, top to bottom:

1. **`art`** — the final, fully painted island exactly as it should look
   in-game (sand texture, rocks, cliffs, palm trees, foam, everything).
   This is purely visual.
2. **`mountain_mask`** — hidden/export-only layer. Fill the **exact
   silhouette** of every rocky/mountain area (the parts that block cannon
   shots) with one **flat, solid, non-transparent color** (e.g. pure
   magenta `#FF00FF`), no soft brushes, no anti-aliased gradients, no
   texture. If there are several separate mountain patches on one island,
   that's fine — just paint them all in this one layer.
3. **`beach_mask`** — hidden/export-only layer. Fill the **exact silhouette
   of the entire island** (beach/forest area *and* the mountain area
   combined — i.e. anywhere a ship cannot sail through) with one flat
   solid color (e.g. pure cyan `#00FFFF`). This is the full land outline.
4. *(Base islands only, see §4)* **`base_anchor`** — a single small solid
   dot (any bright, unused color, e.g. pure yellow `#FFFF00`) marking
   where the bay/hidden base ship spot is.

**Critical rule:** all layers must sit on the *exact same canvas*, same
size, same alignment, never nudged relative to each other. They're
different layers of the *same* drawing, not separately positioned images.

### Export per island

For one island you deliver **3 PNG files** (4 for base islands), all same
pixel dimensions, all transparent except their own content:

```
island_09.png                <- layer "art" only (final look)
island_09_mountain_mask.png   <- layer "mountain_mask" only
island_09_beach_mask.png      <- layer "beach_mask" only
island_09_base_anchor.png     <- layer "base_anchor" only (base islands only)
```

Keep the original layered source file too (PSD/Affinity/Figma link) in
case a shape needs revision later.

## 3. What NOT to do

- No JPG (compression artifacts wreck the mask edges) — PNG only.
- No soft/feathered edges or gradients in the mask layers — hard, flat,
  solid-color silhouettes only.
- No anti-aliasing smoothing left on in the mask export if your tool asks
  (crisp/hard edges preferred over smooth for the masks specifically; the
  `art` layer can be as smooth/painterly as you like).
- Don't resize/crop/reposition one of the three files relative to the
  others — they must overlay perfectly.

## 4. Homebase islands (4 needed total, one art asset each — not per side)

Four of your islands need `type: "base"`. Each match, one of these four is
picked at random for player 1's base and one (independently) for player 2's
— always at a **fixed size and rotation**, its `base_anchor` point landing
exactly on that player's fixed base-ship spot, so the base can no longer be
hit by a shot fired from far away; the shot has to get past the island
first. Unlike the old 2-island west/east setup, **you only draw one art
asset per shape** — the game reuses the same art for both players by
rotating it 180° for player 2 (see the Appendix: art and masks share one
canvas, so a rotation applied to the collision polygons rotates the
sprite identically). So author every one of the four **as if it were
sitting in player 1's bottom-left corner**: the mountain/land mass should
sit up-and-right of the `base_anchor` dot (that's the direction the open
map — and the opponent — is in from that corner); the 180° flip used for
player 2 takes care of pointing it correctly down-and-left from their
top-right corner instead.

The four are (see `data/islands/island_homebase_*.json` for the current
hand-authored placeholders — replace their geometry, keep their ids and
`base_anchor` role):

1. `island_homebase_banana` — a banana/crescent shape, mountain running
   across about 3/4 of its length, with a plain beach tip on the remaining
   1/4. `base_anchor` sits in the crescent's concave hollow.
2. `island_homebase_bay` — a round island with a big mountain in the
   middle, plus a bay/cove cut into its coastline where the base ship
   tucks in. `base_anchor` sits in open water inside that cove.
3. `island_homebase_archipelago` — 7 small islets, each **100% mountain**
   (no plain beach anywhere on any of them), scattered around a central
   gap. `base_anchor` sits in that gap, nestled among the islets.
4. `island_homebase_pear` — a pear shape with a mountain ridge running
   along its long axis, placed diagonally. Unlike the other three, this
   one does **not** enclose the base: `base_anchor` sits just outside the
   pear, on its narrow/down-left side, with the ridge interposed between
   it and the open map.

## 5. How many islands

We need roughly **20–30 island shapes total**, including the 4 homebase
islands above. They can be delivered in batches — no need to do all of
them before the pipeline is tested with one.

## 6. Naming

Use a consistent lowercase id per island, matching across all its files,
e.g. `island_lagoon_01`, `island_lagoon_01_beach_mask.png`, etc. The four
homebase islands should keep the existing ids: `island_homebase_banana`,
`island_homebase_bay`, `island_homebase_archipelago`,
`island_homebase_pear` (matching the files already in `data/islands/`).

---

## Appendix — what happens to these files (for reference, not the artist's concern)

A conversion script reads each `_beach_mask.png` / `_mountain_mask.png`,
traces the flat-color silhouette's contour (marching squares), simplifies
it to a polygon, and normalizes pixel coordinates to the game's 0–1 local
space. The result is written into the existing island JSON format
(`data/schema.md`) as `landShape` / `mountainShapes`, plus a new `sprite`
field pointing at the `art` PNG. Because the masks and the art share one
canvas and one coordinate space, and the game applies the identical
position/scale/rotation transform to both the sprite image and the
collision polygons at render time, the visible art and the hitboxes can
never drift apart.
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

## 4. Base islands (2 needed total)

Two of your islands need `type: "base"` — one designed to visually hide a
base ship on the **left/west** side of a map, one on the **right/east**
side (mirrored is fine). These need a bay or cove shape where the base ship
visually tucks in, plus the `base_anchor` mask (§2.4) marking that bay's
center point.

## 5. How many islands

We need roughly **20–30 island shapes total**, including the 2 base
islands above. They can be delivered in batches — no need to do all of
them before the pipeline is tested with one.

## 6. Naming

Use a consistent lowercase id per island, matching across all its files,
e.g. `island_lagoon_01`, `island_lagoon_01_beach_mask.png`, etc. Base
islands should be named so it's obvious which side they're for, e.g.
`island_base_west`, `island_base_east` (matching the existing files already
in `data/islands/`).

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
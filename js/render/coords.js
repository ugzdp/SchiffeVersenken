// coords.js
//
// Shared coordinate helpers for js/render/. Converts the relative 0-1
// coordinates used throughout the data model (see data/schema.md) into
// actual canvas pixels. This is the only place that does that conversion;
// everything upstream (engine, data) stays relative per CLAUDE.md.

/**
 * Anything that must not stretch on a non-square canvas - island shapes,
 * ship hulls, line widths - is sized from this single "unit" (the smaller
 * of width/height) instead of width/height independently. Only raw
 * positions use width/height separately, since the play field is meant
 * to fill the whole (usually rectangular) screen.
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function getUnit(width, height) {
  return Math.min(width, height);
}

/**
 * Convert a relative 0-1 point (map space or ship position) to pixels.
 * @param {number} relX
 * @param {number} relY
 * @param {number} width
 * @param {number} height
 */
export function relToPixel(relX, relY, width, height) {
  return { x: relX * width, y: relY * height };
}

/**
 * Inverse of relToPixel: convert a pixel point back to relative 0-1 coords.
 * @param {number} pxX
 * @param {number} pxY
 * @param {number} width
 * @param {number} height
 */
export function relFromPixel(pxX, pxY, width, height) {
  return { x: pxX / width, y: pxY / height };
}

/**
 * Transform a point in an island shape's local 0-1 space (see
 * data/schema.md - [0.5, 0.5] is always that shape's own center) into
 * pixel coordinates, given the shape's placement on the generated map.
 * Offsets from the center are scaled by width/height separately (same
 * anisotropic convention as relToPixel, used for ship positions and drag
 * lines) rather than a single isotropic unit - engine/rules.js's collision
 * math works in plain relative coordinates with no notion of aspect ratio,
 * so the rendered shape must scale per-axis to stay aligned with it on a
 * non-square canvas. Island shapes therefore stretch slightly into an
 * ellipse on a non-square canvas rather than staying perfectly circular,
 * trading that for an exact match with the actual collision polygon.
 * @param {[number, number]} localPoint
 * @param {{x:number, y:number, scale:number, rotation:number}} placement
 * @param {number} width
 * @param {number} height
 */
export function islandLocalToPixel(localPoint, placement, width, height) {
  const dx = localPoint[0] - 0.5;
  const dy = localPoint[1] - 0.5;
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const rotatedX = dx * cos - dy * sin;
  const rotatedY = dx * sin + dy * cos;
  const center = relToPixel(placement.x, placement.y, width, height);
  return {
    x: center.x + rotatedX * placement.scale * width,
    y: center.y + rotatedY * placement.scale * height,
  };
}

/**
 * Transform a whole polygon (array of local 0-1 points) into pixel points.
 * @param {Array<[number, number]>} localPoints
 * @param {{x:number, y:number, scale:number, rotation:number}} placement
 * @param {number} width
 * @param {number} height
 */
export function islandPolygonToPixels(localPoints, placement, width, height) {
  return localPoints.map((point) => islandLocalToPixel(point, placement, width, height));
}
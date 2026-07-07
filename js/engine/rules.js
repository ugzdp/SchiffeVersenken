// rules.js
//
// Pure geometry and gameplay constants shared by the rest of the engine
// (see CLAUDE.md "Game Rules"). Nothing here touches the DOM, Canvas or
// network — every function takes plain data in and returns plain data out,
// so it can run equally in the browser or under plain node (see tests.js).
//
// Coordinate convention: all points are [x, y] pairs or {x, y} objects in
// the same relative 0-1 space used everywhere else in the project (see
// data/schema.md). Nothing in this file converts to pixels.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max total length of the freehand drag path used to place a new ship
 * (CLAUDE.md Action A): unlike the old single straight segment, this caps
 * the path's cumulative length as the finger moves, not the straight-line
 * distance from origin to endpoint - a path that curves around a corner
 * spends its budget faster than a straight one covering the same distance.
 */
export const MAX_LINE_LENGTH = 0.25;

/**
 * How long the "undo" cross button stays up after a ship is placed
 * (CLAUDE.md Action A confirm/revert window): the placing player can tap it
 * to revert the placement and redraw. The window ends early - the pending
 * placement commits immediately - the instant the opponent touches one of
 * their own ships to start their turn.
 */
export const PLACEMENT_CONFIRM_WINDOW_MS = 1000;

/**
 * Extra time added to PLACEMENT_CONFIRM_WINDOW_MS when the placement was
 * made with a touch pointer: a finger's tap on the "undo" cross lands later
 * and less precisely than a mouse click, so mobile players get a longer
 * window to react (see js/input.js and js/render/ui.js's matching fade-out).
 */
export const TOUCH_CONFIRM_WINDOW_EXTRA_MS = 500;

/** Radius of a ship's solid core, used for placement spacing (ships must not be dropped on top of each other). */
export const SHIP_HITBOX_RADIUS = 0.015;

/**
 * The hull drawn in js/render/renderer.js's drawHull is a pointed shape, not
 * a circle - its bow tip and stern corners reach out to 1.3x the base
 * radius. Shots must sink a ship even when they only clip that tip or a
 * corner, so the hitbox used for shot collision is enlarged by this factor
 * to cover the hull's full silhouette rather than just its solid core.
 */
const HULL_SILHOUETTE_FACTOR = 1.3;

/**
 * Shrinks the shot hitbox to less than the ship's full drawn silhouette
 * (80% of it), so a shot line grazing just the edge of the hull no longer
 * counts as a hit - makes landing a hit a little harder than "touch
 * anywhere on the boat".
 */
const HIT_RADIUS_SCALE = 0.8;

/**
 * Base ships are drawn larger than normal ships (see BASE_SHIP_RADIUS_FACTOR
 * vs SHIP_RADIUS_FACTOR in js/render/theme.js - engine code can't import
 * from js/render/, so this mirrors that same ratio independently). Their
 * shot hitbox must grow to match.
 */
const BASE_SHIP_HITBOX_RADIUS = SHIP_HITBOX_RADIUS * (0.026 / 0.016);

/**
 * Radius of a ship's hitbox for shot collision (line-circle intersection
 * against a blind shot), covering its full drawn silhouette - see
 * HULL_SILHOUETTE_FACTOR - scaled down by HIT_RADIUS_SCALE, and sized up
 * for base ships.
 * @param {{isBase?: boolean}} ship
 * @returns {number}
 */
export function shipHitRadius(ship) {
  return (ship.isBase ? BASE_SHIP_HITBOX_RADIUS : SHIP_HITBOX_RADIUS) * HULL_SILHOUETTE_FACTOR * HIT_RADIUS_SCALE;
}

/** Minimum gap required between the edges of any two placed islands. */
export const MIN_ISLAND_DISTANCE = 0.04;

/**
 * Fixed spawn point for each player's base ship, in the same relative 0-1
 * map space as everything else. Unlike other ships, the base ship's
 * position does not depend on the random map (island placement/baseAnchor)
 * - it is always the same every match, player 1 near the bottom-left
 * corner and player 2 near the top-right, mirroring CLAUDE.md's "base
 * islands always on opposite sides" rule without tying it to island RNG.
 */
export const BASE_SHIP_START = {
  1: { x: 0.08, y: 0.92 },
  2: { x: 0.92, y: 0.08 },
};

/** Swipe speed (relative units per second) at/below which a blind shot travels MIN_SHOT_DISTANCE. */
export const MIN_SWIPE_SPEED = 0.2;

/** Swipe speed (relative units per second) at/above which a blind shot travels MAX_SHOT_DISTANCE. */
export const MAX_SWIPE_SPEED = 3.0;

/** Shortest possible blind shot distance. */
export const MIN_SHOT_DISTANCE = 0.1;

/** Longest possible blind shot distance. */
export const MAX_SHOT_DISTANCE = 0.8;

/** Time limit (ms) to complete the swipe once the screen goes black; too slow triggers a retry. */
export const SWIPE_TIME_LIMIT_MS = 1500;

/** Scale factor range applied to island local coordinates when placed on a map. */
export const ISLAND_SCALE_MIN = 0.151;
export const ISLAND_SCALE_MAX = 0.6;

/** Fewest islands a generated map will place, not counting the two base islands. */
export const MIN_ISLAND_COUNT = 6;

/** Most islands a generated map will place. */
export const MAX_ISLAND_COUNT = 12;

/** Wall-clock budget (ms) to locate a valid spot for one island before giving up on the rest of the map. */
export const ISLAND_PLACEMENT_DEADLINE_MS = 500;

/** Random placement attempts tried for one normal island before giving up on it. */
export const MAX_PLACEMENT_ATTEMPTS = 60;

/** Distance in from the left/right map edge where a base island's zone starts. */
export const BASE_ZONE_MARGIN = 0.06;

/** Width of the vertical band (from BASE_ZONE_MARGIN inward) a base island may be placed in. */
export const BASE_ZONE_WIDTH = 0.14;

// ---------------------------------------------------------------------------
// Basic vector helpers
// ---------------------------------------------------------------------------

/**
 * Euclidean distance between two points.
 * @param {{x:number,y:number}|[number,number]} a
 * @param {{x:number,y:number}|[number,number]} b
 * @returns {number}
 */
export function distance(a, b) {
  const ax = Array.isArray(a) ? a[0] : a.x;
  const ay = Array.isArray(a) ? a[1] : a.y;
  const bx = Array.isArray(b) ? b[0] : b.x;
  const by = Array.isArray(b) ? b[1] : b.y;
  return Math.hypot(bx - ax, by - ay);
}

// ---------------------------------------------------------------------------
// Point-in-polygon
// ---------------------------------------------------------------------------

/**
 * Ray-casting point-in-polygon test.
 * @param {[number,number]} point
 * @param {Array<[number,number]>} polygon - closed or open ring, at least 3 points
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  const [px, py] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;

    if (intersects) inside = !inside;
  }

  return inside;
}

// ---------------------------------------------------------------------------
// Segment / polygon / circle intersection
// ---------------------------------------------------------------------------

function orientation(a, b, c) {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < 1e-12) return 0; // collinear
  return value > 0 ? 1 : 2;
}

function onSegment(a, b, p) {
  return (
    p[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-12 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-12 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-12
  );
}

/**
 * Whether segment (a,b) intersects segment (c,d), including touching /
 * collinear-overlap edge cases.
 * @param {[number,number]} a
 * @param {[number,number]} b
 * @param {[number,number]} c
 * @param {[number,number]} d
 * @returns {boolean}
 */
export function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) return true;

  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;

  return false;
}

/**
 * Whether a line segment crosses a polygon: either it crosses one of the
 * polygon's edges, or one of its endpoints lies inside the polygon (fully
 * inside without crossing an edge, e.g. a very short line dropped on land).
 * Used for ship-placement lines against land shapes, and shot lines against
 * mountain shapes (see CLAUDE.md "Turn structure").
 * @param {[number,number]} lineStart
 * @param {[number,number]} lineEnd
 * @param {Array<[number,number]>} polygon
 * @returns {boolean}
 */
export function linePolygonIntersects(lineStart, lineEnd, polygon) {
  if (polygon.length < 3) return false;

  for (let i = 0; i < polygon.length; i++) {
    const edgeStart = polygon[i];
    const edgeEnd = polygon[(i + 1) % polygon.length];
    if (segmentsIntersect(lineStart, lineEnd, edgeStart, edgeEnd)) return true;
  }

  return pointInPolygon(lineStart, polygon) || pointInPolygon(lineEnd, polygon);
}

/**
 * Whether a line segment passes within `radius` of `center` — used to test
 * a blind shot's line against a ship's circular hitbox.
 * @param {[number,number]} lineStart
 * @param {[number,number]} lineEnd
 * @param {[number,number]} center
 * @param {number} radius
 * @returns {boolean}
 */
export function lineCircleIntersects(lineStart, lineEnd, center, radius) {
  const [ax, ay] = lineStart;
  const [bx, by] = lineEnd;
  const [cx, cy] = center;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  let t;
  if (lengthSquared === 0) {
    t = 0; // lineStart === lineEnd, degenerate segment
  } else {
    t = ((cx - ax) * dx + (cy - ay) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }

  const closestX = ax + t * dx;
  const closestY = ay + t * dy;

  return Math.hypot(cx - closestX, cy - closestY) <= radius;
}

/**
 * Distance along ray (origin, direction) - direction assumed a unit vector -
 * at which it first enters a circle, or null if it never comes within
 * `radius` while t >= 0. Used to find where a blind shot first reaches a
 * ship's hitbox, as opposed to lineCircleIntersects' plain yes/no test.
 * @param {[number,number]} origin
 * @param {[number,number]} direction - unit vector
 * @param {[number,number]} center
 * @param {number} radius
 * @returns {number|null}
 */
export function rayCircleEntryDistance(origin, direction, center, radius) {
  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const b = 2 * (ox * direction[0] + oy * direction[1]);
  const c = ox * ox + oy * oy - radius * radius;
  const discriminant = b * b - 4 * c; // `a` is 1 since direction is a unit vector

  if (discriminant < 0) return null;

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const nearT = (-b - sqrtDiscriminant) / 2;
  const farT = (-b + sqrtDiscriminant) / 2;

  if (nearT >= 0) return nearT;
  if (farT >= 0) return 0; // origin already inside the circle
  return null;
}

/**
 * Distance along ray (origin, direction) at which it first crosses any edge
 * of `polygon`, or null if it never does. Used to find where a blind shot
 * first reaches a mountain shape, so the shot can be clipped there (shots
 * stop at mountains - CLAUDE.md "Action B - Shoot" step 6).
 * @param {[number,number]} origin
 * @param {[number,number]} direction - unit vector
 * @param {number} maxDistance
 * @param {Array<[number,number]>} polygon
 * @returns {number|null}
 */
export function rayPolygonHitDistance(origin, direction, maxDistance, polygon) {
  const end = [origin[0] + direction[0] * maxDistance, origin[1] + direction[1] * maxDistance];
  let nearest = null;

  for (let i = 0; i < polygon.length; i++) {
    const edgeStart = polygon[i];
    const edgeEnd = polygon[(i + 1) % polygon.length];
    const t = segmentIntersectionParameter(origin, end, edgeStart, edgeEnd);
    if (t !== null && (nearest === null || t < nearest)) nearest = t;
  }

  return nearest === null ? null : nearest * maxDistance;
}

/**
 * Parametric intersection of segment (p, q) with segment (a, b): returns
 * how far along (p, q) - as a fraction in [0, 1] - the crossing happens, or
 * null if the segments don't cross. Internal helper for rayPolygonHitDistance.
 */
function segmentIntersectionParameter(p, q, a, b) {
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const sx = b[0] - a[0];
  const sy = b[1] - a[1];

  const rxs = rx * sy - ry * sx;
  if (Math.abs(rxs) < 1e-12) return null; // parallel (or collinear)

  const qpx = a[0] - p[0];
  const qpy = a[1] - p[1];
  const t = (qpx * sy - qpy * sx) / rxs;
  const u = (qpx * ry - qpy * rx) / rxs;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/**
 * Resolve one blind shot (CLAUDE.md "Action B - Shoot" steps 5-6): cast a
 * ray from `origin` in `direction` up to `maxDistance`, clipping it at the
 * nearest mountain edge (shots stop at mountains, fly over beach/forest and
 * open water) or at the nearest ship hitbox it reaches first, whichever is
 * closer - a hit ship stops the shot the same way a mountain would, so a
 * single shot can sink at most one ship. Friendly fire is allowed: `ships`
 * should include every ship in play except the one the shot was fired from.
 * @param {[number,number]} origin
 * @param {[number,number]} direction - unit vector
 * @param {number} maxDistance
 * @param {Array<Array<[number,number]>>} mountainWorldShapes - already
 *   transformed to map-relative space (see getPlacedIslandWorldShapes)
 * @param {import("./gameState.js").Ship[]} ships - candidate targets,
 *   excluding the shooting ship itself
 * @returns {{endpoint: [number,number], hitShip: import("./gameState.js").Ship|null}}
 */
export function resolveShot(origin, direction, maxDistance, mountainWorldShapes, ships) {
  let stopDistance = maxDistance;
  let hitShip = null;

  for (const mountain of mountainWorldShapes) {
    const hitDistance = rayPolygonHitDistance(origin, direction, maxDistance, mountain);
    if (hitDistance !== null && hitDistance < stopDistance) {
      stopDistance = hitDistance;
      hitShip = null;
    }
  }

  for (const ship of ships) {
    const hitDistance = rayCircleEntryDistance(origin, direction, [ship.x, ship.y], shipHitRadius(ship));
    if (hitDistance !== null && hitDistance <= stopDistance) {
      stopDistance = hitDistance;
      hitShip = ship;
    }
  }

  const endpoint = [origin[0] + direction[0] * stopDistance, origin[1] + direction[1] * stopDistance];
  return { endpoint, hitShip };
}

// ---------------------------------------------------------------------------
// Island shape transforms (local 0-1 space -> map-relative space)
// ---------------------------------------------------------------------------

/**
 * Apply a placement (position, scale, rotation) to a polygon given in an
 * island's local 0-1 space, producing points in map-relative space. The
 * local origin used for scale/rotation is the island's own center (0.5, 0.5)
 * per data/schema.md's coordinate convention.
 * @param {Array<[number,number]>} polygon - local 0-1 points
 * @param {{x:number,y:number,scale:number,rotation:number}} placement
 * @returns {Array<[number,number]>} points in map-relative space
 */
export function transformIslandPolygon(polygon, placement) {
  const { x, y, scale, rotation } = placement;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return polygon.map(([lx, ly]) => {
    // Center on the island's own local center, then scale.
    const cx = (lx - 0.5) * scale;
    const cy = (ly - 0.5) * scale;
    // Rotate.
    const rx = cx * cos - cy * sin;
    const ry = cx * sin + cy * cos;
    // Translate to the placement position.
    return [x + rx, y + ry];
  });
}

/**
 * Transform every polygon of an island library entry (land + mountains) by
 * a placement, producing map-relative shapes ready for collision tests.
 * @param {import("./gameState.js").IslandLibraryEntry} islandEntry
 * @param {{x:number,y:number,scale:number,rotation:number}} placement
 * @returns {{landShape: Array<[number,number]>, mountainShapes: Array<Array<[number,number]>>}}
 */
export function getIslandWorldShapes(islandEntry, placement) {
  return {
    landShape: transformIslandPolygon(islandEntry.landShape, placement),
    mountainShapes: (islandEntry.mountainShapes || []).map((shape) =>
      transformIslandPolygon(shape, placement)
    ),
  };
}

/**
 * The furthest a local-space polygon point strays from the island's own
 * center (0.5, 0.5). Used as a cheap bounding-circle radius (in local
 * units, i.e. still needs multiplying by `scale`) for map placement
 * distance checks.
 * @param {Array<[number,number]>} polygon - local 0-1 points
 * @returns {number}
 */
export function getPolygonBoundingRadius(polygon) {
  let max = 0;
  for (const [lx, ly] of polygon) {
    const d = Math.hypot(lx - 0.5, ly - 0.5);
    if (d > max) max = d;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Drag-path placement (Action A)
// ---------------------------------------------------------------------------

/**
 * Attempt to extend a freehand drag-path by one more point (CLAUDE.md
 * Action A): the path strictly follows the finger with no backtracking. The
 * only thing that freezes it is running out of length budget - crossing an
 * island's land shape does NOT stop the path from growing; it is still
 * appended, but the path is then flagged invalid (see isValidShipPlacementPath)
 * so the renderer draws it red and, if the player releases while it's red,
 * js/engine/actions.js's placeShip() refuses to spawn a ship - the whole
 * drag is discarded and the player must start over (CLAUDE.md's Action A
 * step 3: "the endpoint must be on open water").
 * Length is measured in pixel space (via the caller-supplied `lastPx`/
 * `candidatePx`) rather than relative units: relative x/y are stretched
 * independently to fill a non-square canvas (see render/coords.js), so
 * summing relative-unit segment lengths would make the reachable area an
 * ellipse - wider than tall on a landscape screen - instead of a circle.
 * input.js converts each point to pixels (scaling maxLengthPx by getUnit(),
 * the same "don't stretch" reference size used for ship hulls and island
 * shapes) before calling this. The path itself is stored/returned in
 * relative coordinates, matching every other collision shape in the engine.
 * @param {Array<{x:number,y:number}>} path - existing path (relative coords), first point is the origin ship
 * @param {{x:number,y:number}} candidate - candidate next point (relative coords)
 * @param {{x:number,y:number}} lastPx - path's last point, in pixel coords
 * @param {{x:number,y:number}} candidatePx - `candidate`, in pixel coords
 * @param {number} lengthSoFarPx - the path's total length so far, in pixels
 * @param {number} maxLengthPx
 * @returns {{path: Array<{x:number,y:number}>, lengthPx: number, extended: boolean}}
 *   `extended` is false when the candidate was dropped (length budget already spent), in which case `path`/`lengthPx` are returned unchanged.
 */
export function tryExtendDragPath(
  path,
  candidate,
  lastPx,
  candidatePx,
  lengthSoFarPx,
  maxLengthPx
) {
  if (lengthSoFarPx >= maxLengthPx) return { path, lengthPx: lengthSoFarPx, extended: false };

  const segmentPx = Math.hypot(candidatePx.x - lastPx.x, candidatePx.y - lastPx.y);
  const remainingPx = maxLengthPx - lengthSoFarPx;

  if (segmentPx <= remainingPx) {
    return {
      path: [...path, { x: candidate.x, y: candidate.y }],
      lengthPx: lengthSoFarPx + segmentPx,
      extended: true,
    };
  }

  // The candidate would blow the budget - land exactly on the cap instead
  // of dropping the point outright, same spirit as the old straight-line
  // clamp: the path stops growing right at maxLength rather than short of it.
  const last = path[path.length - 1];
  const scale = remainingPx / segmentPx;
  const clipped = {
    x: last.x + (candidate.x - last.x) * scale,
    y: last.y + (candidate.y - last.y) * scale,
  };
  return { path: [...path, clipped], lengthPx: maxLengthPx, extended: true };
}

/**
 * Compute world-space land/mountain shapes for every island placed on a
 * generated map, ready for collision tests (see getIslandWorldShapes).
 * Shared by actions.js (validating a drop) and input.js (live feedback
 * while dragging) so both use the exact same set of shapes.
 * @param {import("./gameState.js").IslandLibraryEntry[]} islandLibrary
 * @param {import("./gameState.js").GeneratedMap|null|undefined} map
 * @returns {Array<{landShape: Array<[number,number]>, mountainShapes: Array<Array<[number,number]>>}>}
 */
export function getPlacedIslandWorldShapes(islandLibrary, map) {
  return (map?.islands || [])
    .map((placement) => {
      const entry = islandLibrary.find((island) => island.id === placement.islandId);
      return entry ? getIslandWorldShapes(entry, placement) : null;
    })
    .filter(Boolean);
}

/**
 * Whether a candidate ship-placement path is legal (CLAUDE.md Action A):
 * every segment of the path must not cross any island's full land shape
 * (beach + mountain - `linePolygonIntersects` also catches a segment
 * endpoint landing inside a shape, not just crossing its edge), and the
 * path's final point must not land on top of another ship. Unlike
 * tryExtendDragPath() (which lets the path be dragged over land so it can
 * be shown red), this is the real gate: input.js calls it live on every move
 * to color the path, and actions.js's placeShip() calls it again on release
 * to decide whether a ship actually spawns.
 * @param {Array<{x:number,y:number}>} path - relative coords, at least one point
 * @param {Array<{landShape: Array<[number,number]>}>} islandWorldShapes - already
 *   transformed to map-relative space (see getIslandWorldShapes)
 * @param {Array<{x:number,y:number}>} existingShips
 * @returns {boolean}
 */
export function isValidShipPlacementPath(path, islandWorldShapes, existingShips) {
  for (let i = 1; i < path.length; i++) {
    const segmentStart = [path[i - 1].x, path[i - 1].y];
    const segmentEnd = [path[i].x, path[i].y];
    for (const island of islandWorldShapes) {
      if (linePolygonIntersects(segmentStart, segmentEnd, island.landShape)) return false;
    }
  }

  const endpoint = path[path.length - 1];
  for (const ship of existingShips) {
    if (distance(endpoint, [ship.x, ship.y]) < SHIP_HITBOX_RADIUS * 2) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Blind shot: swipe speed -> shot distance
// ---------------------------------------------------------------------------

/**
 * Map a swipe's speed (relative units per second) to a shot distance,
 * clamped between MIN_SHOT_DISTANCE and MAX_SHOT_DISTANCE (see CLAUDE.md
 * "Action B - Shoot"). Speed is clamped to [MIN_SWIPE_SPEED, MAX_SWIPE_SPEED]
 * first, then linearly mapped.
 * @param {number} speed - relative units per second
 * @returns {number} shot distance in relative units
 */
export function swipeSpeedToDistance(speed) {
  const clampedSpeed = Math.max(MIN_SWIPE_SPEED, Math.min(MAX_SWIPE_SPEED, speed));
  const t = (clampedSpeed - MIN_SWIPE_SPEED) / (MAX_SWIPE_SPEED - MIN_SWIPE_SPEED);
  return MIN_SHOT_DISTANCE + t * (MAX_SHOT_DISTANCE - MIN_SHOT_DISTANCE);
}

/**
 * Longest touch blind shot, lower than MAX_SHOT_DISTANCE: a finger swipe
 * already gives finer control than a mouse flick, so a fast touch swipe
 * should not reach as far as an equally fast mouse swipe.
 */
export const TOUCH_MAX_SHOT_DISTANCE = 0.6;

/** At MIN_SWIPE_SPEED, a touch shot's distance is this fraction of the swipe's own physical travel distance - a slow finger swipe falls short of where the finger actually went. */
export const TOUCH_MIN_DISTANCE_FACTOR = 0.6;

/** At MAX_SWIPE_SPEED, a touch shot's distance is this multiple of the swipe's own physical travel distance - a fast finger swipe only slightly overshoots where the finger actually went. */
export const TOUCH_MAX_DISTANCE_FACTOR = 1.3;

/**
 * Map a touch swipe's speed AND its own physical travel distance to a shot
 * distance (CLAUDE.md open design decision: mobile gets a gentler mapping
 * than swipeSpeedToDistance's fixed [MIN_SHOT_DISTANCE, MAX_SHOT_DISTANCE]
 * range). Rather than extrapolating a short, fast flick into a long shot,
 * the result stays anchored to how far the finger actually travelled
 * (`swipeDistance`), scaled by a speed-dependent factor between
 * TOUCH_MIN_DISTANCE_FACTOR (slow) and TOUCH_MAX_DISTANCE_FACTOR (fast), then
 * clamped to [MIN_SHOT_DISTANCE, TOUCH_MAX_SHOT_DISTANCE].
 * @param {number} speed - relative units per second
 * @param {number} swipeDistance - the swipe's own physical travel distance, in relative units
 * @returns {number} shot distance in relative units
 */
export function swipeSpeedToDistanceTouch(speed, swipeDistance) {
  const clampedSpeed = Math.max(MIN_SWIPE_SPEED, Math.min(MAX_SWIPE_SPEED, speed));
  const t = (clampedSpeed - MIN_SWIPE_SPEED) / (MAX_SWIPE_SPEED - MIN_SWIPE_SPEED);
  const factor = TOUCH_MIN_DISTANCE_FACTOR + t * (TOUCH_MAX_DISTANCE_FACTOR - TOUCH_MIN_DISTANCE_FACTOR);
  const distance = swipeDistance * factor;
  return Math.max(MIN_SHOT_DISTANCE, Math.min(TOUCH_MAX_SHOT_DISTANCE, distance));
}
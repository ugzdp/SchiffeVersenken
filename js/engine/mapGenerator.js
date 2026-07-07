// mapGenerator.js
//
// Assembles a random GeneratedMap from an island shape library (see
// data/schema.md and CLAUDE.md "Map generation"). Pure function: takes the
// library array and a seed in, returns a plain map object out. No DOM, no
// Canvas, no fetch — loading data/islands/*.json is js/data/islandLoader.js's
// job, not this module's.
//
// Reproducibility: a normal Math.random() can't be seeded, so this module
// carries its own small deterministic PRNG (mulberry32). The same seed
// always produces the same sequence of draws, and therefore the same map.

import {
  BASE_SHIP_START,
  BASE_ZONE_MARGIN,
  BASE_ZONE_WIDTH,
  ISLAND_PLACEMENT_DEADLINE_MS,
  ISLAND_SCALE_MAX,
  ISLAND_SCALE_MIN,
  MAX_ISLAND_COUNT,
  MAX_PLACEMENT_ATTEMPTS,
  MIN_ISLAND_COUNT,
  MIN_ISLAND_DISTANCE,
  distance,
  getPolygonBoundingRadius,
} from "./rules.js";

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32: a small, fast, seedable PRNG. Good enough for map layout (not
 * cryptographic). Returns a function that yields floats in [0, 1) and
 * always produces the same sequence for the same seed.
 * @param {number} seed
 * @returns {() => number}
 */
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRange(rng, min, max) {
  return min + rng() * (max - min);
}

function pickRandom(rng, array) {
  return array[Math.floor(rng() * array.length)];
}

/** Fisher-Yates shuffle using the seeded rng, so results stay reproducible. */
function shuffle(rng, array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

/**
 * Bounding-circle radius (map-relative units) an island instance occupies,
 * used for cheap distance-based overlap checks during placement.
 */
function placedRadius(islandEntry, scale) {
  return getPolygonBoundingRadius(islandEntry.landShape) * scale;
}

/**
 * Whether a candidate placement keeps at least MIN_ISLAND_DISTANCE of open
 * water between its edge and every already-placed island's edge, stays
 * within the map bounds, and keeps clear of both players' fixed base-ship
 * spawn points (BASE_SHIP_START in rules.js). The base ship's spawn does
 * not depend on the random map, so no island - base or normal - may be
 * placed close enough to touch or block it.
 */
function isValidPlacement(candidate, candidateEntry, placed) {
  const radius = placedRadius(candidateEntry, candidate.scale);

  if (
    candidate.x - radius < 0 ||
    candidate.x + radius > 1 ||
    candidate.y - radius < 0 ||
    candidate.y + radius > 1
  ) {
    return false;
  }

  for (const basePoint of Object.values(BASE_SHIP_START)) {
    if (distance(candidate, basePoint) - radius < MIN_ISLAND_DISTANCE) return false;
  }

  for (const other of placed) {
    const otherRadius = placedRadius(other.entry, other.scale);
    const gap = distance(candidate, other) - radius - otherRadius;
    if (gap < MIN_ISLAND_DISTANCE) return false;
  }

  return true;
}

/**
 * Place one base island in the left or right vertical band of the map (see
 * CLAUDE.md: base islands are always on opposite sides, player 1 left,
 * player 2 right). Rotation only gets a small jitter, not a forced flip:
 * a base shape's bay orientation is an authoring choice baked into its
 * `landShape`/`baseAnchor` (the library may already provide distinct
 * left- and right-oriented base shapes), and the engine has no documented
 * way to know which local direction a given shape's bay opens toward.
 * @param {() => number} rng
 * @param {import("./gameState.js").IslandLibraryEntry} entry
 * @param {"left"|"right"} side
 * @returns {{islandId: string, entry: object, x: number, y: number, scale: number, rotation: number}}
 */
function placeBase(rng, entry, side) {
  const x =
    side === "left"
      ? randomRange(rng, BASE_ZONE_MARGIN, BASE_ZONE_MARGIN + BASE_ZONE_WIDTH)
      : randomRange(rng, 1 - BASE_ZONE_MARGIN - BASE_ZONE_WIDTH, 1 - BASE_ZONE_MARGIN);
  const y = randomRange(rng, 0.2, 0.8);
  const scale = randomRange(rng, ISLAND_SCALE_MIN, ISLAND_SCALE_MAX);
  const rotation = randomRange(rng, -0.15, 0.15);

  return { islandId: entry.id, entry, x, y, scale, rotation };
}

/**
 * Try up to MAX_PLACEMENT_ATTEMPTS random spots in the base zone for a base
 * island, same retry pattern as tryPlaceIsland, so a base island can never
 * land close enough to touch a fixed base-ship spawn point or an
 * already-placed island. Falls back to the last attempt if none validate
 * cleanly (the base zone always has ample room, so this is a last resort).
 */
function tryPlaceBase(rng, entry, side, placed) {
  let lastCandidate = null;
  for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
    lastCandidate = placeBase(rng, entry, side);
    if (isValidPlacement(lastCandidate, entry, placed)) return lastCandidate;
  }
  return lastCandidate;
}

/**
 * Try up to MAX_PLACEMENT_ATTEMPTS random spots for a normal island,
 * returning the first valid placement or null if none fit.
 */
function tryPlaceIsland(rng, entry, placed) {
  for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
    const candidate = {
      islandId: entry.id,
      entry,
      x: randomRange(rng, 0.05, 0.95),
      y: randomRange(rng, 0.05, 0.95),
      scale: randomRange(rng, ISLAND_SCALE_MIN, ISLAND_SCALE_MAX),
      rotation: randomRange(rng, 0, Math.PI * 2),
    };

    if (isValidPlacement(candidate, entry, placed)) return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a random, reproducible GeneratedMap from an island shape library.
 * @param {import("./gameState.js").IslandLibraryEntry[]} islandLibrary
 * @param {number} seed
 * @param {{islandCount?: number}} [options]
 * @returns {import("./gameState.js").GeneratedMap}
 */
export function generateMap(islandLibrary, seed, options = {}) {
  const baseEntries = islandLibrary.filter((entry) => entry.type === "base");
  const normalEntries = islandLibrary.filter((entry) => entry.type !== "base");

  if (baseEntries.length === 0) {
    throw new Error("generateMap: island library needs at least one 'base' island shape");
  }
  if (normalEntries.length === 0) {
    throw new Error("generateMap: island library needs at least one 'normal' island shape");
  }

  const rng = createSeededRandom(seed);
  const placed = [];

  // Shuffle rather than two independent picks, so that when the library
  // offers more than one base shape, player 1 and player 2 get different
  // ones instead of risking the same shape (or a needless repeat) on both.
  const shuffledBases = shuffle(rng, baseEntries);
  placed.push(tryPlaceBase(rng, shuffledBases[0], "left", placed));
  placed.push(tryPlaceBase(rng, shuffledBases[1 % shuffledBases.length], "right", placed));

  const targetCount =
    options.islandCount ?? Math.round(randomRange(rng, MIN_ISLAND_COUNT, MAX_ISLAND_COUNT));

  for (let i = 0; i < targetCount; i++) {
    const entry = pickRandom(rng, normalEntries);
    const placement = tryPlaceIsland(rng, entry, placed);
    if (placement) placed.push(placement);
  }

  return {
    seed,
    islands: placed.map(({ islandId, x, y, scale, rotation }) => ({
      islandId,
      x,
      y,
      scale,
      rotation,
    })),
  };
}
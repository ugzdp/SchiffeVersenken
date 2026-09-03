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
  HOMEBASE_ISLAND_SCALE,
  HOMEBASE_ROTATION,
  ISLAND_PLACEMENT_DEADLINE_MS,
  ISLAND_SCALE_MAX,
  ISLAND_SCALE_MIN,
  MAX_ISLAND_COUNT,
  MAX_PLACEMENT_ATTEMPTS,
  MIN_ISLAND_COUNT,
  MIN_ISLAND_DISTANCE,
  distance,
  getLandBoundingRadius,
  solveHomebaseIslandPlacement,
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
 * used for cheap distance-based overlap checks during placement. Covers
 * every landmass for a multi-ring island (e.g. an atoll), not just one.
 */
function placedRadius(islandEntry, scale) {
  return getLandBoundingRadius(islandEntry.landShape) * scale;
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
 * Place one homebase island so its `baseAnchor` (the bay/cove/gap a base
 * shape marks as the ship's spot, see data/schema.md) lands exactly on that
 * player's fixed BASE_SHIP_START point - the base island now genuinely
 * shields the base ship instead of merely decorating the corner near it, so
 * this is a direct solve rather than a random-attempt search: scale and
 * rotation are both fixed per CLAUDE.md/user request (constant size and
 * rotation for the two homebases), and HOMEBASE_ROTATION's per-player value
 * is exactly what makes an island authored for player 1's bottom-left
 * corner mirror correctly onto player 2's top-right one (see its doc
 * comment in rules.js).
 * @param {import("./gameState.js").IslandLibraryEntry} entry
 * @param {1|2} playerId
 * @returns {{islandId: string, entry: object, x: number, y: number, scale: number, rotation: number}}
 */
function placeHomebase(entry, playerId) {
  const placement = solveHomebaseIslandPlacement(
    entry.baseAnchor,
    BASE_SHIP_START[playerId],
    HOMEBASE_ISLAND_SCALE,
    HOMEBASE_ROTATION[playerId]
  );
  return { islandId: entry.id, entry, ...placement };
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
  placed.push(placeHomebase(shuffledBases[0], 1));
  placed.push(placeHomebase(shuffledBases[1 % shuffledBases.length], 2));

  const targetCount =
    options.islandCount ?? Math.round(randomRange(rng, MIN_ISLAND_COUNT, MAX_ISLAND_COUNT));

  // Homebase shapes double as ordinary filler islands elsewhere on the map
  // (at the usual random scale/rotation, unlike the two fixed instances
  // placed above), so filler picks from the whole library, not just the
  // non-"base" entries.
  for (let i = 0; i < targetCount; i++) {
    const entry = pickRandom(rng, islandLibrary);
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
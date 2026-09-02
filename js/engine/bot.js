// bot.js
//
// Pure decision-making for the single-player bot opponent (always player 2 -
// see js/botController.js, which is the only caller of this module). Like
// the rest of js/engine/, this file never touches the DOM, Canvas or timers:
// it reads a GameState snapshot and returns a decision (a shot to fire, or a
// placement path to walk), leaving js/botController.js to play that decision
// out through the normal js/engine/actions.js functions and the same timing
// js/input.js uses for a human, so every existing animation/sound just works
// unchanged for a bot's turn too.
//
// One decision pipeline, three difficulty presets (BOT_DIFFICULTY below) -
// difficulty is only ever a handful of numbers (how far the bot will
// attempt a shot, how much its aim/distance judgement wavers, how strongly
// it hugs islands for cover, how often it shoots vs. expands, and whether it
// spends the extra cost of a one-ply lookahead) rather than three separate
// hand-written strategies to maintain.

import { getBaseShip, getShipsByOwner } from "./gameState.js";
import {
  MAX_LINE_LENGTH,
  MAX_SHOT_DISTANCE,
  MAX_SWIPE_SPEED,
  MIN_SHOT_DISTANCE,
  MIN_SWIPE_SPEED,
  SHIP_HITBOX_RADIUS,
  distance,
  getLandBoundingRadius,
  getPlacedIslandWorldShapes,
  isValidShipPlacementPath,
  landShapeRings,
  pointInPolygon,
  resolveShot,
} from "./rules.js";

// ---------------------------------------------------------------------------
// Difficulty presets
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BotDifficultyConfig
 * @property {number} engagementRange - the bot will only attempt a shot at a
 *   target within this distance (relative units) - CLAUDE.md addendum:
 *   "worse bots only try to shoot at a closer distance to any ship".
 * @property {number} aimErrorDeg - max random angular error (degrees, +/-)
 *   added to an otherwise-perfect aim - CLAUDE.md addendum: "randomness in
 *   shot accuracy is higher for the worse bots".
 * @property {number} distanceErrorFactor - max random relative error (+/-)
 *   applied to the judged shot distance, same addendum as aimErrorDeg.
 * @property {number} islandHugBias - 0-1, how strongly ship placement
 *   prefers water close to land (mountains block enemy shots, so hugging
 *   them is a real tactical benefit, not just cosmetic).
 * @property {number} aggressiveness - 0-1 chance the bot chooses to shoot
 *   over placing a ship when no line-up on the enemy base is available and
 *   at least one ordinary target is in range.
 * @property {number} thinkMs - artificial delay before the bot acts, so its
 *   turn reads as "thinking" rather than instant.
 * @property {number} baseSnipeMaxDistance - hard-only cap: even within
 *   engagementRange, the bot won't line up a shot on the enemy BASE ship
 *   specifically if it's farther than this (CLAUDE.md addendum: "the hard
 *   bot doesn't try to hit the homebase [...] if it's too far (more than
 *   half of the screen) away"). Infinity for difficulties that don't
 *   specifically hunt the base at all (their normal engagementRange already
 *   keeps them close).
 * @property {number} baseTargetBonus - extra utility score for a candidate
 *   shot that targets the enemy base, on top of a normal target.
 * @property {number} frontierBonusWeight - extra utility for a candidate
 *   shot that clears a path from the bot's own frontier toward the enemy's
 *   territory (CLAUDE.md addendum: "the hard bot tries to strategically hit
 *   enemy boats to clear a way for him to move into enemy territory"). 0
 *   disables this term entirely (easy/medium never consider it).
 * @property {boolean} lookahead - whether decideShot() also scores each
 *   candidate by a shallow one-ply lookahead (see evaluateShotOutcome).
 */

/** @type {Record<"easy"|"medium"|"hard", BotDifficultyConfig>} */
export const BOT_DIFFICULTY = {
  easy: {
    engagementRange: 0.3,
    aimErrorDeg: 25,
    distanceErrorFactor: 0.35,
    islandHugBias: 0.1,
    aggressiveness: 0.4,
    thinkMs: 1400,
    baseSnipeMaxDistance: Infinity,
    baseTargetBonus: 0,
    frontierBonusWeight: 0,
    lookahead: false,
  },
  medium: {
    engagementRange: 0.5,
    aimErrorDeg: 12,
    distanceErrorFactor: 0.15,
    islandHugBias: 0.4,
    aggressiveness: 0.65,
    thinkMs: 900,
    baseSnipeMaxDistance: Infinity,
    baseTargetBonus: 20,
    frontierBonusWeight: 0,
    lookahead: false,
  },
  hard: {
    engagementRange: MAX_SHOT_DISTANCE,
    aimErrorDeg: 4,
    distanceErrorFactor: 0.05,
    islandHugBias: 0.8,
    aggressiveness: 0.9,
    thinkMs: 500,
    baseSnipeMaxDistance: 0.5, // "more than half of the screen" - the play field is 0-1, so half is 0.5
    baseTargetBonus: 100,
    frontierBonusWeight: 60,
    lookahead: true,
  },
};

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Decide the bot's whole move for this turn: either a shot to fire or a
 * placement path to walk. This is the only function js/botController.js
 * needs to call - it already folds in the shoot-vs-place choice and the
 * fallback when one or the other turns out to be impossible.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner - the bot's own player number
 * @param {"easy"|"medium"|"hard"} difficultyKey
 * @returns {{type:"shoot", originShip:import("./gameState.js").Ship, direction:[number,number], speed:number}
 *          |{type:"place", path:Array<{x:number,y:number}>}
 *          |null} null only when the bot has no legal move at all (should
 *   not happen given the map generator's playability guarantee, but a
 *   fully-boxed-in bot must not soft-lock the match)
 */
export function decideBotMove(state, owner, difficultyKey) {
  const difficulty = BOT_DIFFICULTY[difficultyKey];
  const action = decideAction(state, owner, difficulty);

  if (action === "shoot") {
    const shot = decideShot(state, owner, difficulty);
    if (shot) return { type: "shoot", ...shot };
  }

  const path = decidePlacement(state, owner, difficulty);
  if (path) return { type: "place", path };

  // Placement wasn't possible (e.g. genuinely boxed in) - fall back to any
  // legal shot even if the earlier choice/roll said "place".
  const fallbackShot = decideShot(state, owner, difficulty);
  if (fallbackShot) return { type: "shoot", ...fallbackShot };

  return null;
}

/**
 * Choose "shoot" or "place" for this turn.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner
 * @param {BotDifficultyConfig} difficulty
 * @returns {"shoot"|"place"}
 */
function decideAction(state, owner, difficulty) {
  const candidates = gatherShotCandidates(state, owner, difficulty);
  if (candidates.length === 0) return "place";

  // A lined-up, in-range shot at the enemy base is always worth taking over
  // placing another ship, at every difficulty - it's the win condition.
  if (candidates.some((c) => c.target.isBase)) return "shoot";

  return Math.random() < difficulty.aggressiveness ? "shoot" : "place";
}

// ---------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------

/**
 * Find every (own ship, enemy ship) pair the bot could legally shoot right
 * now: within this difficulty's engagement range (and, for the enemy base,
 * within baseSnipeMaxDistance too) and with nothing else - mountain or any
 * other ship, own or enemy - in the way. Reuses rules.js's real resolveShot()
 * for the line-of-sight check, so this can never propose a shot the actual
 * game logic wouldn't also resolve as hitting that exact target (before aim
 * noise is layered on top in aimAt()).
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner
 * @param {BotDifficultyConfig} difficulty
 * @returns {Array<{originShip:import("./gameState.js").Ship, target:import("./gameState.js").Ship, direction:[number,number], distance:number}>}
 */
export function gatherShotCandidates(state, owner, difficulty) {
  const ownShips = getShipsByOwner(state, owner);
  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyShips = getShipsByOwner(state, enemyOwner);
  if (ownShips.length === 0 || enemyShips.length === 0) return [];

  const mountainShapes = getPlacedIslandWorldShapes(state.islands, state.map).flatMap(
    (island) => island.mountainShapes
  );

  const candidates = [];
  for (const originShip of ownShips) {
    for (const target of enemyShips) {
      const dist = distance(originShip, target);
      const maxRange = target.isBase
        ? Math.min(difficulty.engagementRange, difficulty.baseSnipeMaxDistance)
        : difficulty.engagementRange;
      if (dist > maxRange || dist < MIN_SHOT_DISTANCE) continue;

      const direction = [(target.x - originShip.x) / dist, (target.y - originShip.y) / dist];
      const otherShips = state.ships.filter((ship) => ship.id !== originShip.id);
      // Probe the FULL shot range, not just `dist`: resolveShot returns
      // whatever it hits first, so this doubles as the "nothing else in the
      // way" check - a nearer ship or mountain along the same line would
      // come back as the hit instead of `target`.
      const { hitShip } = resolveShot([originShip.x, originShip.y], direction, MAX_SHOT_DISTANCE, mountainShapes, otherShips);
      if (!hitShip || hitShip.id !== target.id) continue;

      candidates.push({ originShip, target, direction, distance: dist });
    }
  }
  return candidates;
}

/**
 * Score one shot candidate: a lined-up base shot dominates (baseTargetBonus),
 * a target that sits on the bot's advance corridor toward the enemy is worth
 * extra (frontierClearingBonus, hard only), and closer shots are slightly
 * preferred since they're both easier to have judged correctly and easier
 * to aim well post-noise.
 */
function scoreShotCandidate(state, owner, candidate, difficulty) {
  let score = 1;
  if (candidate.target.isBase) score += difficulty.baseTargetBonus;
  score += frontierClearingBonus(state, owner, candidate, difficulty);
  score += (1 - candidate.distance / MAX_SHOT_DISTANCE) * 5;
  return score;
}

/**
 * Hard-mode-only bonus (CLAUDE.md addendum: "the hard bot tries to
 * strategically hit enemy boats to clear a way for him to move into enemy
 * territory"): projects the candidate target onto the corridor from the
 * bot's own frontmost ship (closest to the enemy base) to that base, and
 * rewards targets that sit close to, and between the two ends of, that
 * corridor - i.e. ships that are plausibly in the bot's way. Cheap
 * (O(1) per candidate) corridor-alignment heuristic rather than an actual
 * pathfind-before/after comparison, which would cost one grid search per
 * candidate for a benefit only really visible in extended playtesting.
 */
function frontierClearingBonus(state, owner, candidate, difficulty) {
  if (difficulty.frontierBonusWeight <= 0) return 0;

  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyBase = getBaseShip(state, enemyOwner);
  if (!enemyBase) return 0;

  const ownShips = getShipsByOwner(state, owner);
  const front = ownShips.reduce(
    (closest, ship) => (distance(ship, enemyBase) < distance(closest, enemyBase) ? ship : closest),
    ownShips[0]
  );

  const corridorLenSq = squaredDistance(front, enemyBase);
  if (corridorLenSq < 1e-9) return 0;

  const t = projectPointOntoSegmentT(candidate.target, front, enemyBase);
  if (t <= 0 || t >= 1) return 0; // not between the bot's frontier and the enemy base at all

  const perpDist = perpendicularDistanceToSegment(candidate.target, front, enemyBase);
  const corridorLen = Math.sqrt(corridorLenSq);
  const proximity = Math.max(0, 1 - perpDist / (corridorLen * 0.3)); // falls off past ~30% of the corridor's own length
  return difficulty.frontierBonusWeight * proximity;
}

/**
 * Hard-mode-only shallow lookahead: scores the hypothetical board state
 * right after taking `candidate`'s shot, using the same "ships alive / enemy
 * base alive" signals js/engine/scoring.js's computeScore() rewards (skipping
 * its time-based pace bonus, which isn't meaningful for a one-ply
 * hypothetical). Lets the hard bot prefer a shot that meaningfully advances
 * the match over one that merely happens to be available.
 */
function evaluateShotOutcome(state, owner, candidate) {
  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyAliveAfter = getShipsByOwner(state, enemyOwner).length - 1;
  const enemyBaseAliveAfter = candidate.target.isBase ? false : !!getBaseShip(state, enemyOwner);

  let value = -enemyAliveAfter * 10; // fewer surviving enemy ships is better for the bot
  if (!enemyBaseAliveAfter) value += 1000; // winning outright dominates every other consideration
  return value;
}

/**
 * Pick the bot's best available shot and turn it into a direction+speed
 * fireShot() (js/engine/actions.js) can use directly, with difficulty-scaled
 * aim/distance noise layered on top of the otherwise-perfect line to the
 * chosen target.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner
 * @param {BotDifficultyConfig} difficulty
 * @returns {{originShip:import("./gameState.js").Ship, direction:[number,number], speed:number}|null}
 */
function decideShot(state, owner, difficulty) {
  const candidates = gatherShotCandidates(state, owner, difficulty);
  if (candidates.length === 0) return null;

  let scored = candidates.map((c) => ({ ...c, score: scoreShotCandidate(state, owner, c, difficulty) }));
  if (difficulty.lookahead) {
    scored = scored.map((c) => ({ ...c, score: c.score + evaluateShotOutcome(state, owner, c) }));
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  const { direction, speed } = aimAt(best.originShip, best.distance, best.direction, difficulty);
  return { originShip: best.originShip, direction, speed };
}

/**
 * Turn a true (noise-free) direction+distance to a target into a swipe
 * direction+speed with difficulty-scaled error mixed in (CLAUDE.md addendum:
 * "randomness in shot accuracy is higher for the worse bots"). `speed` is
 * the exact inverse of rules.js's swipeSpeedToDistance(), so a noise-free
 * call round-trips to the true distance.
 */
function aimAt(originShip, trueDistance, trueDirection, difficulty) {
  const trueAngle = Math.atan2(trueDirection[1], trueDirection[0]);
  const angleNoise = degToRad(difficulty.aimErrorDeg) * (Math.random() * 2 - 1);
  const angle = trueAngle + angleNoise;
  const direction = [Math.cos(angle), Math.sin(angle)];

  const distanceNoise = 1 + difficulty.distanceErrorFactor * (Math.random() * 2 - 1);
  const desiredDistance = clamp(trueDistance * distanceNoise, MIN_SHOT_DISTANCE, MAX_SHOT_DISTANCE);
  const speed = distanceToSwipeSpeed(desiredDistance);

  return { direction, speed };
}

/** Exact inverse of rules.js's swipeSpeedToDistance(). */
function distanceToSwipeSpeed(desiredDistance) {
  const t = (desiredDistance - MIN_SHOT_DISTANCE) / (MAX_SHOT_DISTANCE - MIN_SHOT_DISTANCE);
  return MIN_SWIPE_SPEED + clamp(t, 0, 1) * (MAX_SWIPE_SPEED - MIN_SWIPE_SPEED);
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

// How many random open-water candidate endpoints to sample before scoring
// and trying to build a real path to the best of them.
const PLACEMENT_CANDIDATE_COUNT = 30;
// Of those, how many (best-scored first) actually get a pathfinding attempt -
// most maps resolve on the first or second try; this is just a safety net
// for when the top-scored spot turns out to be unreachable within budget.
const PLACEMENT_CANDIDATES_TO_TRY = 8;
// Resolution (cells per axis) of the coarse water/land grid used to route a
// path around an island's corner when the straight line to a candidate
// endpoint crosses land - see findWaterPath.
const PATH_GRID_RESOLUTION = 36;

/**
 * Choose where to extend the bot's fleet this turn and build a full,
 * legal freehand path to it (CLAUDE.md Action A). Candidate endpoints are
 * scored by island-hugging (difficulty.islandHugBias - mountains block
 * enemy shots, so hugging one is real cover, not just flavor) and by how
 * much closer they'd bring the bot to the human's current fleet (the
 * "reactive to the moves of the single player" requirement) before a path is
 * actually built to the best-scoring one.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner
 * @param {BotDifficultyConfig} difficulty
 * @returns {Array<{x:number,y:number}>|null} null if no legal path could be built at all
 */
function decidePlacement(state, owner, difficulty) {
  const ownShips = getShipsByOwner(state, owner);
  if (ownShips.length === 0) return null;

  const islandWorldShapes = getPlacedIslandWorldShapes(state.islands, state.map);
  const raw = sampleCandidateEndpoints(state, ownShips, islandWorldShapes, PLACEMENT_CANDIDATE_COUNT);
  if (raw.length === 0) return null;

  const scored = raw
    .map((c) => ({ ...c, score: scorePlacementCandidate(state, owner, c, difficulty) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, PLACEMENT_CANDIDATES_TO_TRY);

  for (const candidate of scored) {
    const path = buildPlacementPath(candidate.origin, candidate.point, islandWorldShapes, state.ships);
    if (path) return path;
  }
  return null;
}

/** Sample random open-water points reachable in a straight line from one of `ownShips`. */
function sampleCandidateEndpoints(state, ownShips, islandWorldShapes, count) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const origin = ownShips[Math.floor(Math.random() * ownShips.length)];
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * MAX_LINE_LENGTH;
    const point = { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
    if (point.x < 0.02 || point.x > 0.98 || point.y < 0.02 || point.y > 0.98) continue; // stay on the play field
    if (!isOpenWater(point, state, islandWorldShapes)) continue;
    points.push({ point, origin });
  }
  return points;
}

/** Whether `point` is clear of every island's land shape and every existing ship. */
function isOpenWater(point, state, islandWorldShapes) {
  for (const island of islandWorldShapes) {
    for (const ring of landShapeRings(island.landShape)) {
      if (pointInPolygon([point.x, point.y], ring)) return false;
    }
  }
  for (const ship of state.ships) {
    if (distance(point, ship) < SHIP_HITBOX_RADIUS * 2) return false;
  }
  return true;
}

function scorePlacementCandidate(state, owner, candidate, difficulty) {
  let score = 0;

  const nearestLandDist = nearestDistanceToLand(candidate.point, state.islands, state.map);
  score += difficulty.islandHugBias * Math.max(0, 1 - nearestLandDist / 0.15) * 10;

  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyShips = getShipsByOwner(state, enemyOwner);
  if (enemyShips.length > 0) {
    const enemyCentroid = centroid(enemyShips);
    const closingDistance = distance(candidate.origin, enemyCentroid) - distance(candidate.point, enemyCentroid);
    score += Math.max(0, closingDistance) * 8; // reactive: reward closing the gap toward the human's fleet
  }

  score += Math.random() * 2; // small jitter so the bot isn't perfectly deterministic turn to turn
  return score;
}

/** Cheap bounding-circle approximation of a point's distance to the nearest island's land. */
function nearestDistanceToLand(point, islandLibrary, map) {
  let min = Infinity;
  for (const placement of map?.islands || []) {
    const entry = islandLibrary.find((island) => island.id === placement.islandId);
    if (!entry) continue;
    const radius = getLandBoundingRadius(entry.landShape) * placement.scale;
    const d = distance(point, placement) - radius;
    if (d < min) min = d;
  }
  return Math.max(0, min);
}

/**
 * Build a real, legal freehand path from `origin` to `target`: the direct
 * line if it doesn't cross land and fits the length budget, otherwise a
 * route found by findWaterPath() and clipped to MAX_LINE_LENGTH exactly like
 * a human's drag path freezes once its budget is spent (see rules.js's
 * tryExtendDragPath). Always re-validated against the real
 * isValidShipPlacementPath() before being returned, so a coarse-grid routing
 * artifact can never slip through as a "legal" ship placement.
 * @returns {Array<{x:number,y:number}>|null}
 */
function buildPlacementPath(origin, target, islandWorldShapes, existingShips) {
  const originPoint = { x: origin.x, y: origin.y };
  const straight = [originPoint, { x: target.x, y: target.y }];
  if (pathLength(straight) <= MAX_LINE_LENGTH && isValidShipPlacementPath(straight, islandWorldShapes, existingShips)) {
    return straight;
  }

  const landRings = islandWorldShapes.flatMap((island) => landShapeRings(island.landShape));
  const waypoints = findWaterPath(originPoint, target, landRings);
  if (!waypoints) return null;

  const trimmed = clipPathToBudget(waypoints, MAX_LINE_LENGTH);
  if (trimmed.length < 2) return null;
  if (!isValidShipPlacementPath(trimmed, islandWorldShapes, existingShips)) return null;
  return trimmed;
}

/** Total length of a path (sum of consecutive segment distances). */
function pathLength(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distance(path[i - 1], path[i]);
  return total;
}

/**
 * Clip a path to a total length budget, same spirit as rules.js's
 * tryExtendDragPath: walk the path accumulating length, and once the budget
 * would be exceeded, land exactly on the cap by clipping the final segment
 * proportionally rather than dropping it outright.
 */
function clipPathToBudget(path, maxLength) {
  const result = [path[0]];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const prev = result[result.length - 1];
    const segLen = distance(prev, path[i]);
    if (total + segLen <= maxLength) {
      result.push(path[i]);
      total += segLen;
    } else {
      const remaining = maxLength - total;
      const t = segLen > 0 ? remaining / segLen : 0;
      result.push({ x: prev.x + (path[i].x - prev.x) * t, y: prev.y + (path[i].y - prev.y) * t });
      break;
    }
  }
  return result;
}

/**
 * Route a water-only path from `origin` to `target` around land using a
 * coarse-grid A* search (8-directional, PATH_GRID_RESOLUTION cells per
 * axis) - this is how the bot "curves around an island's corner" the same
 * way a human's freehand drag can (CLAUDE.md Action A). Returns the actual
 * origin/target points plus the cell-center waypoints between them,
 * simplified to drop near-collinear points, or null if no water route
 * exists on the grid at all.
 */
function findWaterPath(origin, target, landRings) {
  const res = PATH_GRID_RESOLUTION;
  const blocked = buildBlockedGrid(landRings, res);

  const toCell = (p) => ({
    gx: Math.min(res - 1, Math.max(0, Math.floor(p.x * res))),
    gy: Math.min(res - 1, Math.max(0, Math.floor(p.y * res))),
  });
  const start = toCell(origin);
  const goal = toCell(target);
  const key = (c) => c.gy * res + c.gx;
  if (blocked[key(start)] || blocked[key(goal)]) return null;

  const cameFrom = new Map();
  const gScore = new Map([[key(start), 0]]);
  const open = [start];
  const closed = new Set();
  const heuristic = (c) => Math.hypot(c.gx - goal.gx, c.gy - goal.gy);

  while (open.length > 0) {
    // Linear scan for the lowest f-score - the grid is small (<=1300 cells),
    // fine for one bot decision made a couple of times a minute.
    let bestIdx = 0;
    let bestF = Infinity;
    for (let i = 0; i < open.length; i++) {
      const f = (gScore.get(key(open[i])) ?? Infinity) + heuristic(open[i]);
      if (f < bestF) {
        bestF = f;
        bestIdx = i;
      }
    }
    const current = open.splice(bestIdx, 1)[0];
    const currentKey = key(current);
    if (current.gx === goal.gx && current.gy === goal.gy) {
      return simplifyCollinear([origin, ...reconstructCells(cameFrom, current, res), target]);
    }
    closed.add(currentKey);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = current.gx + dx;
        const ny = current.gy + dy;
        if (nx < 0 || ny < 0 || nx >= res || ny >= res) continue;
        const neighbor = { gx: nx, gy: ny };
        const nKey = key(neighbor);
        if (blocked[nKey] || closed.has(nKey)) continue;

        const tentativeG = gScore.get(currentKey) + Math.hypot(dx, dy);
        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, current);
          gScore.set(nKey, tentativeG);
          if (!open.some((c) => key(c) === nKey)) open.push(neighbor);
        }
      }
    }
  }
  return null;
}

/** Mark every grid cell whose center falls inside any land ring. */
function buildBlockedGrid(landRings, res) {
  const blocked = new Uint8Array(res * res);
  const cellSize = 1 / res;
  for (let gy = 0; gy < res; gy++) {
    for (let gx = 0; gx < res; gx++) {
      const cx = (gx + 0.5) * cellSize;
      const cy = (gy + 0.5) * cellSize;
      for (const ring of landRings) {
        if (pointInPolygon([cx, cy], ring)) {
          blocked[gy * res + gx] = 1;
          break;
        }
      }
    }
  }
  return blocked;
}

/** Walk findWaterPath()'s cameFrom chain back to cell-center points, start to goal. */
function reconstructCells(cameFrom, goalCell, res) {
  const cellCenter = (c) => ({ x: (c.gx + 0.5) / res, y: (c.gy + 0.5) / res });
  const cells = [goalCell];
  let key = goalCell.gy * res + goalCell.gx;
  while (cameFrom.has(key)) {
    const prev = cameFrom.get(key);
    cells.push(prev);
    key = prev.gy * res + prev.gx;
  }
  cells.reverse();
  return cells.map(cellCenter);
}

/** Drop points where the path barely changes direction, so a grid route doesn't look like jagged staircase steps. */
function simplifyCollinear(points, angleEpsilon = 0.08) {
  if (points.length <= 2) return points;
  const result = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];
    const a1 = Math.atan2(curr.y - prev.y, curr.x - prev.x);
    const a2 = Math.atan2(next.y - curr.y, next.x - curr.x);
    let diff = Math.abs(a1 - a2);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > angleEpsilon) result.push(curr);
  }
  result.push(points[points.length - 1]);
  return result;
}

// ---------------------------------------------------------------------------
// Small vector helpers (local to this file - rules.js's `distance` covers
// the rest of what's needed elsewhere)
// ---------------------------------------------------------------------------

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function squaredDistance(a, b) {
  return (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
}

function centroid(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Parametric projection of point `p` onto line (a,b), unclamped (can be <0 or >1 - see frontierClearingBonus). */
function projectPointOntoSegmentT(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-12) return 0;
  return ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
}

/** Shortest distance from point `p` to segment (a,b) (clamped to the segment's own extent). */
function perpendicularDistanceToSegment(p, a, b) {
  const t = clamp(projectPointOntoSegmentT(p, a, b), 0, 1);
  const cx = a.x + t * (b.x - a.x);
  const cy = a.y + t * (b.y - a.y);
  return Math.hypot(p.x - cx, p.y - cy);
}

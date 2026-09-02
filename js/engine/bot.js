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
// Every decision is driven by hitProbability() (below) - an estimated 0-1
// chance a given shot actually sinks its target - rather than a hard-coded
// accuracy cutoff. Difficulty (BOT_DIFFICULTY) intentionally keeps
// aimErrorDeg/distanceErrorFactor close together across presets now - a low
// or medium bot is not meant to whiff shots it actually decides to take.
// What separates easy/medium/hard is, in order of how much it actually
// matters to how the bot "feels": how far it's willing to engage at all
// (maxShotDistance - a lower difficulty sticks to close, near-sure shots and
// simply never proposes the long-odds long shots a higher one will try) and
// how early it reacts to danger (criticalThreatProb for defense,
// riskTolerance for how readily it gambles on a risky placement - see
// BOT_DIFFICULTY's typedef). The small residual aim/distance error gap
// between presets is a light seasoning on top, not the main difference.
//
// Decision order for one turn (see decideBotMove), highest priority first:
//   P0  DEFENSE   - any enemy ship likely enough (>20% on medium, see each
//                   difficulty's own criticalThreatProb) to hit OUR base is
//                   shot at if possible, or else placement tries to open a
//                   shot on it - this beats every other consideration.
//   P1  FREE KILL - any shot at all this good (>80%) is taken before
//                   anything else, once P0 is clear.
//   P2  BASE SNIPE - the enemy base specifically, once its own (lower, 30%)
//                    bar is cleared.
//   P3  THREAT RESPONSE - an ordinary shot, weighted toward whichever enemy
//                          ship most threatens our own base (closer = more
//                          urgent), as long as it clears a basic
//                          worthwhile-odds floor.
//   P4  PLACE - if a specific enemy ship stands out as the most dangerous
//               (see mostDangerousCandidate/baseThreats) and no shot on it
//               clears the bar above, try repositioning toward it instead of
//               a generic advance - "relocating boats to make future shots
//               easier". Failing that, advance toward the enemy base if a
//               spot exists where the new ship would be under 40% likely to
//               be hit; failing that, it may still gamble on a merely-risky
//               spot (see acceptsRiskyAdvance) rather than always retreating
//               to cover - a calculated bet that the enemy misses next turn,
//               so a follow-up move can reach real safety. Otherwise spread
//               out for cover (behind mountains, away from the bot's own
//               other ships) instead, still leaning toward the enemy base
//               over one that's further back so the fleet keeps pushing
//               forward rather than ringing the bot's own base.
// A shot/placement that turns out impossible always falls back to whatever
// still is, rather than passing - see the fallbacks at the end of
// decideBotMove().
//
// Within P0/P1, among several candidate shots that all clear their tier's
// bar, the target itself is picked by DANGER first (how likely it already is
// to hit our own base from where it sits - see mostDangerousCandidate()) and
// our own odds only break ties - "not the closest boat but the one that has
// the highest potential of becoming dangerous". P3 folds the same danger
// number into its score instead. This is also why P4's repositioning check
// exists: a dangerous ship we can't yet hit is worth moving toward, not
// ignored in favor of an easier but less important target elsewhere.
//
// Once a shot at a given (our ship, their ship) pairing has missed
// MAX_MISSES_BEFORE_AVOIDING_ORIGIN times, gatherOwnShotCandidates() stops
// proposing it - see state.botShotMemory (js/engine/gameState.js). Every
// tier above naturally "pivots" once that happens, since it's just working
// from a shotCandidates list with that one pairing missing: another target,
// another one of our ships, or placement (advance/defense/reposition) take
// over on their own, with no extra logic needed here.

import { getBaseShip, getBotShotMissCount, getShipsByOwner } from "./gameState.js";
import {
  MAX_LINE_LENGTH,
  MAX_SHOT_DISTANCE,
  MAX_SWIPE_SPEED,
  MIN_SHOT_DISTANCE,
  MIN_SWIPE_SPEED,
  SHIP_HITBOX_RADIUS,
  distance,
  getPlacedIslandWorldShapes,
  isValidShipPlacementPath,
  landShapeRings,
  pointInPolygon,
  resolveShot,
  shipHitRadius,
} from "./rules.js";

// ---------------------------------------------------------------------------
// Difficulty presets
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BotDifficultyConfig
 * @property {number} aimErrorDeg - max random angular error (degrees, +/-)
 *   the bot's own shots wander by - see hitProbability().
 * @property {number} distanceErrorFactor - max random relative error (+/-)
 *   in the bot's own judged shot distance - see hitProbability().
 * @property {number} thinkMs - artificial delay before the bot acts, so its
 *   turn reads as "thinking" rather than instant.
 * @property {number} riskTolerance - [0,1] "standard risk aversion level"
 *   for placement, higher = more willing to gamble - see acceptsRiskyAdvance().
 * @property {number} maxShotDistance - how far this difficulty will ever
 *   consider firing at all (see gatherOwnShotCandidates) - the main lever
 *   that separates easy/medium/hard: a lower-difficulty bot doesn't get
 *   meaningfully worse aim so much as it refuses to engage at range and
 *   sticks to close, close-to-sure shots.
 * @property {number} criticalThreatProb - how likely an enemy ship must be
 *   to hit OUR base before this difficulty treats it as a P0 emergency (see
 *   decideBotMove) - "reactiveness to risk": a lower bar means the bot
 *   panics/defends earlier, off a weaker threat; a higher bar means it lets
 *   danger build up longer before reacting.
 */

// aimErrorDeg/distanceErrorFactor are now close together across difficulties
// - a low/medium bot's own shots, once actually taken, are no longer wildly
// inaccurate, since pAngle/pDistance in hitProbability() clamp to 1 (a
// guaranteed hit) once a target is close enough that its hitbox tolerance
// exceeds the error anyway. What actually separates the presets is how far
// they're willing to engage at all (maxShotDistance) and how early they
// react to danger (criticalThreatProb, riskTolerance) - see the typedef
// above. hard keeps the tightest aim of the three, but the gap to
// easy/medium is now small; it's still kept a little ahead of
// ENEMY_AIM_ERROR_DEG/ENEMY_DISTANCE_ERROR_FACTOR below so its P0 (defend)
// vs P2 (snipe) thresholds keep making sense at any shared range.
/** @type {Record<"easy"|"medium"|"hard", BotDifficultyConfig>} */
export const BOT_DIFFICULTY = {
  easy: { aimErrorDeg: 16, distanceErrorFactor: 0.22, thinkMs: 1400, riskTolerance: 0.2, maxShotDistance: 0.2, criticalThreatProb: 0.3 },
  medium: { aimErrorDeg: 9, distanceErrorFactor: 0.12, thinkMs: 900, riskTolerance: 0.45, maxShotDistance: 0.4, criticalThreatProb: 0.2 },
  hard: { aimErrorDeg: 4.5, distanceErrorFactor: 0.055, thinkMs: 500, riskTolerance: 0.7, maxShotDistance: 0.5, criticalThreatProb: 0.12 },
};

// ---------------------------------------------------------------------------
// Shared thresholds (same for every difficulty - only the accuracy that
// feeds hitProbability() differs; these numbers are the strategy itself)
// ---------------------------------------------------------------------------

/** "within a 50% of screen radius" - defense-scanning (assessBaseThreats) and placement-risk (assessPlacementRisk) are scoped to this; the bot's own shooting range is the separate, shorter, per-difficulty BOT_DIFFICULTY.*.maxShotDistance instead. */
export const CONSIDERATION_RADIUS = 0.5;

/** Generic assumed enemy accuracy for defensive/threat modeling - "the margin of error while aiming should be +-20%" split across both of hitProbability()'s error axes. */
export const ENEMY_AIM_ERROR_DEG = 20;
export const ENEMY_DISTANCE_ERROR_FACTOR = 0.2;

/** Medium's own BOT_DIFFICULTY.medium.criticalThreatProb, re-exported as the baseline "an enemy ship this likely to hit OUR base is a P0 emergency" figure - easy reacts later (higher bar), hard reacts sooner (lower bar), see BOT_DIFFICULTY. */
export const CRITICAL_BASE_THREAT_PROB = BOT_DIFFICULTY.medium.criticalThreatProb;
/** Any shot at all this good is taken before anything else (once P0 is clear). */
export const OPPORTUNISTIC_SHOT_PROB = 0.8;
/** The enemy base is only worth lining up above this. */
export const BASE_SNIPE_PROB = 0.3;
/**
 * Floor below which a routine (non-critical, non-opportunistic) shot isn't
 * worth spending the turn on - not given directly in the brief; chosen to
 * sit between BASE_SNIPE_PROB and a coin flip so P3 still means something.
 */
export const WORTHWHILE_SHOT_PROB = 0.35;
/**
 * How much more a candidate shot's score (P3) is boosted per unit of its
 * target's own danger (pHitMyBase) - bigger than 1 so, among ordinary
 * shots, which enemy ship is more dangerous outweighs which one we
 * personally have slightly better odds against.
 */
export const THREAT_WEIGHT_IN_SHOT_SCORE = 2.5;
/**
 * After this many missed shots at the same enemy ship from the same one of
 * our ships, gatherOwnShotCandidates() stops proposing that exact pairing -
 * "if a boat has been shot at and missed twice ... this means you are too
 * far away [to aim well from there]". Ships never move once placed, so
 * (origin, target) is a stable "position" to give up on - every priority
 * tier above naturally moves on to a different target, a different one of
 * our ships, or placement instead, since it's just working from a
 * shotCandidates list with that one pairing missing.
 */
export const MAX_MISSES_BEFORE_AVOIDING_ORIGIN = 2;
/**
 * A P4 repositioning move toward the single most dangerous enemy ship (see
 * mostDangerousCandidate) only replaces the generic advance/cover placement
 * when it would land the new ship somewhere clearing at least this much
 * next-turn hit chance on that ship - otherwise it's not worth bending the
 * whole placement decision around a target that's still out of realistic
 * reach.
 */
export const TARGETING_PLACEMENT_MIN_PROB = 0.15;
/** A new ship placed somewhere this likely (or less) to be hit next turn counts as a "safe" step forward. */
export const SAFE_ADVANCE_MAX_THREAT = 0.4;
/**
 * Above SAFE_ADVANCE_MAX_THREAT but below this, a spot is risky rather than
 * suicidal - the bot may still gamble on it (see acceptsRiskyAdvance()),
 * banking on the enemy's next shot missing to reach truly safe water on a
 * follow-up placement. At or above this the risk is too high to ever try.
 */
export const RISKY_ADVANCE_MAX_THREAT = 0.65;
/** Ships this close together (beyond the placement collision radius) count as "stacked". */
const MIN_SHIP_SPACING = 0.05;

const NORMAL_SHIP_HIT_RADIUS = shipHitRadius({ isBase: false });

// ---------------------------------------------------------------------------
// The formula
// ---------------------------------------------------------------------------

/**
 * Estimated probability [0,1] that a shot fired from `origin` straight at a
 * point of hitbox radius `targetRadius` sitting `distance(origin,targetPos)`
 * away actually sinks it, given a shooter whose aim direction wanders by up
 * to +-angleErrorDeg and whose judged distance is off by up to
 * +-distanceErrorFactor (both uniform - see js/engine/actions.js's fireShot,
 * which this mirrors: swipe angle -> direction, swipe speed -> distance).
 * 0 whenever anything - a mountain, or any other ship, own or enemy - sits
 * closer along the straight line, since that's exactly what the real
 * js/engine/rules.js resolveShot() would hit instead.
 *
 * Modeled as two independent factors:
 *   - P(angle): the shot's DIRECTION must land within the half-angle the
 *     target's hitbox subtends from `origin` (asin(radius/distance)) for the
 *     line to pass through it at all. Angle error is uniform, so
 *     P = min(1, tolerance / angleErrorDeg).
 *   - P(distance): a real shot only travels as far as the swipe's judged
 *     distance - overshoot doesn't matter (the ray just keeps going through
 *     the target's position and still crosses it), only undershoot does. So
 *     P = min(1, (distanceErrorFactor + radius/distance) / (2 * distanceErrorFactor)).
 * The two are multiplied together as an independence approximation - not an
 * exact joint distribution, but a close, cheap, tunable stand-in, good
 * enough to gate/rank candidate shots against the fixed thresholds above.
 * @param {{x:number,y:number}} origin
 * @param {{x:number,y:number}} targetPos
 * @param {number} targetRadius - shipHitRadius() of the target, or
 *   NORMAL_SHIP_HIT_RADIUS for a hypothetical (not-yet-placed) point
 * @param {number} angleErrorDeg
 * @param {number} distanceErrorFactor
 * @param {Array<Array<[number,number]>>} mountainShapes - world-space, see getPlacedIslandWorldShapes
 * @param {import("./gameState.js").Ship[]} blockingShips - every ship that
 *   could block the line, excluding `origin` itself and, if it's a real
 *   ship, `targetPos`'s own ship
 * @returns {number}
 */
export function hitProbability(origin, targetPos, targetRadius, angleErrorDeg, distanceErrorFactor, mountainShapes, blockingShips) {
  const d = distance(origin, targetPos);
  if (d < 1e-9) return 0;

  const direction = [(targetPos.x - origin.x) / d, (targetPos.y - origin.y) / d];
  const { endpoint } = resolveShot([origin.x, origin.y], direction, MAX_SHOT_DISTANCE, mountainShapes, blockingShips);
  const reachDistance = distance(origin, { x: endpoint[0], y: endpoint[1] });
  if (reachDistance < d - targetRadius - 1e-6) return 0; // a mountain or a closer ship stops the shot before it gets here

  const angleToleranceDeg = (Math.asin(clamp(targetRadius / d, 0, 1)) * 180) / Math.PI;
  const pAngle = clamp(angleToleranceDeg / angleErrorDeg, 0, 1);

  const distanceToleranceFraction = targetRadius / d;
  const pDistance = clamp((distanceErrorFactor + distanceToleranceFraction) / (2 * distanceErrorFactor), 0, 1);

  return pAngle * pDistance;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Decide the bot's whole move for this turn - see the priority order (P0-P4)
 * documented at the top of this file.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner - the bot's own player number
 * @param {"easy"|"medium"|"hard"} difficultyKey
 * @returns {{type:"shoot", originShip:import("./gameState.js").Ship, target:import("./gameState.js").Ship, direction:[number,number], speed:number}
 *          |{type:"place", path:Array<{x:number,y:number}>}
 *          |null} null only when the bot has no legal move at all (should
 *   not happen given the map generator's playability guarantee, but a
 *   fully-boxed-in bot must not soft-lock the match)
 */
export function decideBotMove(state, owner, difficultyKey) {
  const difficulty = BOT_DIFFICULTY[difficultyKey];
  const shotCandidates = gatherOwnShotCandidates(state, owner, difficulty);
  const baseThreats = assessBaseThreats(state, owner);
  const criticalThreats = baseThreats.filter((t) => t.pHitMyBase > difficulty.criticalThreatProb);
  // Every enemy ship's own "danger" number (its chance of hitting OUR base
  // from where it sits right now) - used below to pick the more dangerous
  // target over the merely easier one, not just to gate P0/P3.
  const threatByShipId = new Map(baseThreats.map((t) => [t.enemyShip.id, t.pHitMyBase]));

  // P0 - defense: an enemy ship likely enough to hit OUR base outranks everything else.
  if (criticalThreats.length > 0) {
    const shotAtThreat = mostDangerousCandidate(shotCandidates, threatByShipId, criticalThreats.map((t) => t.enemyShip.id));
    if (shotAtThreat) return toShootMove(shotAtThreat, difficulty);

    // Can't hit it yet - placement tries to open a shot on the worst one instead of advancing/spreading normally.
    const path = decidePlacement(state, owner, difficulty, { priorityTarget: criticalThreats[0].enemyShip });
    if (path) return { type: "place", path };

    const fallback = bestShotAgainst(shotCandidates);
    if (fallback) return toShootMove(fallback, difficulty);
    return null;
  }

  // P1 - any shot at all this good is free money, take it before anything else - but among several such
  // shots, the more dangerous target wins over the merely easier one (CLAUDE.md addendum).
  const easyKill = mostDangerousCandidate(shotCandidates.filter((c) => c.pHit > OPPORTUNISTIC_SHOT_PROB), threatByShipId);
  if (easyKill) return toShootMove(easyKill, difficulty);

  // P2 - a lined-up base shot, once it clears its own (lower) bar.
  const baseCandidate = shotCandidates.find((c) => c.target.isBase);
  if (baseCandidate && baseCandidate.pHit > BASE_SNIPE_PROB) return toShootMove(baseCandidate, difficulty);

  // P3 - an ordinary shot, weighted toward whichever enemy ship is the bigger threat to our base (closer = more
  // urgent, or sitting on a lane we don't otherwise guard), as long as it clears a basic worthwhile-odds floor.
  const bestThreatWeighted = shotCandidates
    .filter((c) => c.pHit > WORTHWHILE_SHOT_PROB)
    .map((c) => ({ ...c, score: c.pHit + (threatByShipId.get(c.target.id) || 0) * THREAT_WEIGHT_IN_SHOT_SCORE }))
    .sort((a, b) => b.score - a.score)[0];
  if (bestThreatWeighted) return toShootMove(bestThreatWeighted, difficulty);

  // P4 - nothing worth shooting yet. If one enemy ship stands out as the most dangerous, try repositioning
  // toward it first (CLAUDE.md addendum: "relocating boats to make future shots easier") rather than
  // defaulting straight to a generic advance; only keep that repositioning move if it actually lands
  // somewhere with a realistic follow-up shot, otherwise fall through to the normal advance/cover placement.
  const mostDangerousShip = baseThreats[0] ? baseThreats[0].enemyShip : null;
  if (mostDangerousShip) {
    const targetingPath = decidePlacement(state, owner, difficulty, { priorityTarget: mostDangerousShip });
    if (targetingPath && placementOpensDecentShot(state, targetingPath, mostDangerousShip, difficulty)) {
      return { type: "place", path: targetingPath };
    }
  }
  const path = decidePlacement(state, owner, difficulty);
  if (path) return { type: "place", path };

  // Placement wasn't possible either - take the best (even mediocre) shot rather than pass.
  const anyShot = bestShotAgainst(shotCandidates);
  if (anyShot) return toShootMove(anyShot, difficulty);
  return null;
}

/** Highest-pHit candidate, optionally restricted to a set of target ship ids - "just take whatever's best odds", no danger-weighting, used only by the last-resort fallbacks above. */
function bestShotAgainst(candidates, targetIds = null) {
  const pool = targetIds ? candidates.filter((c) => targetIds.includes(c.target.id)) : [...candidates];
  return pool.sort((a, b) => b.pHit - a.pHit)[0] || null;
}

/**
 * Pick the candidate shot most worth taking: primarily by how dangerous its
 * target already is (threatByShipId's pHitMyBase - CLAUDE.md addendum: "not
 * the closest boat but the one that has the highest potential of becoming
 * dangerous... the tip of the enemy boats"), our own odds of hitting it only
 * breaking ties. Optionally restricted to a set of target ship ids.
 * @param {Array<{originShip, target, pHit, distance}>} candidates
 * @param {Map<string, number>} threatByShipId
 * @param {string[]|null} [targetIds]
 */
function mostDangerousCandidate(candidates, threatByShipId, targetIds = null) {
  const pool = targetIds ? candidates.filter((c) => targetIds.includes(c.target.id)) : candidates;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => {
    const dangerDiff = (threatByShipId.get(b.target.id) || 0) - (threatByShipId.get(a.target.id) || 0);
    if (Math.abs(dangerDiff) > 1e-9) return dangerDiff;
    return b.pHit - a.pHit;
  })[0];
}

function toShootMove(candidate, difficulty) {
  const { direction, speed } = aimAt(candidate.originShip, candidate.target, candidate.distance, difficulty);
  return { type: "shoot", originShip: candidate.originShip, target: candidate.target, direction, speed };
}

/**
 * Whether the freehand path decidePlacement() proposed with priorityTarget
 * set actually lands the new ship somewhere plausible to shoot `target` from
 * next turn - worth bending the whole P4 placement decision around rather
 * than falling back to the generic advance/cover pick.
 * @param {import("./gameState.js").GameState} state
 * @param {Array<{x:number,y:number}>} path
 * @param {import("./gameState.js").Ship} target
 * @param {BotDifficultyConfig} difficulty
 */
function placementOpensDecentShot(state, path, target, difficulty) {
  const endpoint = path[path.length - 1];
  const mountainShapes = getPlacedIslandWorldShapes(state.islands, state.map).flatMap((island) => island.mountainShapes);
  const blockingShips = state.ships.filter((ship) => ship.id !== target.id);
  const pHit = hitProbability(endpoint, target, shipHitRadius(target), difficulty.aimErrorDeg, difficulty.distanceErrorFactor, mountainShapes, blockingShips);
  return pHit > TARGETING_PLACEMENT_MIN_PROB;
}

// ---------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------

/**
 * Every (own ship, enemy ship) pair within this difficulty's own
 * maxShotDistance with a nonzero hitProbability(), using the bot's own
 * difficulty accuracy - except a pairing already missed
 * MAX_MISSES_BEFORE_AVOIDING_ORIGIN times (CLAUDE.md
 * addendum: ships never move, so a repeated miss means that exact spot is
 * "too far away" for this target - stop proposing it and let the priority
 * cascade in decideBotMove() pivot to something else on its own).
 * @returns {Array<{originShip:import("./gameState.js").Ship, target:import("./gameState.js").Ship, pHit:number, distance:number}>}
 */
function gatherOwnShotCandidates(state, owner, difficulty) {
  const ownShips = getShipsByOwner(state, owner);
  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyShips = getShipsByOwner(state, enemyOwner);
  if (ownShips.length === 0 || enemyShips.length === 0) return [];

  const mountainShapes = getPlacedIslandWorldShapes(state.islands, state.map).flatMap((island) => island.mountainShapes);

  const candidates = [];
  for (const originShip of ownShips) {
    for (const target of enemyShips) {
      const d = distance(originShip, target);
      if (d > difficulty.maxShotDistance) continue;
      if (getBotShotMissCount(state, originShip.id, target.id) >= MAX_MISSES_BEFORE_AVOIDING_ORIGIN) continue;

      const blockingShips = state.ships.filter((ship) => ship.id !== originShip.id && ship.id !== target.id);
      const pHit = hitProbability(originShip, target, shipHitRadius(target), difficulty.aimErrorDeg, difficulty.distanceErrorFactor, mountainShapes, blockingShips);
      if (pHit <= 0) continue;

      candidates.push({ originShip, target, pHit, distance: d });
    }
  }
  return candidates;
}

/**
 * Every enemy ship within CONSIDERATION_RADIUS of our own base, with its
 * estimated chance of hitting that base (generic ENEMY_AIM_ERROR_DEG/
 * ENEMY_DISTANCE_ERROR_FACTOR accuracy - we don't know the human's actual
 * skill), sorted most-threatening first.
 * @returns {Array<{enemyShip:import("./gameState.js").Ship, distance:number, pHitMyBase:number}>}
 */
function assessBaseThreats(state, owner) {
  const myBase = getBaseShip(state, owner);
  if (!myBase) return [];
  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyShips = getShipsByOwner(state, enemyOwner);
  const mountainShapes = getPlacedIslandWorldShapes(state.islands, state.map).flatMap((island) => island.mountainShapes);

  return enemyShips
    .map((enemyShip) => {
      const d = distance(enemyShip, myBase);
      if (d > CONSIDERATION_RADIUS) return null;
      const blockingShips = state.ships.filter((ship) => ship.id !== enemyShip.id && ship.id !== myBase.id);
      const pHitMyBase = hitProbability(enemyShip, myBase, shipHitRadius(myBase), ENEMY_AIM_ERROR_DEG, ENEMY_DISTANCE_ERROR_FACTOR, mountainShapes, blockingShips);
      return { enemyShip, distance: d, pHitMyBase };
    })
    .filter(Boolean)
    .sort((a, b) => b.pHitMyBase - a.pHitMyBase);
}

/**
 * Turn a true (noise-free) direction+distance to a target into a swipe
 * direction+speed with difficulty-scaled error mixed in. `speed` is the
 * exact inverse of rules.js's swipeSpeedToDistance(), so a noise-free call
 * round-trips to the true distance.
 */
function aimAt(originShip, target, trueDistance, difficulty) {
  const trueAngle = Math.atan2(target.y - originShip.y, target.x - originShip.x);
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

const PLACEMENT_CANDIDATE_COUNT = 30;
const PLACEMENT_CANDIDATES_TO_TRY = 8;
const PATH_GRID_RESOLUTION = 36;

// Placement scoring weights (see scorePlacementCandidate) - tuned so a safe
// advance always beats a purely defensive spot, and a priority-target shot
// opportunity beats everything. ADVANCE_PROGRESS_WEIGHT is intentionally
// large relative to ADVANCE_BASE_SCORE/SCORE_JITTER so that, among several
// safe candidates, the one closest to the enemy base clearly wins the pick
// instead of the choice coming down to near-random jitter - without this a
// bot tends to place its new ships in a defensive ring right around its own
// base rather than actually advancing across the map.
const PRIORITY_TARGET_SCORE_SCALE = 1000;
const ADVANCE_BASE_SCORE = 100;
const ADVANCE_PROGRESS_WEIGHT = 60;
const COVER_WEIGHT = 10; // per enemy ship this spot is hidden from
const EXPOSURE_WEIGHT = 50; // scaled by the single worst threat's probability
// Even an "unsafe" (not-safe-to-advance) spot still leans toward the enemy
// base when picking between similarly-covered options, so a defensive bot
// spreads forward instead of retreating into a cluster around its own base.
const COVER_PROGRESS_WEIGHT = 15;
const STACKING_PENALTY_WEIGHT = 40;
const SCORE_JITTER = 2; // small random tie-breaker so the bot isn't perfectly deterministic turn to turn

/**
 * Choose where to extend the bot's fleet this turn and build a full, legal
 * freehand path to it (CLAUDE.md Action A). See scorePlacementCandidate for
 * how candidate endpoints are scored: advance toward the enemy base when
 * it's safe (CLAUDE.md addendum), otherwise spread out for mountain cover,
 * or - if `priorityTarget` is set (P0 in decideBotMove) - open a shot on it.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner
 * @param {BotDifficultyConfig} difficulty
 * @param {{priorityTarget?: import("./gameState.js").Ship}} [options]
 * @returns {Array<{x:number,y:number}>|null} null if no legal path could be built at all
 */
function decidePlacement(state, owner, difficulty, options = {}) {
  const { priorityTarget = null } = options;
  const ownShips = getShipsByOwner(state, owner);
  if (ownShips.length === 0) return null;

  const islandWorldShapes = getPlacedIslandWorldShapes(state.islands, state.map);
  const raw = sampleCandidateEndpoints(state, ownShips, islandWorldShapes, PLACEMENT_CANDIDATE_COUNT);
  if (raw.length === 0) return null;

  const enemyOwner = owner === 1 ? 2 : 1;
  const context = {
    enemyShips: getShipsByOwner(state, enemyOwner),
    enemyBase: getBaseShip(state, enemyOwner),
    mountainShapes: islandWorldShapes.flatMap((island) => island.mountainShapes),
    priorityTarget,
    ownShips,
  };

  const scored = raw
    .map((c) => ({ ...c, score: scorePlacementCandidate(state, difficulty, c, context) }))
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

/**
 * Score one candidate placement point (higher is better):
 *   - `priorityTarget` set (P0, can't currently hit a critical base threat):
 *     dominated entirely by the chance a ship placed here would get a shot
 *     on it.
 *   - otherwise: if the spot is "safe" (CLAUDE.md addendum's <40% chance any
 *     nearby enemy could hit a ship placed here), reward progress toward the
 *     enemy base - advancing always beats a purely defensive spot. If it's
 *     merely "risky" (CLAUDE.md addendum: above the safe line but not
 *     insanely high), the bot sometimes gambles on it anyway - see
 *     acceptsRiskyAdvance() - scored as a discounted advance, banking on the
 *     enemy missing next turn to reach real safety on a follow-up move. If
 *     it's neither safe nor an accepted gamble, fall back to minimizing how
 *     many enemy ships could hit it at all (mountain cover, not "near land" -
 *     CLAUDE.md addendum) and how bad the single worst threat is, but still
 *     prefer whichever covered spot is further toward the enemy base over
 *     one that's further back - so a defensively-minded pick still nudges
 *     the fleet forward instead of clustering back around the bot's own base.
 * Every branch is further penalized for landing right next to one of the
 * bot's own other ships (CLAUDE.md addendum: don't stack, advance or spread).
 */
function scorePlacementCandidate(state, difficulty, candidate, context) {
  const { enemyShips, enemyBase, mountainShapes, priorityTarget, ownShips } = context;
  const point = candidate.point;
  const spacingPenalty = stackingPenalty(point, ownShips);

  if (priorityTarget) {
    const blockingShips = state.ships.filter((ship) => ship.id !== priorityTarget.id);
    const pHitPriority = hitProbability(point, priorityTarget, shipHitRadius(priorityTarget), difficulty.aimErrorDeg, difficulty.distanceErrorFactor, mountainShapes, blockingShips);
    return pHitPriority * PRIORITY_TARGET_SCORE_SCALE - spacingPenalty;
  }

  const { maxThreat, exposedCount } = assessPlacementRisk(point, enemyShips, mountainShapes, state.ships);
  const progress = enemyBase ? distance(candidate.origin, enemyBase) - distance(point, enemyBase) : 0;

  let score;
  if (maxThreat < SAFE_ADVANCE_MAX_THREAT) {
    score = ADVANCE_BASE_SCORE + progress * ADVANCE_PROGRESS_WEIGHT;
  } else if (maxThreat < RISKY_ADVANCE_MAX_THREAT && acceptsRiskyAdvance(maxThreat, difficulty)) {
    // A calculated gamble: push into water that's more dangerous than
    // "safe" rather than falling back to pure cover-seeking, discounted by
    // just how risky it actually is.
    score = ADVANCE_BASE_SCORE - maxThreat * EXPOSURE_WEIGHT + progress * ADVANCE_PROGRESS_WEIGHT;
  } else {
    score = -exposedCount * COVER_WEIGHT - maxThreat * EXPOSURE_WEIGHT + progress * COVER_PROGRESS_WEIGHT;
  }

  return score - spacingPenalty + Math.random() * SCORE_JITTER;
}

/**
 * Whether the bot accepts a placement in the "risky advance" band (maxThreat
 * between SAFE_ADVANCE_MAX_THREAT and RISKY_ADVANCE_MAX_THREAT) as a
 * calculated gamble rather than always falling back to pure cover-seeking -
 * CLAUDE.md addendum: "if the risk is not insanely high but a little above
 * the safe threshold, sometimes dangerous moves can be tried in order to get
 * to safe territory with two tries". The chance scales with the bot's own
 * riskTolerance (its "standard risk aversion level" per difficulty, see
 * BOT_DIFFICULTY) and shrinks linearly across the band itself, so a spot
 * just over the safe line is gambled on far more readily than one just
 * under the "insanely high" cutoff.
 * @param {number} maxThreat
 * @param {BotDifficultyConfig} difficulty
 */
function acceptsRiskyAdvance(maxThreat, difficulty) {
  const bandPosition = (maxThreat - SAFE_ADVANCE_MAX_THREAT) / (RISKY_ADVANCE_MAX_THREAT - SAFE_ADVANCE_MAX_THREAT);
  const gambleChance = difficulty.riskTolerance * (1 - clamp(bandPosition, 0, 1));
  return Math.random() < gambleChance;
}

/**
 * How exposed a hypothetical new ship at `point` would be right now: the
 * single worst enemy hit chance against it (maxThreat, used for the <40%
 * "safe to advance" check) and how many distinct enemy ships have ANY
 * nonzero chance at all (exposedCount, used to prefer cover behind a
 * mountain from as many of them as possible).
 */
function assessPlacementRisk(point, enemyShips, mountainShapes, allShips) {
  let maxThreat = 0;
  let exposedCount = 0;
  for (const enemy of enemyShips) {
    if (distance(enemy, point) > CONSIDERATION_RADIUS) continue;
    const blockingShips = allShips.filter((ship) => ship.id !== enemy.id);
    const p = hitProbability(enemy, point, NORMAL_SHIP_HIT_RADIUS, ENEMY_AIM_ERROR_DEG, ENEMY_DISTANCE_ERROR_FACTOR, mountainShapes, blockingShips);
    if (p > 0) exposedCount++;
    if (p > maxThreat) maxThreat = p;
  }
  return { maxThreat, exposedCount };
}

/** Penalty for landing a new ship too close to one of the bot's own other ships (CLAUDE.md addendum: don't stack). */
function stackingPenalty(point, ownShips) {
  let penalty = 0;
  for (const ship of ownShips) {
    const gap = distance(point, ship) - MIN_SHIP_SPACING;
    if (gap < 0) penalty += -gap * STACKING_PENALTY_WEIGHT;
  }
  return penalty;
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
// Small helpers
// ---------------------------------------------------------------------------

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

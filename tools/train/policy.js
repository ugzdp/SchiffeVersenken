// policy.js
//
// The single learned decision policy used by the self-play training
// simulation (tools/train/). Unlike the shipped js/engine/bot.js (a fixed
// P0-P4 priority cascade plus a dozen hand-picked threshold constants -
// OPPORTUNISTIC_SHOT_PROB, THREAT_WEIGHT_IN_SHOT_SCORE, SAFE_ADVANCE_MAX_THREAT
// etc.), this policy makes every decision with ONE scoring pass: every
// legal shot and every legal placement this turn are scored on the same
// scale, and whichever candidate scores highest is played. All of those
// hand-picked thresholds are gone - only geometry (hitProbability, path
// legality) is wired in by hand. Which of a ship-kill, a base-kill,
// advancing, or a defensive kill matters more is entirely controlled by
// `genome`, which tools/train/evolve.js searches over.
//
// Deliberately NOT part of js/engine/ or the shipped game (see CLAUDE.md's
// "Architecture" section) - this only ever runs offline, in Node, via
// tools/train/evolve.js. It reuses js/engine/bot.js's hitProbability()
// (the accuracy model, shared physics - not a strategy choice) and its
// candidate-endpoint sampling / A* placement-path building (exported from
// bot.js for exactly this reuse, see the comments there) rather than
// duplicating either.

import { getBaseShip, getShipsByOwner } from "../../js/engine/gameState.js";
import {
  MAX_SHOT_DISTANCE,
  MIN_SHOT_DISTANCE,
  MAX_SWIPE_SPEED,
  MIN_SWIPE_SPEED,
  distance,
  getPlacedIslandWorldShapes,
  shipHitRadius,
} from "../../js/engine/rules.js";
import { hitProbability, sampleCandidateEndpoints, buildPlacementPath } from "../../js/engine/bot.js";

/**
 * Fixed shooting skill for every trained bot - "the median (medium)
 * preset's accuracy" per the brief this was scoped from. NOT evolved; only
 * the decision weights in Genome are. Values copied from
 * js/engine/bot.js's BOT_DIFFICULTY.medium.
 */
export const AIM_ERROR_DEG = 9;
export const DISTANCE_ERROR_FACTOR = 0.12;

const PLACEMENT_CANDIDATE_COUNT = 30;
const PLACEMENT_CANDIDATES_TO_TRY = 8;

/** Hitbox radius to assume for a ship that doesn't exist yet (a placement candidate point), same as js/engine/bot.js's NORMAL_SHIP_HIT_RADIUS. */
const NORMAL_SHIP_HIT_RADIUS = shipHitRadius({ isBase: false });

/**
 * @typedef {Object} Genome
 * The only thing evolve.js searches over. Each candidate action this turn
 * is scored as pHit * (an applicable mix of these), so they're directly
 * comparable to each other regardless of units - evolution is free to find
 * out, for example, that defense should outweigh raw advance, the same
 * question js/engine/bot.js's THREAT_WEIGHT_IN_SHOT_SCORE used to answer
 * by hand.
 * @property {number} hitShip - value of sinking an ordinary enemy ship
 * @property {number} hitBase - value of sinking the enemy base (also wins)
 * @property {number} advance - value per unit of distance a placement
 *   shaves off the closest own ship's distance to the enemy base
 * @property {number} defense - value per unit of distance a kill adds to
 *   the enemy's closest ship's distance to our own base
 * @property {number} safety - cost per unit of estimated risk a placement
 *   leaves the new ship sitting in (see placementRiskAndOpportunity()) -
 *   without this, placement only ever chased advance-progress with zero
 *   regard for whether the new ship survives to make use of it
 * @property {number} setup - value per unit of hit-chance a placement opens
 *   up next turn, against ANY enemy ship (not just the base) - so a spot
 *   that's farther from the enemy base in a straight line, or riskier, can
 *   still win if it clears an enemy ship blocking the way forward or lines
 *   up a kill. Without this, "progress" only ever meant immediate straight-
 *   line distance, so a necessary sidestep or a worthwhile risk never
 *   scored any better than standing still. The opponent moves first,
 *   though - a setup only pays off if the ship survives to use it, so its
 *   value is discounted by the enemy's own best chance of sinking it first
 *   (see bestPlacementCandidate's `setup * opportunity * (1 - exposure)`) -
 *   among two spots with an equally good shot lined up, the one less
 *   likely to get hit first scores higher, while still requiring the
 *   target stay in range at all.
 */

/**
 * Decide one full move for `owner`, given `genome`'s weights.
 * @param {import("../../js/engine/gameState.js").GameState} state
 * @param {1|2} owner
 * @param {Genome} genome
 * @returns {{type:"shoot", originShip, target, direction:[number,number], speed:number}
 *          |{type:"place", path:Array<{x:number,y:number}>}
 *          |null} null only when there is truly no legal move at all
 */
export function decideMove(state, owner, genome) {
  const ownShips = getShipsByOwner(state, owner);
  if (ownShips.length === 0) return null;

  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyShips = getShipsByOwner(state, enemyOwner);
  const myBase = getBaseShip(state, owner);
  const enemyBase = getBaseShip(state, enemyOwner);

  const islandWorldShapes = getPlacedIslandWorldShapes(state.islands, state.map);
  const mountainShapes = islandWorldShapes.flatMap((island) => island.mountainShapes);

  const bestShot = bestShootCandidate(state, ownShips, enemyShips, myBase, mountainShapes, genome);
  const bestPlacement = bestPlacementCandidate(state, ownShips, enemyShips, enemyBase, islandWorldShapes, mountainShapes, genome);

  if (bestShot && (!bestPlacement || bestShot.score >= bestPlacement.score)) return toShootMove(bestShot);
  if (bestPlacement) return { type: "place", path: bestPlacement.path };
  if (bestShot) return toShootMove(bestShot); // no legal placement at all - still take the shot rather than pass
  return null;
}

/**
 * Every (own ship, enemy ship) pair with a nonzero hit chance, scored as
 * pHit * (kill value + expected defensive value). The defensive term only
 * ever applies to whichever enemy ship currently sits closest to our own
 * base - sinking it is the only way a shot can change "distance from the
 * enemy's closest ship to our base" (ships never move once placed), valued
 * by how much further away the *next*-closest enemy ship already sits
 * (that's what the distance becomes once the closest one is gone).
 */
function bestShootCandidate(state, ownShips, enemyShips, myBase, mountainShapes, genome) {
  if (enemyShips.length === 0) return null;

  let closestShip = null;
  let currentClosestDist = 0;
  let nextClosestDist = 0;
  if (myBase) {
    const sorted = [...enemyShips].sort((a, b) => distance(a, myBase) - distance(b, myBase));
    closestShip = sorted[0];
    currentClosestDist = distance(closestShip, myBase);
    // No second-closest ship to "fall back to" - leave the delta at 0
    // rather than treating it as infinitely far away.
    nextClosestDist = sorted.length > 1 ? distance(sorted[1], myBase) : currentClosestDist;
  }

  let best = null;
  for (const originShip of ownShips) {
    for (const target of enemyShips) {
      const d = distance(originShip, target);
      if (d > MAX_SHOT_DISTANCE) continue; // the real physical shot range (rules.js), not a subjective willingness cutoff
      const blockingShips = state.ships.filter((s) => s.id !== originShip.id && s.id !== target.id);
      const pHit = hitProbability(originShip, target, shipHitRadius(target), AIM_ERROR_DEG, DISTANCE_ERROR_FACTOR, mountainShapes, blockingShips);
      if (pHit <= 0) continue;

      const killValue = target.isBase ? genome.hitBase : genome.hitShip;
      const defenseValue = closestShip && target.id === closestShip.id ? genome.defense * Math.max(0, nextClosestDist - currentClosestDist) : 0;
      const score = pHit * (killValue + defenseValue);

      if (!best || score > best.score) best = { originShip, target, pHit, distance: d, score };
    }
  }
  return best;
}

/**
 * Every legal freehand placement this turn, scored as advance progress plus
 * setup value, minus estimated risk: placing a ship earns nothing on its
 * own beyond how much closer it gets the fleet to the enemy base (advance),
 * how good a shot it opens on ANY enemy ship next turn (setup - see
 * placementRiskAndOpportunity()), and how likely it is to get that ship
 * sunk next turn (safety, penalized). Without the setup term, "progress"
 * only ever meant immediate straight-line distance to the enemy base, so a
 * placement that clears the way around a blocking enemy ship - farther
 * away, or riskier, but opening a real shot - could never outscore just
 * standing pat or advancing in a straight line.
 */
function bestPlacementCandidate(state, ownShips, enemyShips, enemyBase, islandWorldShapes, mountainShapes, genome) {
  if (!enemyBase) return null;
  const currentMinDist = Math.min(...ownShips.map((s) => distance(s, enemyBase)));

  const raw = sampleCandidateEndpoints(state, ownShips, islandWorldShapes, PLACEMENT_CANDIDATE_COUNT);
  if (raw.length === 0) return null;

  const scored = raw
    .map((c) => {
      const progress = currentMinDist - distance(c.point, enemyBase);
      const { exposure, opportunity } = placementRiskAndOpportunity(state, c.point, enemyShips, mountainShapes);
      // A setup only pays off if the ship survives the enemy's next turn to
      // actually take the shot - discount it by the enemy's own best odds
      // of sinking it first (1 - exposure = our estimated survival chance),
      // on top of the flat safety*exposure cost every placement already
      // pays regardless of whether it set anything up.
      const survivalWeightedOpportunity = opportunity * (1 - exposure);
      return { ...c, score: genome.advance * progress - genome.safety * exposure + genome.setup * survivalWeightedOpportunity };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, PLACEMENT_CANDIDATES_TO_TRY);

  for (const candidate of scored) {
    const path = buildPlacementPath(candidate.origin, candidate.point, islandWorldShapes, state.ships);
    if (path) return { path, score: candidate.score };
  }
  return null;
}

/**
 * Two numbers about a hypothetical new ship at `point`, sharing one pass
 * over enemyShips since both need the same per-enemy hitProbability():
 *   - exposure: worst-case chance (0-1) some single nearby enemy could hit
 *     it next turn - the single most dangerous enemy, not a sum, since only
 *     one of them gets to act on it before our own next turn.
 *   - opportunity: best-case chance (0-1) THIS new ship would have of
 *     hitting some enemy ship next turn (not just the base) - deliberately
 *     a raw hit chance, not pre-multiplied by genome.hitBase/hitShip here:
 *     genome.setup alone converts it to a score (same pattern as
 *     safety*exposure), so it stays on the same scale as every other term
 *     instead of double-counting a kill's value once as "the shot" and
 *     again as "the setup for the shot".
 * Both reuse this policy's own fixed AIM_ERROR_DEG/DISTANCE_ERROR_FACTOR as
 * the assumed enemy accuracy too (rather than inventing a separate assumed-
 * enemy-accuracy constant, which is exactly the kind of hand-picked
 * threshold this rewrite was meant to get rid of) - "assume the enemy aims
 * about as well as we do" is a reasonable, parameter-free stand-in.
 */
function placementRiskAndOpportunity(state, point, enemyShips, mountainShapes) {
  let exposure = 0;
  let opportunity = 0;
  for (const enemy of enemyShips) {
    const blockingShips = state.ships.filter((s) => s.id !== enemy.id);

    const threatToUs = hitProbability(enemy, point, NORMAL_SHIP_HIT_RADIUS, AIM_ERROR_DEG, DISTANCE_ERROR_FACTOR, mountainShapes, blockingShips);
    if (threatToUs > exposure) exposure = threatToUs;

    const shotFromUs = hitProbability(point, enemy, shipHitRadius(enemy), AIM_ERROR_DEG, DISTANCE_ERROR_FACTOR, mountainShapes, blockingShips);
    if (shotFromUs > opportunity) opportunity = shotFromUs;
  }
  return { exposure, opportunity };
}

function toShootMove(candidate) {
  const { direction, speed } = aimAt(candidate.originShip, candidate.target, candidate.distance);
  return { type: "shoot", originShip: candidate.originShip, target: candidate.target, direction, speed };
}

/**
 * True direction/distance to the target, turned into a noisy swipe using
 * this policy's fixed accuracy - mirrors js/engine/bot.js's aimAt()/
 * distanceToSwipeSpeed() exactly (kept as a small local copy rather than an
 * import, since it's a few lines and bot.js's version is difficulty-shaped).
 */
function aimAt(originShip, target, trueDistance) {
  const trueAngle = Math.atan2(target.y - originShip.y, target.x - originShip.x);
  const angleNoise = ((AIM_ERROR_DEG * Math.PI) / 180) * (Math.random() * 2 - 1);
  const angle = trueAngle + angleNoise;
  const direction = [Math.cos(angle), Math.sin(angle)];

  const distanceNoise = 1 + DISTANCE_ERROR_FACTOR * (Math.random() * 2 - 1);
  const desiredDistance = clamp(trueDistance * distanceNoise, MIN_SHOT_DISTANCE, MAX_SHOT_DISTANCE);
  const t = (desiredDistance - MIN_SHOT_DISTANCE) / (MAX_SHOT_DISTANCE - MIN_SHOT_DISTANCE);
  const speed = MIN_SWIPE_SPEED + clamp(t, 0, 1) * (MAX_SWIPE_SPEED - MIN_SWIPE_SPEED);
  return { direction, speed };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// trainedBot.js
//
// The self-play-trained single-player bot: unlike js/engine/bot.js's hand-
// tuned P0-P4 priority cascade, this bot's decision-making came from
// tools/train/evolve.js's evolutionary self-play search rather than being
// written by hand. Every legal shot and every legal placement this turn are
// scored on the same scale, and whichever candidate scores highest is
// played - no priority tiers, no hand-picked threshold constants. Only
// TRAINED_GENOME below (the search's output) and the fixed accuracy
// (AIM_ERROR_DEG/DISTANCE_ERROR_FACTOR, the "medium" preset's numbers) were
// chosen by hand; everything else in the scoring is what evolution found.
//
// TRAINED_GENOME is baked-in output from a real training run, not invented:
// tools/train/best-genome.json as of the run that beat js/engine/bot.js's
// "medium" bot 96/100 games (sides alternated) in
// tools/train/compareVsShipped.js. See tools/train/README.md for how it was
// produced and what each number means. This file is a straight port of
// tools/train/policy.js into js/engine/ (that file has no Node-only code -
// no fs/path imports - so the only change needed was import paths and
// folding the genome argument into a constant) so the single-player bot can
// use it directly; tools/train/ stays the offline search tool, this is the
// shipped result.
//
// Per CLAUDE.md architecture, this stays pure like js/engine/bot.js - no
// DOM, no Canvas, no timers. js/botController.js is the WHEN/HOW.

import { getBaseShip, getShipsByOwner } from "./gameState.js";
import { MAX_SHOT_DISTANCE, MIN_SHOT_DISTANCE, MAX_SWIPE_SPEED, MIN_SWIPE_SPEED, distance, getPlacedIslandWorldShapes, shipHitRadius } from "./rules.js";
import { hitProbability, sampleCandidateEndpoints, buildPlacementPath } from "./bot.js";

/** How long the trained bot "thinks" before acting - see js/botController.js - same as BOT_DIFFICULTY.medium.thinkMs, since it shares medium's accuracy. */
export const TRAINED_BOT_THINK_MS = 900;

/** Fixed shooting skill - copied from js/engine/bot.js's BOT_DIFFICULTY.medium, the accuracy this genome was actually trained and validated at. */
const AIM_ERROR_DEG = 9;
const DISTANCE_ERROR_FACTOR = 0.12;

const PLACEMENT_CANDIDATE_COUNT = 30;
const PLACEMENT_CANDIDATES_TO_TRY = 8;

/** Hitbox radius to assume for a ship that doesn't exist yet (a placement candidate point). */
const NORMAL_SHIP_HIT_RADIUS = shipHitRadius({ isBase: false });

/**
 * The output of tools/train/evolve.js's search - see tools/train/README.md
 * for what each number means (roughly: how much sinking an ordinary ship,
 * sinking the enemy base, advancing toward the enemy base, defensively
 * sinking the enemy's biggest threat, placing safely, and opening up a
 * future shot on any enemy ship are each worth, relative to each other).
 */
const TRAINED_GENOME = { hitShip: 20.7, hitBase: 82.2, advance: 90.1, defense: 54.9, safety: 20.1, setup: 65.0 };

/**
 * Decide the trained bot's whole move for this turn.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner - the bot's own player number
 * @returns {{type:"shoot", originShip:import("./gameState.js").Ship, target:import("./gameState.js").Ship, direction:[number,number], speed:number}
 *          |{type:"place", path:Array<{x:number,y:number}>}
 *          |null} null only when there is truly no legal move at all
 */
export function decideTrainedBotMove(state, owner) {
  const ownShips = getShipsByOwner(state, owner);
  if (ownShips.length === 0) return null;

  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyShips = getShipsByOwner(state, enemyOwner);
  const myBase = getBaseShip(state, owner);
  const enemyBase = getBaseShip(state, enemyOwner);

  const islandWorldShapes = getPlacedIslandWorldShapes(state.islands, state.map);
  const mountainShapes = islandWorldShapes.flatMap((island) => island.mountainShapes);

  const bestShot = bestShootCandidate(state, ownShips, enemyShips, myBase, mountainShapes);
  const bestPlacement = bestPlacementCandidate(state, ownShips, enemyShips, enemyBase, islandWorldShapes, mountainShapes);

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
 * by how much further away the *next*-closest enemy ship already sits.
 */
function bestShootCandidate(state, ownShips, enemyShips, myBase, mountainShapes) {
  if (enemyShips.length === 0) return null;

  let closestShip = null;
  let currentClosestDist = 0;
  let nextClosestDist = 0;
  if (myBase) {
    const sorted = [...enemyShips].sort((a, b) => distance(a, myBase) - distance(b, myBase));
    closestShip = sorted[0];
    currentClosestDist = distance(closestShip, myBase);
    nextClosestDist = sorted.length > 1 ? distance(sorted[1], myBase) : currentClosestDist;
  }

  let best = null;
  for (const originShip of ownShips) {
    for (const target of enemyShips) {
      const d = distance(originShip, target);
      if (d > MAX_SHOT_DISTANCE) continue;
      const blockingShips = state.ships.filter((s) => s.id !== originShip.id && s.id !== target.id);
      const pHit = hitProbability(originShip, target, shipHitRadius(target), AIM_ERROR_DEG, DISTANCE_ERROR_FACTOR, mountainShapes, blockingShips);
      if (pHit <= 0) continue;

      const killValue = target.isBase ? TRAINED_GENOME.hitBase : TRAINED_GENOME.hitShip;
      const defenseValue = closestShip && target.id === closestShip.id ? TRAINED_GENOME.defense * Math.max(0, nextClosestDist - currentClosestDist) : 0;
      const score = pHit * (killValue + defenseValue);

      if (!best || score > best.score) best = { originShip, target, pHit, distance: d, score };
    }
  }
  return best;
}

/**
 * Every legal freehand placement this turn, scored as advance progress plus
 * setup value, minus estimated risk: how much closer it gets the fleet to
 * the enemy base (advance), how good a shot it opens on ANY enemy ship next
 * turn (setup, discounted by the chance the ship doesn't survive to use it
 * - see placementRiskAndOpportunity()), minus how likely it is to get that
 * ship sunk next turn regardless (safety). The setup term is what lets a
 * spot that's farther from the enemy base, or riskier, still win if it
 * clears an enemy ship blocking the way forward or lines up a kill -
 * without it, "progress" only ever meant immediate straight-line distance.
 */
function bestPlacementCandidate(state, ownShips, enemyShips, enemyBase, islandWorldShapes, mountainShapes) {
  if (!enemyBase) return null;
  const currentMinDist = Math.min(...ownShips.map((s) => distance(s, enemyBase)));

  const raw = sampleCandidateEndpoints(state, ownShips, islandWorldShapes, PLACEMENT_CANDIDATE_COUNT);
  if (raw.length === 0) return null;

  const scored = raw
    .map((c) => {
      const progress = currentMinDist - distance(c.point, enemyBase);
      const { exposure, opportunity } = placementRiskAndOpportunity(state, c.point, enemyShips, mountainShapes);
      // A setup only pays off if the ship survives the enemy's next turn to
      // actually take the shot - discount it by our estimated survival
      // chance (1 - exposure), on top of the flat safety*exposure cost
      // every placement already pays regardless of whether it set up a shot.
      const survivalWeightedOpportunity = opportunity * (1 - exposure);
      const score = TRAINED_GENOME.advance * progress - TRAINED_GENOME.safety * exposure + TRAINED_GENOME.setup * survivalWeightedOpportunity;
      return { ...c, score };
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
 * over enemyShips since both need the same per-enemy hitProbability() -
 * see tools/train/policy.js's identical helper for the full rationale:
 *   - exposure: worst-case chance (0-1) some single nearby enemy could hit
 *     it next turn.
 *   - opportunity: best-case chance (0-1) THIS new ship would have of
 *     hitting some enemy ship next turn (not just the base) - a raw hit
 *     chance, not pre-multiplied by TRAINED_GENOME.hitBase/hitShip here;
 *     TRAINED_GENOME.setup alone converts it to a score.
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

/** True direction/distance to the target, turned into a noisy swipe using this bot's fixed accuracy. */
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

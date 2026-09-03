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
// this version adds (1) a real "defense mode" - dangerLevel() is a sharp
// switch (not the old always-a-little-active linear ramp) centered on the
// evolved TRAINED_GENOME.criticalDistance, amplifying urgencyBonus/
// defensiveSetup/shieldValue and suppressing advance once a threat crosses
// it - and (2) training pressure from a fixed opponent with real,
// substantially sharper-than-medium accuracy (not shipped here - this file
// always uses its own fixed AIM_ERROR_DEG/DISTANCE_ERROR_FACTOR for
// everything, same as before; only the offline training process in
// tools/train/ used a sharper opponent to select for genomes that actually
// defend well against real pressure). Validated at 91/100 vs
// js/engine/bot.js's "medium" bot, and - the more meaningful comparisons -
// 51.5/48.5 in a 200-game direct head-to-head against the PREVIOUS shipped
// genome (shield only, no criticalDistance/sharp-opponent training), and
// 54.5/45.5 against an intermediate candidate that had criticalDistance but
// not the sharp-opponent training - confirming the sharp-opponent pressure
// added real value on top of the threshold mechanism alone. See
// tools/train/TODO.md for the full trail and tools/train/README.md for how
// it was produced and what each number means. This file is a straight port of
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
export const TRAINED_BOT_THINK_MS = 300;

/** Fixed shooting skill - tighter than js/engine/bot.js's "hard" preset (4.5deg/5.5%) on purpose, per explicit request. Kept in sync with tools/train/policy.js's AIM_ERROR_DEG/DISTANCE_ERROR_FACTOR - see the comment there for why they must match. */
const AIM_ERROR_DEG = 4;
const DISTANCE_ERROR_FACTOR = 0.12;

const PLACEMENT_CANDIDATE_COUNT = 30;
const PLACEMENT_CANDIDATES_TO_TRY = 8;

/** Hitbox radius to assume for a ship that doesn't exist yet (a placement candidate point). */
const NORMAL_SHIP_HIT_RADIUS = shipHitRadius({ isBase: false });

/** Fixed (not evolved) steepness of the defense-mode transition around TRAINED_GENOME.criticalDistance - see dangerLevel(). See tools/train/policy.js's identical constant for the full rationale. */
const URGENCY_STEEPNESS = 15;

/**
 * How much "defense mode" should be in effect (0-1) given how close the
 * single worst threat already is to our base - a smooth-but-sharp step
 * centered on TRAINED_GENOME.criticalDistance. See tools/train/policy.js's
 * identical function for the full rationale.
 */
function dangerLevel(currentClosestDist) {
  return 1 / (1 + Math.exp(URGENCY_STEEPNESS * (currentClosestDist - TRAINED_GENOME.criticalDistance)));
}

/**
 * The output of tools/train/evolve.js's search - see tools/train/README.md
 * for what each number means (roughly: how much sinking an ordinary ship,
 * sinking the enemy base, advancing toward the enemy base, REALIZED
 * defense, ATTEMPTED/prospective defense (urgency), placing safely, opening
 * up a future shot on any enemy ship, and the distance-to-base threshold
 * where defense mode switches on (criticalDistance) are each worth,
 * relative to each other).
 */
const TRAINED_GENOME = { hitShip: 10.1, hitBase: 118.2, advance: 123.2, defense: 5.5, urgency: 15.4, safety: 31.8, setup: 66.0, criticalDistance: 0.22 };

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
  const bestPlacement = bestPlacementCandidate(state, ownShips, enemyShips, myBase, enemyBase, islandWorldShapes, mountainShapes);

  if (bestShot && (!bestPlacement || bestShot.score >= bestPlacement.score)) return toShootMove(bestShot);
  if (bestPlacement) return { type: "place", path: bestPlacement.path };
  if (bestShot) return toShootMove(bestShot); // no legal placement at all - still take the shot rather than pass
  return null;
}

/**
 * Every (own ship, enemy ship) pair with a nonzero hit chance, scored as
 * pHit * (kill value + expected defensive value), plus a pHit-INdependent
 * urgency bonus on a shot at the closest threat (see urgencyBonus below).
 * The defensive term only ever applies to whichever enemy ship currently
 * sits closest to our own base - sinking it is the only way a shot can
 * change "distance from the enemy's closest ship to our base" (ships never
 * move once placed), valued by how much further away the *next*-closest
 * enemy ship already sits.
 */
function bestShootCandidate(state, ownShips, enemyShips, myBase, mountainShapes) {
  if (enemyShips.length === 0) return null;

  let closestShip = null;
  let currentClosestDist = 0;
  let nextClosestDist = 0;
  let danger = 0;
  if (myBase) {
    const sorted = [...enemyShips].sort((a, b) => distance(a, myBase) - distance(b, myBase));
    closestShip = sorted[0];
    currentClosestDist = distance(closestShip, myBase);
    nextClosestDist = sorted.length > 1 ? distance(sorted[1], myBase) : currentClosestDist;
    danger = dangerLevel(currentClosestDist);
  }

  let best = null;
  for (const originShip of ownShips) {
    for (const target of enemyShips) {
      const d = distance(originShip, target);
      if (d > MAX_SHOT_DISTANCE) continue;
      const blockingShips = state.ships.filter((s) => s.id !== originShip.id && s.id !== target.id);
      const pHit = hitProbability(originShip, target, shipHitRadius(target), AIM_ERROR_DEG, DISTANCE_ERROR_FACTOR, mountainShapes, blockingShips);
      if (pHit <= 0) continue;

      const isClosestThreat = closestShip && target.id === closestShip.id;
      const killValue = target.isBase ? TRAINED_GENOME.hitBase : TRAINED_GENOME.hitShip;
      const defenseValue = isClosestThreat ? TRAINED_GENOME.defense * Math.max(0, nextClosestDist - currentClosestDist) : 0;
      // Desperation shot: unlike defenseValue above, this ISN'T scaled by
      // pHit - a legal but low-odds shot (pHit already confirmed > 0) at a
      // ship dangerously close to our base is still worth attempting, since
      // letting it advance further unchallenged is worse than a long shot
      // at stopping it.
      const urgencyBonus = isClosestThreat ? TRAINED_GENOME.urgency * danger : 0;
      const score = pHit * (killValue + defenseValue) + urgencyBonus;

      if (!best || score > best.score) best = { originShip, target, pHit, distance: d, score };
    }
  }
  return best;
}

/**
 * Every legal freehand placement this turn, scored as advance progress plus
 * setup value plus defensive-setup value plus shield value, minus estimated
 * risk: how much closer it gets the fleet to the enemy base (advance), how
 * good a shot it opens on ANY enemy ship next turn (setup - see
 * placementRiskAndOpportunity()), how good a shot it opens SPECIFICALLY on
 * the enemy ship currently closest to our own base (defensiveSetup - "post
 * a new ship near home so it can shoot the attacker next turn"), how much
 * it physically blocks that same closest threat's own shot at our base
 * (shieldValue - a shot stops at the first thing it hits, so a ship placed
 * in the way can intercept it), and how likely it is to get that ship sunk
 * next turn regardless (safety, penalized). Without setup/defensiveSetup/
 * shieldValue, "progress" only ever meant immediate straight-line distance
 * to the enemy base, so a placement that clears the way around a blocking
 * enemy ship, or defends home territory instead of advancing at all, could
 * never outscore just standing pat or advancing in a straight line.
 */
function bestPlacementCandidate(state, ownShips, enemyShips, myBase, enemyBase, islandWorldShapes, mountainShapes) {
  if (!enemyBase) return null;
  const currentMinDist = Math.min(...ownShips.map((s) => distance(s, enemyBase)));

  // Closest enemy threat to our own base right now - mirrors
  // bestShootCandidate's own closestShip logic exactly, needed here so a
  // placement that would let the NEW ship threaten that same enemy next
  // turn gets defensive credit too (see defensiveSetup below).
  let closestThreat = null;
  let currentClosestThreatDist = 0;
  let nextClosestThreatDist = 0;
  let danger = 0;
  if (myBase && enemyShips.length > 0) {
    const sorted = [...enemyShips].sort((a, b) => distance(a, myBase) - distance(b, myBase));
    closestThreat = sorted[0];
    currentClosestThreatDist = distance(closestThreat, myBase);
    nextClosestThreatDist = sorted.length > 1 ? distance(sorted[1], myBase) : currentClosestThreatDist;
    danger = dangerLevel(currentClosestThreatDist);
  }

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

      // Defensive setup: same shape as bestShootCandidate's realized
      // defenseValue (pHit * distance gained by removing the closest
      // threat), just computed prospectively for the NEW ship's position
      // instead of an existing one, survival-discounted the same way as
      // the general setup term above, and using TRAINED_GENOME.urgency
      // (not .defense) - this is "how eager am I to set up a shot on the
      // threat before it's even landed," the same category of prospective/
      // uncertain defense as urgencyBonus above, not the realized payoff.
      let defensiveSetup = 0;
      if (closestThreat) {
        const blockingShips = state.ships.filter((s) => s.id !== closestThreat.id);
        const pHitClosestThreat = hitProbability(c.point, closestThreat, shipHitRadius(closestThreat), AIM_ERROR_DEG, DISTANCE_ERROR_FACTOR, mountainShapes, blockingShips);
        const distanceGained = Math.max(0, nextClosestThreatDist - currentClosestThreatDist);
        defensiveSetup = pHitClosestThreat * TRAINED_GENOME.urgency * distanceGained * (1 - exposure) * danger;
      }

      // Shield: a shot stops at the first thing it hits (rules.js's
      // resolveShot), so a new ship standing physically between the
      // closest threat and our own base can intercept a shot aimed at the
      // base, not just threaten to shoot back - a distinct mechanism from
      // defensiveSetup above (retaliation potential). Valued by exactly
      // how much it reduces the closest threat's own hit chance against
      // our base (computed with vs. without this hypothetical ship in the
      // blocking-ships list). NOT survival-discounted like setup/
      // defensiveSetup - blocking the shot IS the ship getting hit, not
      // something that only pays off if it's avoided.
      let shieldValue = 0;
      if (myBase && closestThreat) {
        const baseBlockingShips = state.ships.filter((s) => s.id !== closestThreat.id && s.id !== myBase.id);
        const threatWithoutNewShip = hitProbability(closestThreat, myBase, shipHitRadius(myBase), AIM_ERROR_DEG, DISTANCE_ERROR_FACTOR, mountainShapes, baseBlockingShips);
        const hypotheticalShip = { x: c.point.x, y: c.point.y, isBase: false };
        const threatWithNewShip = hitProbability(closestThreat, myBase, shipHitRadius(myBase), AIM_ERROR_DEG, DISTANCE_ERROR_FACTOR, mountainShapes, [...baseBlockingShips, hypotheticalShip]);
        shieldValue = Math.max(0, threatWithoutNewShip - threatWithNewShip) * TRAINED_GENOME.urgency * danger;
      }

      // "Attack if no direct danger, defend if it's imminent": advancing is
      // suppressed as danger rises, so pulling a ship away from a real
      // threat to keep pushing forward stops looking attractive once
      // defense mode is on - the defensive terms above pick up the slack.
      const score = TRAINED_GENOME.advance * progress * (1 - danger) - TRAINED_GENOME.safety * exposure + TRAINED_GENOME.setup * survivalWeightedOpportunity + defensiveSetup + shieldValue;
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

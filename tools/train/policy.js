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
 * Fixed shooting skill for every trained bot - tighter than js/engine/bot.js's
 * "hard" preset (4.5deg/5.5%) on purpose, per explicit request. NOT evolved;
 * only the decision weights in Genome are. MUST match js/engine/trainedBot.js's
 * copy of these two constants - a genome trained at one accuracy and shipped
 * at another is a real, previously-hit failure mode (see tools/train/TODO.md
 * item 3: reusing a genome across a formula/accuracy mismatch once collapsed
 * a 96%-vs-medium bot to a near coin-flip).
 */
export const AIM_ERROR_DEG = 4;
export const DISTANCE_ERROR_FACTOR = 0.12;

/**
 * Default accuracy profile: "I assume the enemy aims about as well as I
 * do." decideMove() takes myAccuracy/enemyAccuracy overrides so training
 * can diverge them - see evolve.js's SHARP_ACCURACY, used to give the
 * population real, repeated pressure from a sharper-than-medium shooter
 * without changing the trained bot's OWN shooting skill (myAccuracy stays
 * at this default; only what a genome assumes about the ENEMY's accuracy,
 * and the actual accuracy of the fixed sharp opponent it's trained
 * against, change).
 */
const DEFAULT_ACCURACY = { aimErrorDeg: AIM_ERROR_DEG, distanceErrorFactor: DISTANCE_ERROR_FACTOR };

const PLACEMENT_CANDIDATE_COUNT = 30;
const PLACEMENT_CANDIDATES_TO_TRY = 8;

/** Hitbox radius to assume for a ship that doesn't exist yet (a placement candidate point), same as js/engine/bot.js's NORMAL_SHIP_HIT_RADIUS. */
const NORMAL_SHIP_HIT_RADIUS = shipHitRadius({ isBase: false });

/**
 * Fixed (not evolved) steepness of the defense-mode transition around
 * genome.criticalDistance - see dangerLevel(). Kept fixed rather than also
 * evolved so the search only has to find WHERE the switch sits, not also
 * how sharp it is; 15 makes it transition from ~10% to ~90% over roughly
 * 0.15 units of distance, sharp enough to read as a real mode change
 * rather than the old smooth, always-a-little-active ramp.
 */
const URGENCY_STEEPNESS = 15;

/**
 * How much "defense mode" should be in effect (0-1) given how close the
 * single worst threat already is to our base - a smooth step centered on
 * genome.criticalDistance, not a hard cutoff (so the search stays
 * differentiable/rankable rather than having a cliff), but sharp enough
 * to behave like a real switch: near 0 well before the threshold, near 1
 * well past it. This is the "try different thresholds for how close an
 * attacker can get before defense sets in" trigger - evolution searches
 * over WHERE genome.criticalDistance sits, rather than a hand-picked guess.
 */
function dangerLevel(currentClosestDist, genome) {
  return 1 / (1 + Math.exp(URGENCY_STEEPNESS * (currentClosestDist - genome.criticalDistance)));
}

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
 * @property {number} defense - value per unit of distance a REALIZED kill
 *   adds to the enemy's closest ship's distance to our own base - only
 *   paid out once the shot actually lands.
 * @property {number} urgency - the same idea as `defense`, but for defense
 *   that hasn't paid off yet and might not: (1) a bonus on a shot at the
 *   closest threat that isn't scaled down by low pHit, so a desperate
 *   low-odds shot at a ship already dangerously close to our base can still
 *   beat a comfortable shot elsewhere (see bestShootCandidate's
 *   `urgencyBonus`); (2) a prospective version of the defense formula
 *   applied to placement candidates, so "put a new ship where it can shoot
 *   the closest threat next turn" is rewarded (see bestPlacementCandidate's
 *   `defensiveSetup`); (3) the value of a placement physically blocking the
 *   closest threat's shot at our base - a shot stops at the first thing it
 *   hits, so a ship placed between the threat and our base can intercept
 *   that shot instead of just threatening to retaliate (see
 *   bestPlacementCandidate's `shieldValue`). Split from `defense` rather
 *   than reusing it (an earlier version did) because they answer different
 *   questions - "how much is landing this worth" vs. "how much is
 *   attempting/setting up/standing in the way worth" - and forcing them to
 *   scale together left evolution unable to value them independently.
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
 * @property {number} criticalDistance - the distance-to-base at which
 *   "defense mode" (see dangerLevel()) is half-on: well above this, danger
 *   is ~0 and urgencyBonus/defensiveSetup/shieldValue barely matter, and
 *   advancing is at full strength; well below it, danger is ~1, advancing
 *   is nearly suppressed, and all three defensive terms are at full
 *   strength. This is what actually answers "how close before the bot
 *   switches to defending" - evolution searches over where to put it
 *   rather than it being a hand-picked constant.
 */

/**
 * Decide one full move for `owner`, given `genome`'s weights.
 * @param {import("../../js/engine/gameState.js").GameState} state
 * @param {1|2} owner
 * @param {Genome} genome
 * @param {{myAccuracy?: {aimErrorDeg:number,distanceErrorFactor:number}, enemyAccuracy?: {aimErrorDeg:number,distanceErrorFactor:number}}} [options] -
 *   myAccuracy governs this player's own shots (defaults to the fixed
 *   "medium" DEFAULT_ACCURACY - the trained bot's real shooting skill,
 *   never evolved); enemyAccuracy governs what this player ASSUMES the
 *   opponent's accuracy is, used only for threat perception (exposure,
 *   shieldValue) - defaults to myAccuracy ("assume the enemy aims about as
 *   well as I do"). Letting these diverge is how training can apply real,
 *   sharper-than-medium pressure (see evolve.js's SHARP_ACCURACY) without
 *   changing what accuracy the trained bot actually ships with.
 * @returns {{type:"shoot", originShip, target, direction:[number,number], speed:number}
 *          |{type:"place", path:Array<{x:number,y:number}>}
 *          |null} null only when there is truly no legal move at all
 */
export function decideMove(state, owner, genome, options = {}) {
  const myAccuracy = options.myAccuracy || DEFAULT_ACCURACY;
  const enemyAccuracy = options.enemyAccuracy || myAccuracy;

  const ownShips = getShipsByOwner(state, owner);
  if (ownShips.length === 0) return null;

  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyShips = getShipsByOwner(state, enemyOwner);
  const myBase = getBaseShip(state, owner);
  const enemyBase = getBaseShip(state, enemyOwner);

  const islandWorldShapes = getPlacedIslandWorldShapes(state.islands, state.map);
  const mountainShapes = islandWorldShapes.flatMap((island) => island.mountainShapes);

  const bestShot = bestShootCandidate(state, ownShips, enemyShips, myBase, mountainShapes, genome, myAccuracy);
  const bestPlacement = bestPlacementCandidate(state, ownShips, enemyShips, myBase, enemyBase, islandWorldShapes, mountainShapes, genome, myAccuracy, enemyAccuracy);

  if (bestShot && (!bestPlacement || bestShot.score >= bestPlacement.score)) return toShootMove(bestShot, myAccuracy);
  if (bestPlacement) return { type: "place", path: bestPlacement.path };
  if (bestShot) return toShootMove(bestShot, myAccuracy); // no legal placement at all - still take the shot rather than pass
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
 * enemy ship already sits (that's what the distance becomes once the
 * closest one is gone).
 */
function bestShootCandidate(state, ownShips, enemyShips, myBase, mountainShapes, genome, myAccuracy) {
  if (enemyShips.length === 0) return null;

  let closestShip = null;
  let currentClosestDist = 0;
  let nextClosestDist = 0;
  let danger = 0;
  if (myBase) {
    const sorted = [...enemyShips].sort((a, b) => distance(a, myBase) - distance(b, myBase));
    closestShip = sorted[0];
    currentClosestDist = distance(closestShip, myBase);
    // No second-closest ship to "fall back to" - leave the delta at 0
    // rather than treating it as infinitely far away.
    nextClosestDist = sorted.length > 1 ? distance(sorted[1], myBase) : currentClosestDist;
    danger = dangerLevel(currentClosestDist, genome);
  }

  let best = null;
  for (const originShip of ownShips) {
    for (const target of enemyShips) {
      const d = distance(originShip, target);
      if (d > MAX_SHOT_DISTANCE) continue; // the real physical shot range (rules.js), not a subjective willingness cutoff
      const blockingShips = state.ships.filter((s) => s.id !== originShip.id && s.id !== target.id);
      const pHit = hitProbability(originShip, target, shipHitRadius(target), myAccuracy.aimErrorDeg, myAccuracy.distanceErrorFactor, mountainShapes, blockingShips);
      if (pHit <= 0) continue;

      const isClosestThreat = closestShip && target.id === closestShip.id;
      const killValue = target.isBase ? genome.hitBase : genome.hitShip;
      const defenseValue = isClosestThreat ? genome.defense * Math.max(0, nextClosestDist - currentClosestDist) : 0;
      // Desperation shot: unlike defenseValue above, this ISN'T scaled by
      // pHit - a legal but low-odds shot (pHit already confirmed > 0) at a
      // ship dangerously close to our base is still worth attempting, since
      // letting it advance further unchallenged is worse than a long shot
      // at stopping it. Uses its own genome.urgency weight, independent of
      // genome.defense - see the Genome typedef for why this was split out
      // (evolution needs to be able to value "attempt a desperate defense"
      // and "land an actual defensive kill" differently, not just scale
      // together).
      const urgencyBonus = isClosestThreat ? genome.urgency * danger : 0;
      const score = pHit * (killValue + defenseValue) + urgencyBonus;

      if (!best || score > best.score) best = { originShip, target, pHit, distance: d, score };
    }
  }
  return best;
}

/**
 * Every legal freehand placement this turn, scored as advance progress plus
 * setup value plus defensive-setup value, minus estimated risk: placing a
 * ship earns nothing on its own beyond how much closer it gets the fleet to
 * the enemy base (advance), how good a shot it opens on ANY enemy ship next
 * turn (setup - see placementRiskAndOpportunity()), how good a shot it
 * opens SPECIFICALLY on the enemy ship currently closest to our own base
 * (defensiveSetup - "post a new ship near home so it can shoot the
 * attacker next turn"), and how likely it is to get that ship sunk next
 * turn (safety, penalized). Without setup/defensiveSetup, "progress" only
 * ever meant immediate straight-line distance to the enemy base, so a
 * placement that clears the way around a blocking enemy ship, or defends
 * home territory instead of advancing at all, could never outscore just
 * standing pat or advancing in a straight line.
 */
function bestPlacementCandidate(state, ownShips, enemyShips, myBase, enemyBase, islandWorldShapes, mountainShapes, genome, myAccuracy, enemyAccuracy) {
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
    danger = dangerLevel(currentClosestThreatDist, genome);
  }

  const raw = sampleCandidateEndpoints(state, ownShips, islandWorldShapes, PLACEMENT_CANDIDATE_COUNT);
  if (raw.length === 0) return null;

  const scored = raw
    .map((c) => {
      const progress = currentMinDist - distance(c.point, enemyBase);
      const { exposure, opportunity } = placementRiskAndOpportunity(state, c.point, enemyShips, mountainShapes, myAccuracy, enemyAccuracy);
      // A setup only pays off if the ship survives the enemy's next turn to
      // actually take the shot - discount it by the enemy's own best odds
      // of sinking it first (1 - exposure = our estimated survival chance),
      // on top of the flat safety*exposure cost every placement already
      // pays regardless of whether it set anything up.
      const survivalWeightedOpportunity = opportunity * (1 - exposure);

      // Defensive setup: same shape as bestShootCandidate's realized
      // defenseValue (pHit * distance gained by removing the closest
      // threat), just computed prospectively for the NEW ship's position
      // instead of an existing one, and survival-discounted the same way
      // as the general setup term above. Uses genome.urgency, not
      // genome.defense - this is "how eager am I to set up a shot on the
      // threat before it's even landed," the same category of prospective/
      // uncertain defense as urgencyBonus above, not the realized payoff.
      // Also scaled by `danger` (see dangerLevel()) - a defensive setup
      // matters most exactly when the threat has actually crossed into
      // "close enough to worry about" territory.
      let defensiveSetup = 0;
      if (closestThreat) {
        const blockingShips = state.ships.filter((s) => s.id !== closestThreat.id);
        const pHitClosestThreat = hitProbability(c.point, closestThreat, shipHitRadius(closestThreat), myAccuracy.aimErrorDeg, myAccuracy.distanceErrorFactor, mountainShapes, blockingShips);
        const distanceGained = Math.max(0, nextClosestThreatDist - currentClosestThreatDist);
        defensiveSetup = pHitClosestThreat * genome.urgency * distanceGained * (1 - exposure) * danger;
      }

      // Shield: a shot stops at the first thing it hits (rules.js's
      // resolveShot), so a new ship standing physically between the
      // closest threat and our own base can intercept a shot aimed at the
      // base, not just threaten to shoot back - a distinct mechanism from
      // defensiveSetup above (retaliation potential) worth its own term.
      // Valued by exactly how much it reduces the closest threat's own hit
      // chance against our base (computed with vs. without this hypothetical
      // ship in the blocking-ships list) - NOT survival-discounted like
      // setup/defensiveSetup, because blocking the shot IS the ship getting
      // hit, not something that only pays off if it's avoided. Reuses
      // genome.urgency, same "prospective/uncertain defense" category as
      // defensiveSetup and urgencyBonus.
      let shieldValue = 0;
      if (myBase && closestThreat) {
        const baseBlockingShips = state.ships.filter((s) => s.id !== closestThreat.id && s.id !== myBase.id);
        const threatWithoutNewShip = hitProbability(closestThreat, myBase, shipHitRadius(myBase), enemyAccuracy.aimErrorDeg, enemyAccuracy.distanceErrorFactor, mountainShapes, baseBlockingShips);
        const hypotheticalShip = { x: c.point.x, y: c.point.y, isBase: false };
        const threatWithNewShip = hitProbability(closestThreat, myBase, shipHitRadius(myBase), enemyAccuracy.aimErrorDeg, enemyAccuracy.distanceErrorFactor, mountainShapes, [...baseBlockingShips, hypotheticalShip]);
        shieldValue = Math.max(0, threatWithoutNewShip - threatWithNewShip) * genome.urgency * danger;
      }

      // "Attack if no direct danger, defend if it's imminent": advancing
      // toward the enemy base is suppressed as danger rises, so a
      // placement pulling a ship AWAY from a real threat to keep pushing
      // forward stops looking attractive once defense mode is on - the
      // defensive terms above are picking up the slack in that regime
      // instead. Untouched at danger=0 (normal play), progress can't help
      // a candidate at all once danger=1.
      const score = genome.advance * progress * (1 - danger) - genome.safety * exposure + genome.setup * survivalWeightedOpportunity + defensiveSetup + shieldValue;
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
 * threatToUs uses enemyAccuracy (it's the enemy's shot at us - what we
 * assume their accuracy is, defaulting to "about as well as we do" unless
 * training overrides it, see decideMove()); shotFromUs uses myAccuracy
 * (it's our own shot at them - our real, fixed shooting skill).
 */
function placementRiskAndOpportunity(state, point, enemyShips, mountainShapes, myAccuracy, enemyAccuracy) {
  let exposure = 0;
  let opportunity = 0;
  for (const enemy of enemyShips) {
    const blockingShips = state.ships.filter((s) => s.id !== enemy.id);

    const threatToUs = hitProbability(enemy, point, NORMAL_SHIP_HIT_RADIUS, enemyAccuracy.aimErrorDeg, enemyAccuracy.distanceErrorFactor, mountainShapes, blockingShips);
    if (threatToUs > exposure) exposure = threatToUs;

    const shotFromUs = hitProbability(point, enemy, shipHitRadius(enemy), myAccuracy.aimErrorDeg, myAccuracy.distanceErrorFactor, mountainShapes, blockingShips);
    if (shotFromUs > opportunity) opportunity = shotFromUs;
  }
  return { exposure, opportunity };
}

function toShootMove(candidate, myAccuracy) {
  const { direction, speed } = aimAt(candidate.originShip, candidate.target, candidate.distance, myAccuracy);
  return { type: "shoot", originShip: candidate.originShip, target: candidate.target, direction, speed };
}

/**
 * True direction/distance to the target, turned into a noisy swipe using
 * `accuracy` - mirrors js/engine/bot.js's aimAt()/distanceToSwipeSpeed()
 * exactly (kept as a small local copy rather than an import, since it's a
 * few lines and bot.js's version is difficulty-shaped).
 */
function aimAt(originShip, target, trueDistance, accuracy) {
  const trueAngle = Math.atan2(target.y - originShip.y, target.x - originShip.x);
  const angleNoise = ((accuracy.aimErrorDeg * Math.PI) / 180) * (Math.random() * 2 - 1);
  const angle = trueAngle + angleNoise;
  const direction = [Math.cos(angle), Math.sin(angle)];

  const distanceNoise = 1 + accuracy.distanceErrorFactor * (Math.random() * 2 - 1);
  const desiredDistance = clamp(trueDistance * distanceNoise, MIN_SHOT_DISTANCE, MAX_SHOT_DISTANCE);
  const t = (desiredDistance - MIN_SHOT_DISTANCE) / (MAX_SHOT_DISTANCE - MIN_SHOT_DISTANCE);
  const speed = MIN_SWIPE_SPEED + clamp(t, 0, 1) * (MAX_SWIPE_SPEED - MIN_SWIPE_SPEED);
  return { direction, speed };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

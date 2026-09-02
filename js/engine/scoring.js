// scoring.js
//
// Computes a single numeric "skill score" per player from the match stats
// already tracked on state - see js/render/ui.js for where it's shown (each
// player's stat bubble in the menu bar, live, and again frozen on the
// victory/high-scores screens).
//
// Pure function: reads `state`, never mutates it, no DOM - same rule as the
// rest of js/engine/ (see CLAUDE.md architecture).

import { getBaseShip, getShipsByOwner } from "./gameState.js";

/**
 * Tunable weights behind computeScore(), kept in one place so the formula's
 * balance can be adjusted without touching the calculation itself:
 *   - ENEMY_SHIP_SUNK / VICTORY_BONUS reward offense that actually lands -
 *     sinking the enemy base at the end is worth far more than any one ship.
 *   - ACCURACY_BONUS_MAX / SHOT_PENALTY reward aiming carefully (CLAUDE.md's
 *     blind, swipe-aimed shot) over spraying blind shots hoping for a hit.
 *   - SHIP_ALIVE_BONUS / SHIP_LOST_PENALTY reward keeping a fleet on the
 *     board - ships "spread across the map like a network" per CLAUDE.md -
 *     and punish losing one (including friendly fire against yourself)
 *     harder than it cost to place.
 *   - PACE_BONUS_MAX / PACE_BONUS_WINDOW_MS reward a swiftly decided match.
 *     It runs off the one shared match clock (js/engine/gameState.js
 *     startMatchClock/endMatchClock), so it decays identically for both
 *     players - it's a "this was a brisk match" bonus, not a measure of
 *     either player's own thinking time.
 */
export const SCORE_WEIGHTS = {
  ENEMY_SHIP_SUNK: 150,
  VICTORY_BONUS: 500,
  ACCURACY_BONUS_MAX: 200,
  SHOT_PENALTY: 5,
  SHIP_ALIVE_BONUS: 20,
  SHIP_LOST_PENALTY: 60,
  PACE_BONUS_MAX: 300,
  PACE_BONUS_WINDOW_MS: 5 * 60 * 1000, // 5 minutes - full bonus decays to 0 by here
};

/**
 * Compute one player's live skill score (see SCORE_WEIGHTS above for the
 * exact formula). Safe to call every frame - like the match clock it reads,
 * it freezes automatically once state.matchEndTime is set, so the same call
 * also produces the final score shown on the victory screen.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner
 * @param {number} time - timestamp (same clock as requestAnimationFrame/
 *   event.timeStamp/startMatchClock) for the current frame; only used for
 *   the live pace bonus, and ignored once state.matchEndTime is set
 * @returns {number} non-negative integer score
 */
export function computeScore(state, owner, time) {
  const stats = state.stats[owner];
  const shipsAlive = getShipsByOwner(state, owner).length;
  const enemyShipsSunk = Math.max(0, stats.hits - stats.ownGoals);
  const accuracy = stats.shots > 0 ? enemyShipsSunk / stats.shots : 0;
  const otherOwner = owner === 1 ? 2 : 1;
  const wonMatch = state.matchEndTime !== null && !getBaseShip(state, otherOwner);

  let score =
    enemyShipsSunk * SCORE_WEIGHTS.ENEMY_SHIP_SUNK +
    accuracy * SCORE_WEIGHTS.ACCURACY_BONUS_MAX -
    stats.shots * SCORE_WEIGHTS.SHOT_PENALTY +
    shipsAlive * SCORE_WEIGHTS.SHIP_ALIVE_BONUS -
    stats.shipsLost * SCORE_WEIGHTS.SHIP_LOST_PENALTY;

  if (wonMatch) score += SCORE_WEIGHTS.VICTORY_BONUS;

  if (state.matchStartTime !== null) {
    const elapsed = (state.matchEndTime ?? time) - state.matchStartTime;
    const paceProgress = Math.min(1, Math.max(0, elapsed / SCORE_WEIGHTS.PACE_BONUS_WINDOW_MS));
    score += SCORE_WEIGHTS.PACE_BONUS_MAX * (1 - paceProgress);
  }

  return Math.max(0, Math.round(score));
}

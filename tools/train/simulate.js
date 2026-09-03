// simulate.js
//
// Headless self-play: two Genome-driven policies (see policy.js) play one
// full match of Insel-Schlacht against the real game engine (js/engine/) -
// no rendering, no timers, no DOM, just actions.js/gameState.js calls, as
// fast as Node can go. Used by evolve.js to score candidate genomes.

import { Phase, createGameState, getBaseShip, getShipsByOwner, isGameOver, setIslandLibrary, setPhase } from "../../js/engine/gameState.js";
import { endTurn, fireShot, placeShip, restartGame } from "../../js/engine/actions.js";
import { distance } from "../../js/engine/rules.js";
import { decideMove } from "./policy.js";

/**
 * Fixed, un-evolved yardstick used to grade a finished game - deliberately
 * separate from each side's Genome (the weights it actually plays with).
 * If fitness were measured using a genome's own weights, a genome could
 * just inflate its numbers to look "fit" without playing any better -
 * evolve.js needs one common ruler every genome is measured against.
 */
export const FITNESS = {
  hitShip: 10,
  hitBase: 200,
  advance: 50, // per unit (0-1 map scale) closer to the enemy base
  defense: 50, // per unit (0-1 map scale) the enemy's closest ship to our base retreats (i.e. gets sunk)
  win: 1000,
  loss: -1500,
  // Subtracted from the winner's `win` bonus, once per turn the match took -
  // winning in 15 turns is worth more than winning in 150. Only applied to
  // the winner (see applyOutcomeBonus): a flat per-turn cost applied to
  // BOTH players equally would cancel out of the margin (fitness[1] -
  // fitness[2]) evolve.js actually selects on, since it'd be identical on
  // both sides of the same match - it has to be asymmetric to shape
  // anything. WIN_SPEED_FLOOR guarantees a win is always worth more than a
  // loss even in a near-MAX_TURNS win.
  speedPenaltyPerTurn: 2,
  // The actual objective is hitting the enemy base - everything else
  // (ordinary kills, advance, defense) is a real event but not THE event.
  // Losing means that objective was never met, so the loser's accumulated
  // mid-game fitness is heavily discounted (not zeroed - inflicting some
  // damage before losing is still marginally better than losing having
  // done nothing) before the flat `loss` penalty is added - see
  // applyOutcomeBonus(). Without this, a genome that racks up kills/
  // advance but still loses could end up with a similar-looking fitness to
  // one that barely engaged at all, diluting the "winning is what matters"
  // signal evolution is supposed to be selecting on.
  loserAccumulatedDiscount: 0.25,
};

const WIN_SPEED_FLOOR = 50;

export const MAX_TURNS = 400; // safety net against a pathological stalemate - exported so evolve.js can flag a game that hit it

/**
 * Play one full match between two genomes.
 * @param {import("./policy.js").Genome} genome1 - player 1's weights
 * @param {import("./policy.js").Genome} genome2 - player 2's weights
 * @param {Array} islandLibrary - see loadIslands.js
 * @param {number} seed - map seed, for a reproducible match
 * @param {{1?: object, 2?: object}} [accuracyOptions] - per-player options
 *   object passed straight through to policy.js's decideMove() (its
 *   `{myAccuracy, enemyAccuracy}`) - omit for both players at the default
 *   "medium" accuracy on both sides. See evolve.js's SHARP_ACCURACY for why
 *   this exists: training a genome against a fixed, more-accurate-than-
 *   medium opponent without changing the genome's OWN shooting skill.
 * @returns {{winner: 1|2|null, turns: number, fitness: {1:number, 2:number}}}
 *   winner is null on a MAX_TURNS stalemate or a genuinely stuck bot
 */
export function playMatch(genome1, genome2, islandLibrary, seed, accuracyOptions = {}) {
  const state = createGameState();
  setIslandLibrary(state, islandLibrary);
  restartGame(state, seed);

  const genomes = { 1: genome1, 2: genome2 };
  const fitness = { 1: 0, 2: 0 };
  let turns = 0;

  while (!isGameOver(state) && turns < MAX_TURNS) {
    turns++;
    const player = state.currentPlayer;
    const move = decideMove(state, player, genomes[player], accuracyOptions[player]);
    if (!move) break; // truly no legal move - treat as a draw rather than loop forever

    if (move.type === "shoot") {
      playShoot(state, player, move, fitness);
      if (isGameOver(state)) break;
    } else {
      playPlacement(state, player, move, fitness);
    }
  }

  return { winner: winnerOf(state), turns, fitness: applyOutcomeBonus(state, fitness, turns) };
}

/** Resolve one shot, crediting fitness for a kill and, if it was the enemy's biggest threat, for the defensive gain. */
function playShoot(state, player, move, fitness) {
  const myBase = getBaseShip(state, player);
  const prevClosest = myBase ? closestEnemyDistance(state, player, myBase) : null;

  const { sunkShip } = fireShot(state, move.originShip, move.direction, move.speed, turnsAsTimestamp());

  if (sunkShip) {
    fitness[player] += sunkShip.isBase ? FITNESS.hitBase : FITNESS.hitShip;

    // Defensive credit only makes sense for an enemy ship sunk (not friendly
    // fire) that wasn't itself the enemy base (that case already ends the
    // game via isGameOver() below, and "distance to the enemy's closest
    // ship" is meaningless once there are no enemy ships left at all).
    if (sunkShip.owner !== player && !sunkShip.isBase && myBase && Number.isFinite(prevClosest)) {
      const newClosest = closestEnemyDistance(state, player, myBase);
      if (Number.isFinite(newClosest)) fitness[player] += FITNESS.defense * Math.max(0, newClosest - prevClosest);
    }
  }

  if (isGameOver(state)) return;

  if (sunkShip && sunkShip.owner !== player) {
    setPhase(state, Phase.PLACING); // sinking an enemy ship grants the shooter another turn (CLAUDE.md)
  } else {
    endTurn(state); // a miss, or a friendly-fire sinking, ends the turn as normal
  }
}

/** Place one ship, crediting fitness only for how much closer to the enemy base it got the fleet. */
function playPlacement(state, player, move, fitness) {
  const enemyBase = getBaseShip(state, player === 1 ? 2 : 1);
  const prevMin = enemyBase ? minDistanceToEnemyBase(state, player, enemyBase) : null;

  const ship = placeShip(state, player, move.path);
  if (!ship) return; // shouldn't happen - decideMove only ever proposes legal paths

  if (enemyBase && Number.isFinite(prevMin)) {
    const newMin = minDistanceToEnemyBase(state, player, enemyBase);
    fitness[player] += FITNESS.advance * Math.max(0, prevMin - newMin);
  }
  endTurn(state); // simulation skips the human "undo" confirmation window entirely - a bot never wants to undo its own move
}

function minDistanceToEnemyBase(state, owner, enemyBase) {
  return Math.min(...getShipsByOwner(state, owner).map((s) => distance(s, enemyBase)));
}

/** Closest surviving ship belonging to `owner`'s enemy, distance to `myBase`. Infinity if the enemy somehow has no ships left (game over). */
function closestEnemyDistance(state, owner, myBase) {
  const enemyOwner = owner === 1 ? 2 : 1;
  const enemyShips = getShipsByOwner(state, enemyOwner);
  if (enemyShips.length === 0) return Infinity;
  return Math.min(...enemyShips.map((s) => distance(s, myBase)));
}

function winnerOf(state) {
  if (!isGameOver(state)) return null;
  return getBaseShip(state, 1) ? 1 : 2;
}

/**
 * Adds the big win/loss bonus on top of whatever fitness accrued turn by
 * turn - a decisive win should always outweigh accumulated small-event
 * points - and shrinks the winner's bonus by how long the match took, so a
 * fast win scores higher than a slow one (see FITNESS.speedPenaltyPerTurn).
 * The loser's own accumulated fitness (never negative - see playShoot/
 * playPlacement, every event they add is a non-negative credit) is also
 * heavily discounted before the flat `loss` penalty is added - see
 * FITNESS.loserAccumulatedDiscount.
 */
function applyOutcomeBonus(state, fitness, turns) {
  const winner = winnerOf(state);
  if (!winner) return fitness;
  const loser = winner === 1 ? 2 : 1;
  const winBonus = Math.max(WIN_SPEED_FLOOR, FITNESS.win - FITNESS.speedPenaltyPerTurn * turns);
  const discountedLoserFitness = fitness[loser] * FITNESS.loserAccumulatedDiscount;
  return { ...fitness, [winner]: fitness[winner] + winBonus, [loser]: discountedLoserFitness + FITNESS.loss };
}


/** fireShot() only uses `time` to stamp shotLine/sinking-animation timestamps we never read headlessly - any increasing number works. */
let simulatedClock = 0;
function turnsAsTimestamp() {
  return ++simulatedClock;
}

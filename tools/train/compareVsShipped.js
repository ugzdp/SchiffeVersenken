// compareVsShipped.js
//
// The comparison this whole exercise was actually for: does the trained
// genome (best-genome.json) beat the REAL shipped bot (js/engine/bot.js's
// "medium" difficulty, the same tiered P0-P4 logic players actually face)?
// simulate.js's FITNESS/BENCHMARK numbers only ever measured progress
// against this project's own arbitrary starting-point guess - never
// against what's actually in the game.
//
// Run with:  node tools/train/compareVsShipped.js

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Phase, createGameState, getBaseShip, isGameOver, recordBotShotOutcome, setIslandLibrary, setPhase } from "../../js/engine/gameState.js";
import { endTurn, fireShot, placeShip, restartGame } from "../../js/engine/actions.js";
import { decideBotMove } from "../../js/engine/bot.js";
import { loadIslandLibrary } from "./loadIslands.js";
import { decideMove } from "./policy.js";

const GAMES = 100;
const MAX_TURNS = 400;

const __dirname = dirname(fileURLToPath(import.meta.url));
const genome = JSON.parse(readFileSync(join(__dirname, "best-genome.json"), "utf8"));

const trainedMove = (state, owner) => decideMove(state, owner, genome);
const shippedMove = (state, owner) => decideBotMove(state, owner, "medium");

/** Same turn loop as simulate.js's playMatch, minus fitness bookkeeping - all that matters here is who wins and how long it took. */
function playOneGame(moveFn1, moveFn2, islandLibrary, seed) {
  const state = createGameState();
  setIslandLibrary(state, islandLibrary);
  restartGame(state, seed);
  const moveFns = { 1: moveFn1, 2: moveFn2 };
  let turns = 0;

  while (!isGameOver(state) && turns < MAX_TURNS) {
    turns++;
    const player = state.currentPlayer;
    const move = moveFns[player](state, player);
    if (!move) break;

    if (move.type === "shoot") {
      const { sunkShip } = fireShot(state, move.originShip, move.direction, move.speed, turns);
      // js/engine/bot.js's own miss-avoidance (MAX_MISSES_BEFORE_AVOIDING_ORIGIN)
      // reads this same table - without recording outcomes here, the shipped
      // bot would never "learn" within a match the way it does in the real
      // game (js/botController.js records this after every shot).
      recordBotShotOutcome(state, move.originShip.id, move.target.id, sunkShip ? sunkShip.id : null);
      if (isGameOver(state)) break;
      if (sunkShip && sunkShip.owner !== player) setPhase(state, Phase.PLACING);
      else endTurn(state);
    } else {
      const ship = placeShip(state, player, move.path);
      if (!ship) break;
      endTurn(state);
    }
  }

  const winner = isGameOver(state) ? (getBaseShip(state, 1) ? 1 : 2) : null;
  return { winner, turns };
}

function run() {
  const islandLibrary = loadIslandLibrary();
  let trainedWins = 0;
  let shippedWins = 0;
  let draws = 0;
  let totalTurns = 0;

  for (let g = 0; g < GAMES; g++) {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const trainedIsPlayer1 = g % 2 === 0; // alternate sides to cancel out any first-move edge
    const move1 = trainedIsPlayer1 ? trainedMove : shippedMove;
    const move2 = trainedIsPlayer1 ? shippedMove : trainedMove;
    const { winner, turns } = playOneGame(move1, move2, islandLibrary, seed);
    totalTurns += turns;

    if (winner === null) draws++;
    else if (winner === (trainedIsPlayer1 ? 1 : 2)) trainedWins++;
    else shippedWins++;
  }

  console.log(`Trained genome: ${JSON.stringify(genome)}`);
  console.log(`${GAMES} games (sides alternated) - trained genome vs js/engine/bot.js "medium":`);
  console.log(`  trained bot won:       ${trainedWins} (${((trainedWins / GAMES) * 100).toFixed(1)}%)`);
  console.log(`  shipped medium bot won: ${shippedWins} (${((shippedWins / GAMES) * 100).toFixed(1)}%)`);
  console.log(`  draws/stalemates:      ${draws}`);
  console.log(`  avg turns/game:        ${(totalTurns / GAMES).toFixed(1)}`);
}

run();

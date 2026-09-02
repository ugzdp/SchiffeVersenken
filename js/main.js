 // main.js
//
// Bootstrap: sets up the canvas, handles resizing, creates the single game
// state instance, and starts a render loop driven by js/render/renderer.js.
// Once the player picks Multiplayer or Single Player (+ bot difficulty) on
// the start modal, loads the island library, generates a map, spawns both
// base ships at their fixed start positions, and wires up freehand
// drag-path ship placement (js/input.js) plus, for single-player, the bot's
// own turn-taking (js/botController.js). This file holds the project's one
// allowed global: `state`.

import { createGameState, setIslandLibrary, setMap, addShip, startMatchClock, setMatchMode } from "./engine/gameState.js";
import {
  initMenuBar,
  initPlacementConfirmUI,
  initShootButton,
  initShootUI,
  initStartModal,
  updateMenuBar,
  updatePlacementConfirmUI,
  updateShootButton,
  updateShootUI,
  updateTimer,
} from "./render/ui.js";
import { loadIslandLibrary } from "./data/islandLoader.js";
import { generateMap } from "./engine/mapGenerator.js";
import { restartGame } from "./engine/actions.js";
import { BASE_SHIP_START } from "./engine/rules.js";
import { render } from "./render/renderer.js";
import { initInput } from "./input.js";
import { initBotController } from "./botController.js";

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");
const uiOverlay = document.getElementById("ui-overlay");

// The single game state instance for this match (see js/engine/gameState.js).
const state = createGameState();

// Handle returned by js/input.js once the match starts, exposing the
// "undo" cross button's click handler and a way to cancel its timer on
// restart (see startMatch()/restartMatch() below).
let inputHandle = null;

// Handle returned by js/botController.js once a single-player match starts
// (state.mode === "pvb"); null in a PvP match. update() is polled every
// frame from gameLoop(), same as the UI's own per-frame sync calls.
let botHandle = null;

// Game UI (menu bar) and the match itself only start once the player picks
// Multiplayer/Single Player (and, for Single Player, a bot difficulty) on
// the start modal shown at page load.
initStartModal(uiOverlay, (mode, botDifficulty) => {
  startMatch(mode, botDifficulty);
});

/**
 * Load the island library, generate a random map, spawn both players' base
 * ships at their fixed start positions, and wire up ship-placement input
 * (plus the bot's own turn-taking, for a single-player match).
 * @param {"pvp"|"pvb"} mode
 * @param {"easy"|"medium"|"hard"|null} botDifficulty
 * @returns {Promise<void>}
 */
async function startMatch(mode, botDifficulty) {
  setMatchMode(state, mode, botDifficulty);
  setIslandLibrary(state, await loadIslandLibrary());

  const seed = Math.floor(Math.random() * 2 ** 31);
  setMap(state, generateMap(state.islands, seed));
  spawnBaseShips(state);
  startMatchClock(state, performance.now());

  initMenuBar(uiOverlay, state, { onRestart: () => restartMatch() });
  initShootButton(uiOverlay, state);
  initShootUI(uiOverlay);
  const onTurnChanged = () => {
    updateMenuBar(uiOverlay, state);
    updateShootButton(uiOverlay, state);
  };
  inputHandle = initInput(canvas, state, onTurnChanged);
  initPlacementConfirmUI(uiOverlay, () => inputHandle.revertPendingPlacement());
  botHandle = state.mode === "pvb" ? initBotController(state, onTurnChanged) : null;
}

/**
 * Handle the "Restart game" settings menu item: reshuffle the islands into
 * a brand new random map, remove every ship in play, and re-spawn both
 * base ships at their fixed positions, then refresh UI that isn't redrawn
 * every frame (the menu bar's active-player highlight).
 * @returns {void}
 */
function restartMatch() {
  restartGame(state);
  startMatchClock(state, performance.now());
  if (inputHandle) inputHandle.cancelPendingPlacementTimer();
  if (botHandle) botHandle.reset();
  state.dragPath = null;
  state.pendingPlacement = null;
  state.shotLine = null;
  state.sinkingShips = [];
  state.warning = null;
  updateMenuBar(uiOverlay, state);
  updateShootButton(uiOverlay, state);
}

/**
 * Place each player's base ship at its fixed match-start position
 * (BASE_SHIP_START in rules.js) - always the same spot every game,
 * independent of the random map, player 1 near the bottom-left corner
 * and player 2 near the top-right.
 * @param {import("./engine/gameState.js").GameState} state
 * @returns {void}
 */
function spawnBaseShips(state) {
  for (const owner of [1, 2]) {
    const { x, y } = BASE_SHIP_START[owner];
    addShip(state, { id: `p${owner}-base`, owner, x, y, isBase: true });
  }
}

/**
 * Resize the canvas to fill the window at native device resolution, so
 * drawings stay crisp on high-DPI screens like iPhone/iPad.
 */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = window.innerWidth;
  const cssHeight = window.innerHeight;

  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  // Draw in CSS pixels; the canvas buffer itself holds the extra DPR detail.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Main render loop: draws ocean, islands, ships and the in-progress drag
 * path every frame via js/render/renderer.js. Before the match starts
 * (map/ships not yet set up) this just shows open ocean.
 * @param {number} time - ms timestamp from requestAnimationFrame
 */
function gameLoop(time) {
  const cssWidth = canvas.width / (window.devicePixelRatio || 1);
  const cssHeight = canvas.height / (window.devicePixelRatio || 1);

  render(ctx, state, cssWidth, cssHeight, time);
  // Guard against checking win state before a match actually exists: right
  // after page load (or mid-way through the async startMatch()), state.map
  // is still null and no base ships have been spawned yet, which would
  // otherwise make isGameOver() look true (no base ships => "missing").
  if (state.map) {
    updateTimer(uiOverlay, state, time);
    updateMenuBar(uiOverlay, state, time); // keeps each stat bubble's live score (see js/engine/scoring.js) ticking every frame
    updateShootUI(uiOverlay, state, time, { onRematch: () => restartMatch() });
    updatePlacementConfirmUI(uiOverlay, state, cssWidth, cssHeight);
    if (botHandle) botHandle.update(time);
  }

  requestAnimationFrame(gameLoop);
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);
// iOS Safari fires orientationchange separately from resize in some cases.
window.addEventListener("orientationchange", resizeCanvas);

gameLoop();

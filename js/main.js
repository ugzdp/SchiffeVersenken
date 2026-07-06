// main.js
//
// Bootstrap only: sets up the canvas, handles resizing, creates the single
// game state instance, and starts a render loop that (for now) just clears
// the screen to the ocean color. No island loading, no map generation, no
// input handling yet — those come in later steps per CLAUDE.md's workflow
// ("implement one feature per request, keep the game runnable at every
// step"). This file holds the project's one allowed global: `state`.

import { createGameState } from "./engine/gameState.js";

const OCEAN_COLOR = "#0a3d5c";

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

// The single game state instance for this match (see js/engine/gameState.js).
const state = createGameState();

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
 * Main render loop. Right now there is nothing to draw but the ocean —
 * islands, ships and UI are added as those features are implemented.
 */
function gameLoop() {
  const cssWidth = canvas.width / (window.devicePixelRatio || 1);
  const cssHeight = canvas.height / (window.devicePixelRatio || 1);

  ctx.fillStyle = OCEAN_COLOR;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  requestAnimationFrame(gameLoop);
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);
// iOS Safari fires orientationchange separately from resize in some cases.
window.addEventListener("orientationchange", resizeCanvas);

gameLoop();

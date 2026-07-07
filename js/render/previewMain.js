// previewMain.js
//
// Standalone render loop for previewing renderer.js/effects.js against
// mockState.js (see preview.html). Scaffolding only - never imported by
// the real game's js/main.js.

import { render } from "./renderer.js";
import { createMockState } from "./mockState.js";

const canvas = document.getElementById("preview-canvas");
const ctx = canvas.getContext("2d");

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

resize();
window.addEventListener("resize", resize);

const state = createMockState(performance.now());

function loop(time) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  render(ctx, state, width, height, time);
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
// effects.js
//
// Time-based visual effects layered on top of the static scene drawn by
// renderer.js: the subtle animated water texture, the shot tracer shown
// during Phase.SHOT_RESOLVE (CLAUDE.md Action B step 5), and the sinking
// animation played when a ship is hit (Action B step 6). Like
// renderer.js, every function here is a pure function of its inputs - it
// only reads what it's given, never owns state, never fetches data.

import { getUnit, relToPixel } from "./coords.js";
import { colorsForOwner, SHIP_RADIUS_FACTOR, BASE_SHIP_RADIUS_FACTOR } from "./theme.js";

const WATER_LINE_COLOR = "rgba(255, 255, 255, 0.08)";
const WATER_ROW_COUNT = 6;

const SHOT_LINE_DURATION_MS = 1400; // how long the tracer stays visible before fading out
const SINK_DURATION_MS = 1200;
const WRECK_CROSS_FADE_OUT_MS = 1400; // starts the instant the ship's own fade-out ends
const WRECK_CROSS_COLOR = "#e0483f";
const WRECK_CROSS_OUTLINE = "#5a1512";

/**
 * Subtle animated water: a handful of slowly-drifting sine-wave ripple
 * lines over the ocean base color. Deliberately understated per
 * CLAUDE.md ("subtle water animation") - this is background texture,
 * not a wave simulation.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {number} time - ms timestamp
 */
export function drawWaterAnimation(ctx, width, height, time) {
  const t = time / 1000;

  ctx.save();
  ctx.strokeStyle = WATER_LINE_COLOR;
  ctx.lineWidth = 2;
  for (let row = 0; row < WATER_ROW_COUNT; row++) {
    const y = (height / WATER_ROW_COUNT) * (row + 0.5);
    const speed = 0.5 + row * 0.12;
    const phase = t * speed + row;

    ctx.beginPath();
    for (let x = 0; x <= width; x += 24) {
      const wobble = Math.sin(x * 0.02 + phase) * 6;
      const py = y + wobble;
      if (x === 0) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw the resolved shot's tracer line so both players see where it
 * went. Fades out over SHOT_LINE_DURATION_MS starting at
 * shotLine.startTime; draws nothing before startTime or once expired.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{fromX:number, fromY:number, toX:number, toY:number, owner:1|2, startTime:number}|null|undefined} shotLine
 * @param {number} width
 * @param {number} height
 * @param {number} time - ms timestamp
 */
export function drawShotLine(ctx, shotLine, width, height, time) {
  if (!shotLine) return;
  const elapsed = time - shotLine.startTime;
  if (elapsed < 0 || elapsed > SHOT_LINE_DURATION_MS) return;

  const unit = getUnit(width, height);
  const from = relToPixel(shotLine.fromX, shotLine.fromY, width, height);
  const to = relToPixel(shotLine.toX, shotLine.toY, width, height);
  const colors = colorsForOwner(shotLine.owner);
  const alpha = 1 - elapsed / SHOT_LINE_DURATION_MS;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";

  ctx.strokeStyle = colors.outline;
  ctx.lineWidth = Math.max(3, unit * 0.014);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  // Bright core on top of the dark outline so the tracer reads clearly
  // against both light water and dark land.
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1.5, unit * 0.006);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw ships that are mid-sink: shrink, spin and fade out over
 * SINK_DURATION_MS, with an expanding ripple ring standing in for the
 * splash. A red wreck cross marks the spot: it fades in over the same
 * SINK_DURATION_MS window as the ship's fade-out (starting at the same
 * moment), then, the instant the ship has fully faded, fades back out
 * over WRECK_CROSS_FADE_OUT_MS. These ships have already been removed
 * from state.ships by actions.js; the caller (input.js/actions.js) is
 * expected to keep them in this list only long enough for the whole
 * ship+cross animation to finish.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number, y:number, owner:1|2, isBase:boolean, startTime:number}>|null|undefined} sinkingShips
 * @param {number} width
 * @param {number} height
 * @param {number} time - ms timestamp
 */
export function drawSinkingShips(ctx, sinkingShips, width, height, time) {
  if (!sinkingShips || sinkingShips.length === 0) return;
  const unit = getUnit(width, height);
  const totalDuration = SINK_DURATION_MS + WRECK_CROSS_FADE_OUT_MS;

  for (const ship of sinkingShips) {
    const elapsed = time - ship.startTime;
    if (elapsed < 0 || elapsed > totalDuration) continue;

    const pos = relToPixel(ship.x, ship.y, width, height);
    const baseRadius = (ship.isBase ? BASE_SHIP_RADIUS_FACTOR : SHIP_RADIUS_FACTOR) * unit;

    if (elapsed <= SINK_DURATION_MS) {
      const progress = elapsed / SINK_DURATION_MS;
      const colors = colorsForOwner(ship.owner);

      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(progress * Math.PI * 0.6);
      ctx.globalAlpha = 1 - progress;
      const shrink = 1 - progress * 0.7;
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius * shrink, 0, Math.PI * 2);
      ctx.fillStyle = colors.hull;
      ctx.fill();
      ctx.lineWidth = Math.max(2, baseRadius * 0.25);
      ctx.strokeStyle = colors.outline;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = (1 - progress) * 0.5;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, baseRadius * (1 + progress * 2.5), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      drawWreckCross(ctx, pos, baseRadius, progress);
    } else {
      const fadeOutProgress = (elapsed - SINK_DURATION_MS) / WRECK_CROSS_FADE_OUT_MS;
      drawWreckCross(ctx, pos, baseRadius, 1 - fadeOutProgress);
    }
  }
}

/** Red X mark used to fade in/out over a sunk ship's position. `alpha` is 0-1. */
function drawWreckCross(ctx, pos, baseRadius, alpha) {
  const size = baseRadius * 0.8;

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";

  ctx.lineWidth = Math.max(3, baseRadius * 0.32);
  ctx.strokeStyle = WRECK_CROSS_OUTLINE;
  drawCrossStrokes(ctx, size);

  ctx.lineWidth = Math.max(1.5, baseRadius * 0.16);
  ctx.strokeStyle = WRECK_CROSS_COLOR;
  drawCrossStrokes(ctx, size);

  ctx.restore();
}

function drawCrossStrokes(ctx, size) {
  ctx.beginPath();
  ctx.moveTo(-size, -size);
  ctx.lineTo(size, size);
  ctx.moveTo(size, -size);
  ctx.lineTo(-size, size);
  ctx.stroke();
}
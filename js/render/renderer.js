// renderer.js
//
// All drawing for the game board itself: ocean, islands (shallow-water
// ring + beach + mountain layers), ships, and the in-progress drag line
// used while placing a new ship (CLAUDE.md Action A). Every function here
// is a pure function of (ctx, state) or plain data - it only reads state,
// never mutates it, and never fetches data, per CLAUDE.md's engine/render
// separation. Time-based animation (water ripples, the shot tracer,
// sinking ships) lives in effects.js; render() below calls into it so
// main.js only has to drive one render loop.

import { getUnit, relToPixel, islandLocalToPixel, islandPolygonToPixels } from "./coords.js";
import { colorsForOwner, SHIP_RADIUS_FACTOR, BASE_SHIP_RADIUS_FACTOR } from "./theme.js";
import { drawWaterAnimation, drawShotLine, drawSinkingShips } from "./effects.js";

const OCEAN_COLOR = "#0a4a6e";
const SHALLOW_WATER_COLOR = "rgba(120, 210, 225, 0.5)";
const SHALLOW_WATER_MARGIN = 1.18; // how much bigger than the beach the shallow ring extends

const BEACH_COLOR = "#e8cf8a";
const BEACH_OUTLINE = "#33261a";
const BEACH_LINE_WIDTH = 5;

const MOUNTAIN_COLOR = "#9098a0";
const MOUNTAIN_OUTLINE = "#3a3f45";
const MOUNTAIN_LINE_WIDTH = 3;

const PALM_CANOPY_COLOR = "#2f7a3d";
const PALM_CANOPY_OUTLINE = "#1e4d27";
const PALM_TRUNK_COLOR = "#6b4a2b";

const INVALID_LINE_COLOR = "#e0483f";
const INVALID_LINE_OUTLINE = "#7a1f1a";

/**
 * Draw one full frame: ocean, islands, ships, the drag line, the shot
 * line and any ships mid-sinking-animation. Call this once per animation
 * frame from the game loop in main.js.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("../engine/gameState.js").GameState & {
 *   dragPath?: {points: Array<{x:number,y:number}>, owner:1|2, valid?:boolean}|null,
 *   shotLine?: {fromX:number, fromY:number, toX:number, toY:number, owner:1|2, startTime:number}|null,
 *   sinkingShips?: Array<{x:number, y:number, owner:1|2, isBase:boolean, startTime:number}>
 * }} state - the shared GameState, plus fields that input.js/actions.js
 *   will start populating once they exist (see mockState.js for shapes).
 * @param {number} width - canvas CSS width
 * @param {number} height - canvas CSS height
 * @param {number} time - ms timestamp, e.g. from requestAnimationFrame
 */
export function render(ctx, state, width, height, time) {
  renderOcean(ctx, width, height, time);
  renderIslands(ctx, state, width, height);
  renderDragPath(ctx, state.dragPath, width, height);
  renderShips(ctx, state, width, height);
  drawShotLine(ctx, state.shotLine, width, height, time);
  drawSinkingShips(ctx, state.sinkingShips, width, height, time);
}

/** Ocean base color plus the subtle animated water texture from effects.js. */
export function renderOcean(ctx, width, height, time) {
  ctx.fillStyle = OCEAN_COLOR;
  ctx.fillRect(0, 0, width, height);
  drawWaterAnimation(ctx, width, height, time);
}

/**
 * Draw every placed island: shallow-water ring, beach fill+outline,
 * mountain polygons on top, then decorations.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{map: import("../engine/gameState.js").GeneratedMap|null, islands: import("../engine/gameState.js").IslandLibraryEntry[]}} state
 */
export function renderIslands(ctx, state, width, height) {
  if (!state.map) return;

  for (const placement of state.map.islands) {
    const shape = state.islands.find((entry) => entry.id === placement.islandId);
    if (!shape) continue; // shape not loaded (yet) - skip rather than throw

    drawShallowWater(ctx, shape.landShape, placement, width, height);
    drawBeach(ctx, shape.landShape, placement, width, height);
    for (const mountain of shape.mountainShapes || []) {
      drawMountain(ctx, mountain, placement, width, height);
    }
    for (const decoration of shape.decorations || []) {
      drawDecoration(ctx, decoration, placement, width, height);
    }
  }
}

/**
 * Draw every ship in play, colored per owner, base ships bigger.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ships: import("../engine/gameState.js").Ship[]}} state
 */
export function renderShips(ctx, state, width, height) {
  for (const ship of state.ships || []) {
    drawShip(ctx, ship, width, height);
  }
}

/**
 * Draw the in-progress freehand drag path for Action A (placing a new
 * ship): a dashed polyline tracing every point the finger has actually
 * visited so far, capped at max length and stopped from crossing land
 * (that's the engine's job - see rules.js's tryExtendDragPath - this just
 * draws whatever points it's given), plus a translucent preview of the
 * ship that would spawn at the path's end. Drawn in the player's own color
 * while the path's endpoint is a legal placement, red once it isn't
 * (landing on another ship) - see rules.js's isValidShipPlacementPath,
 * which input.js checks live while dragging.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{points: Array<{x:number,y:number}>, owner:1|2, valid?:boolean}|null|undefined} dragPath
 */
export function renderDragPath(ctx, dragPath, width, height) {
  if (!dragPath || dragPath.points.length === 0) return;
  const unit = getUnit(width, height);
  const points = dragPath.points.map((point) => relToPixel(point.x, point.y, width, height));
  const ownerColors = colorsForOwner(dragPath.owner);
  const hull = dragPath.valid ? ownerColors.hull : INVALID_LINE_COLOR;
  const outline = dragPath.valid ? ownerColors.outline : INVALID_LINE_OUTLINE;

  ctx.save();
  ctx.setLineDash([unit * 0.02, unit * 0.014]);
  ctx.lineWidth = Math.max(2, unit * 0.01);
  ctx.strokeStyle = hull;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.stroke();
  ctx.restore();

  const to = points[points.length - 1];
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(to.x, to.y, SHIP_RADIUS_FACTOR * unit, 0, Math.PI * 2);
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, unit * 0.006);
  ctx.strokeStyle = outline;
  ctx.stroke();
  ctx.restore();
}

// --- internal helpers -------------------------------------------------

function drawShip(ctx, ship, width, height) {
  const unit = getUnit(width, height);
  const pos = relToPixel(ship.x, ship.y, width, height);
  const colors = colorsForOwner(ship.owner);

  ctx.save();
  ctx.translate(pos.x, pos.y);

  const radius = ship.isBase ? BASE_SHIP_RADIUS_FACTOR : SHIP_RADIUS_FACTOR;
  drawHull(ctx, colors, radius * unit);

  ctx.restore();
}

/** Simple cartoon hull: a rounded, elongated shape with a pointed bow. Ships have no stored heading, so it's always drawn "bow up". */
function drawHull(ctx, colors, radius) {
  ctx.beginPath();
  ctx.moveTo(0, -radius * 1.3);
  ctx.lineTo(radius * 0.7, -radius * 0.2);
  ctx.lineTo(radius * 0.6, radius * 0.9);
  ctx.lineTo(-radius * 0.6, radius * 0.9);
  ctx.lineTo(-radius * 0.7, -radius * 0.2);
  ctx.closePath();
  ctx.fillStyle = colors.hull;
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, radius * 0.22);
  ctx.strokeStyle = colors.outline;
  ctx.stroke();
}

function drawShallowWater(ctx, landShape, placement, width, height) {
  const expanded = landShape.map(([x, y]) => [
    0.5 + (x - 0.5) * SHALLOW_WATER_MARGIN,
    0.5 + (y - 0.5) * SHALLOW_WATER_MARGIN,
  ]);
  const points = islandPolygonToPixels(expanded, placement, width, height);
  fillPolygon(ctx, points, SHALLOW_WATER_COLOR);
}

function drawBeach(ctx, landShape, placement, width, height) {
  const points = islandPolygonToPixels(landShape, placement, width, height);
  fillAndStrokePolygon(ctx, points, BEACH_COLOR, BEACH_OUTLINE, BEACH_LINE_WIDTH);
}

function drawMountain(ctx, mountainShape, placement, width, height) {
  const points = islandPolygonToPixels(mountainShape, placement, width, height);
  fillAndStrokePolygon(ctx, points, MOUNTAIN_COLOR, MOUNTAIN_OUTLINE, MOUNTAIN_LINE_WIDTH);
}

function drawDecoration(ctx, decoration, placement, width, height) {
  const pos = islandLocalToPixel([decoration.x, decoration.y], placement, width, height);
  const unit = getUnit(width, height);
  const size = unit * 0.012 * placement.scale;

  ctx.save();
  if (decoration.kind === "palm") {
    ctx.strokeStyle = PALM_TRUNK_COLOR;
    ctx.lineWidth = Math.max(1.5, size * 0.4);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y + size);
    ctx.lineTo(pos.x, pos.y - size * 0.3);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y - size * 0.6, size * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = PALM_CANOPY_COLOR;
    ctx.fill();
    ctx.lineWidth = Math.max(1, size * 0.2);
    ctx.strokeStyle = PALM_CANOPY_OUTLINE;
    ctx.stroke();
  } else {
    // Unknown decoration kind: fall back to a plain marker dot rather
    // than skipping it silently.
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, size * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = "#4d8a55";
    ctx.fill();
  }
  ctx.restore();
}

function fillPolygon(ctx, points, fillStyle) {
  if (points.length === 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function fillAndStrokePolygon(ctx, points, fillStyle, strokeStyle, lineWidth) {
  if (points.length === 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.stroke();
  ctx.restore();
}
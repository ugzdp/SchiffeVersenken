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
 * visited so far, capped at max length (see rules.js's tryExtendDragPath -
 * this just draws whatever points it's given), plus a translucent preview
 * of the ship that would spawn at the path's end. Drawn in the player's own
 * color while the path is a legal placement, red once any segment has
 * crossed land or the endpoint lands on another ship - see rules.js's
 * isValidShipPlacementPath, which input.js checks live while dragging. The
 * path is allowed to be dragged over an island (it turns red rather than
 * freezing at the coastline); releasing while red discards the whole
 * drag - see actions.js's placeShip(), which refuses to spawn a ship for an
 * invalid path - so the player has to redo the move from scratch.
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

/**
 * Normalize a landShape field (raw JSON, local 0-1 coords) into a list of
 * one or more polygon rings, so drawing code can treat a plain
 * single-landmass island and a multi-landmass one (e.g. an atoll) the
 * same way. Mirrors js/engine/rules.js's landShapeRings() - duplicated
 * here in full, rather than imported, so js/render/ stays fully
 * independent of js/engine/ per CLAUDE.md's engine/render separation.
 * @param {Array<[number,number]>|Array<Array<[number,number]>>} landShape
 * @returns {Array<Array<[number,number]>>}
 */
function landRings(landShape) {
  if (!landShape || landShape.length === 0) return [];
  const isMultiRing = Array.isArray(landShape[0][0]);
  return isMultiRing ? landShape : [landShape];
}

function drawShallowWater(ctx, landShape, placement, width, height) {
  for (const ring of landRings(landShape)) {
    const expanded = ring.map(([x, y]) => [
      0.5 + (x - 0.5) * SHALLOW_WATER_MARGIN,
      0.5 + (y - 0.5) * SHALLOW_WATER_MARGIN,
    ]);
    const points = islandPolygonToPixels(expanded, placement, width, height);
    fillPolygon(ctx, points, SHALLOW_WATER_COLOR);
  }
}

function drawBeach(ctx, landShape, placement, width, height) {
  for (const ring of landRings(landShape)) {
    const points = islandPolygonToPixels(ring, placement, width, height);
    fillAndStrokePolygon(ctx, points, BEACH_COLOR, BEACH_OUTLINE, BEACH_LINE_WIDTH);
  }
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

// How far into each edge a corner gets rounded, as a fraction of that
// edge's length (0 = sharp polygon, 0.5 = corner rounded all the way to
// the edge midpoints on both sides). Kept below 0.5 so long islands still
// read as their original silhouette instead of blurring into a blob.
const CORNER_ROUND_FACTOR = 0.28;

/**
 * Trace a closed polygon into ctx's current path with every corner
 * rounded, instead of the sharp vertices raw lineTo segments would give.
 * This is pure decoration: it only changes how the shape is *drawn*, the
 * actual landShape/mountainShapes polygons used for ship and shot
 * collision (js/engine/rules.js) are never touched, so gameplay stays
 * exactly as precise as before - only the coastline looks smoother.
 *
 * Technique: for each vertex, stop short of it by CORNER_ROUND_FACTOR of
 * the incoming edge, run a straight line along the untouched middle part
 * of each edge, then curve through the vertex with quadraticCurveTo to
 * the matching point on the outgoing edge. Small islands (few, close
 * vertices) round almost like a circle; larger ones keep straighter
 * stretches of coastline between gently rounded corners.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number}>} points
 */
function traceSmoothPolygon(ctx, points) {
  const n = points.length;
  if (n < 3) return; // not a real polygon - nothing sensible to trace

  const along = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  const lastToFirst = along(points[n - 1], points[0], 1 - CORNER_ROUND_FACTOR);
  ctx.moveTo(lastToFirst.x, lastToFirst.y);
  for (let i = 0; i < n; i++) {
    const current = points[i];
    const next = points[(i + 1) % n];
    const afterCorner = along(current, next, CORNER_ROUND_FACTOR);
    ctx.quadraticCurveTo(current.x, current.y, afterCorner.x, afterCorner.y);
    const beforeNextCorner = along(current, next, 1 - CORNER_ROUND_FACTOR);
    ctx.lineTo(beforeNextCorner.x, beforeNextCorner.y);
  }
  ctx.closePath();
}

function fillPolygon(ctx, points, fillStyle) {
  if (points.length === 0) return;
  ctx.save();
  ctx.beginPath();
  traceSmoothPolygon(ctx, points);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function fillAndStrokePolygon(ctx, points, fillStyle, strokeStyle, lineWidth) {
  if (points.length === 0) return;
  ctx.save();
  ctx.beginPath();
  traceSmoothPolygon(ctx, points);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.stroke();
  ctx.restore();
}
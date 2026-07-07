// input.js
//
// Pointer events for both player actions (CLAUDE.md "Turn structure"):
// Action A (place a new ship by dragging a freehand path from one of the
// current player's own ships, with a post-release revert window) in
// Phase.PLACING/Phase.CONFIRMING_PLACEMENT, and Action B (the blind shot)
// across Phase.AIMING_SHOT / BLIND_SHOT. Uses Pointer Events so touch
// (iPad/iPhone) and mouse (desktop) both work through the same code path,
// per CLAUDE.md's input requirements. Never touches the DOM beyond the
// canvas itself - UI state (black overlay, red border, warnings, the
// placement "undo" cross) is derived from state.phase/state.warning/
// state.pendingPlacement every frame by js/render/ui.js instead of being
// pushed from here, so this file stays a plain phase-routed event handler
// (plus the small timers a phase transition needs to schedule itself).

import { Phase, getShipsByOwner, setPhase } from "./engine/gameState.js";
import {
  beginPlacementConfirmation,
  commitPlacement,
  endTurn,
  fireShot,
  placeShip,
  revertPlacement,
} from "./engine/actions.js";
import {
  MAX_LINE_LENGTH,
  PLACEMENT_CONFIRM_WINDOW_MS,
  SWIPE_TIME_LIMIT_MS,
  TOUCH_CONFIRM_WINDOW_EXTRA_MS,
  getPlacedIslandWorldShapes,
  isValidShipPlacementPath,
  tryExtendDragPath,
} from "./engine/rules.js";
import { relToPixel, getUnit } from "./render/coords.js";

// Generous tap target in CSS pixels - bigger than the drawn ship hull so
// touch input on a small ship icon is forgiving.
const HIT_RADIUS_PX = 28;

// Minimum swipe distance (relative units) below which a release is treated
// as "no swipe happened" rather than a valid-but-slow shot, since a zero
// (or near-zero) displacement has no meaningful direction.
const MIN_SWIPE_DISTANCE = 0.01;

// Rolling window (ms) used to measure swipe speed. Shot distance is driven by
// the fastest burst of movement within this window anywhere during the blind
// swipe, not by the average over the whole touch-to-release gesture - a
// player who pauses on the ship before flicking should still get full
// distance for a fast flick, so the game reads as responsive to how fast the
// finger is actually moving right now, not diluted by how long they took to
// start moving.
const SWIPE_SPEED_WINDOW_MS = 80;

// How long the tracer/sinking animation is shown before the turn passes,
// matching effects.js's SHOT_LINE_DURATION_MS.
const SHOT_RESOLVE_DISPLAY_MS = 1400;

/**
 * Wire up canvas pointer events for ship placement and blind shots.
 * @param {HTMLCanvasElement} canvas
 * @param {import("./engine/gameState.js").GameState & {dragPath?: object|null, warning?: object|null, pendingPlacement?: object|null}} state
 * @param {() => void} [onTurnChanged] - called right after a ship placement
 *   is committed/reverted, or a shot fully resolves and the turn passes, so
 *   main.js can refresh UI that isn't redrawn every frame (e.g. the menu
 *   bar's active-player highlight).
 * @returns {{revertPendingPlacement: () => void, cancelPendingPlacementTimer: () => void}}
 *   `revertPendingPlacement` is wired up by main.js as the "undo" cross
 *   button's click handler (see js/render/ui.js initPlacementConfirmUI).
 *   `cancelPendingPlacementTimer` is used by main.js on restart, so a stale
 *   timer from the old match can't fire commitPlacement() on the new one.
 */
export function initInput(canvas, state, onTurnChanged) {
  let dragPath = null; // Array<{x,y}> relative coords while dragging (Action A), path[0] is the origin ship
  let dragPathLengthPx = 0; // running total length of dragPath, in pixels (see tryExtendDragPath)
  let blindShot = null; // {originShip, startX, startY, startTime} while aiming a blind shot (Action B)
  let confirmTimer = null; // setTimeout id for the pending-placement revert window

  canvas.addEventListener("pointerdown", (event) => {
    if (state.phase === Phase.CONFIRMING_PLACEMENT) {
      const rel = pixelToRel(canvas, event);
      const nextPlayer = state.currentPlayer === 1 ? 2 : 1;
      const opponentShip = findShipNear(state, nextPlayer, rel, canvas);
      if (!opponentShip) return; // only the opponent starting their own move forces an early commit - see the "undo" cross for the placing player's own option
      commitPendingPlacement();
      // Falls through below: state.phase is now Phase.PLACING and
      // state.currentPlayer is now `nextPlayer`, so this same touch starts
      // their turn immediately instead of being lost.
    }

    if (state.phase === Phase.PLACING) {
      const rel = pixelToRel(canvas, event);
      const touchedShip = findShipNear(state, state.currentPlayer, rel, canvas);
      if (!touchedShip) return;

      canvas.setPointerCapture(event.pointerId);
      dragPath = [{ x: touchedShip.x, y: touchedShip.y }];
      dragPathLengthPx = 0;
      state.dragPath = {
        points: [{ x: touchedShip.x, y: touchedShip.y }],
        owner: state.currentPlayer,
        valid: false, // a zero-length path always lands back on the origin ship
      };
      return;
    }

    if (state.phase === Phase.AIMING_SHOT) {
      const rel = pixelToRel(canvas, event);
      const touchedShip = findShipNear(state, state.currentPlayer, rel, canvas);
      if (!touchedShip) return;

      canvas.setPointerCapture(event.pointerId);
      // CLAUDE.md Action B step 2: touching a ship blacks out the screen -
      // js/render/ui.js reads Phase.BLIND_SHOT every frame to show it.
      setPhase(state, Phase.BLIND_SHOT);
      blindShot = {
        originShip: touchedShip,
        startX: rel.x,
        startY: rel.y,
        startTime: event.timeStamp,
        samples: [{ x: rel.x, y: rel.y, t: event.timeStamp }],
        peakSpeed: 0,
      };
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (dragPath) {
      const rel = pixelToRel(canvas, event);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const maxLengthPx = MAX_LINE_LENGTH * getUnit(width, height);
      const last = dragPath[dragPath.length - 1];
      const lastPx = relToPixel(last.x, last.y, width, height);
      const candidatePx = relToPixel(rel.x, rel.y, width, height);

      const result = tryExtendDragPath(dragPath, rel, lastPx, candidatePx, dragPathLengthPx, maxLengthPx);
      if (result.extended) {
        dragPath = result.path;
        dragPathLengthPx = result.lengthPx;
        state.dragPath.points = dragPath.map((point) => ({ x: point.x, y: point.y }));
        state.dragPath.valid = isPathValid(state, dragPath);
      }
    }
    // No visual feedback while aiming a blind shot - the screen is black -
    // but samples are still recorded to measure swipe speed for fireShot().
    if (blindShot) {
      trackSwipeSample(blindShot, pixelToRel(canvas, event), event.timeStamp);
    }
  });

  canvas.addEventListener("pointerup", (event) => {
    if (dragPath) {
      const owner = state.currentPlayer;
      const path = dragPath;

      dragPath = null;
      dragPathLengthPx = 0;
      state.dragPath = null;

      const ship = placeShip(state, owner, path);
      if (ship) {
        const isTouch = event.pointerType === "touch";
        beginPlacementConfirmation(state, ship, event.timeStamp, isTouch);
        const windowMs = PLACEMENT_CONFIRM_WINDOW_MS + (isTouch ? TOUCH_CONFIRM_WINDOW_EXTRA_MS : 0);
        confirmTimer = setTimeout(commitPendingPlacement, windowMs);
        if (onTurnChanged) onTurnChanged();
      }
      return;
    }

    if (blindShot) {
      resolveBlindShot(canvas, state, blindShot, event, onTurnChanged);
      blindShot = null;
    }
  });

  canvas.addEventListener("pointercancel", () => {
    dragPath = null;
    dragPathLengthPx = 0;
    state.dragPath = null;
    if (blindShot) {
      setPhase(state, Phase.AIMING_SHOT);
      blindShot = null;
    }
  });

  /**
   * Confirm the pending placement (CLAUDE.md Action A confirm/revert): the
   * revert window's timer ran out, or the opponent touched one of their own
   * ships to start their turn early - either way clear the timer (a no-op
   * if it already fired) and pass the turn.
   */
  function commitPendingPlacement() {
    if (confirmTimer !== null) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    if (state.phase !== Phase.CONFIRMING_PLACEMENT) return;
    commitPlacement(state);
    if (onTurnChanged) onTurnChanged();
  }

  /**
   * Undo the pending placement (CLAUDE.md Action A confirm/revert): wired
   * up by main.js as the "undo" cross button's click handler.
   */
  function revertPendingPlacement() {
    if (confirmTimer !== null) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    if (state.phase !== Phase.CONFIRMING_PLACEMENT) return;
    revertPlacement(state);
    if (onTurnChanged) onTurnChanged();
  }

  return {
    revertPendingPlacement,
    cancelPendingPlacementTimer: () => {
      if (confirmTimer !== null) {
        clearTimeout(confirmTimer);
        confirmTimer = null;
      }
    },
  };
}

/**
 * Finish a blind shot on release (CLAUDE.md Action B steps 3-7): if the
 * swipe took longer than SWIPE_TIME_LIMIT_MS (or barely moved), it's too
 * slow/not a swipe - show a warning and drop back to Phase.AIMING_SHOT so
 * the player retries by touching a ship again. Otherwise turn the swipe's
 * speed and direction into a shot via actions.js's fireShot(), then move to
 * Phase.SHOT_RESOLVE (or GAMEOVER) so the tracer is shown before the turn
 * passes. Sinking an enemy ship grants the same player another turn instead
 * of passing control - only a miss or friendly-fire sinking ends the turn.
 */
function resolveBlindShot(canvas, state, blindShot, event, onTurnChanged) {
  const rel = pixelToRel(canvas, event);
  const elapsedMs = event.timeStamp - blindShot.startTime;
  const dx = rel.x - blindShot.startX;
  const dy = rel.y - blindShot.startY;
  const dist = Math.hypot(dx, dy);

  if (elapsedMs > SWIPE_TIME_LIMIT_MS || dist < MIN_SWIPE_DISTANCE) {
    setPhase(state, Phase.AIMING_SHOT);
    state.warning = { text: "Too slow - try again!", until: event.timeStamp + 1500 };
    return;
  }

  trackSwipeSample(blindShot, rel, event.timeStamp);
  // Fall back to the whole-gesture average (old behaviour) in case pointermove
  // never fired between down and up, e.g. a very quick flick some browsers
  // report as a single move event - peakSpeed would otherwise stay 0.
  const avgSpeed = dist / (elapsedMs / 1000);
  const direction = [dx / dist, dy / dist];
  const speed = Math.max(blindShot.peakSpeed, avgSpeed);
  const isTouch = event.pointerType === "touch";

  const { sunkShip } = fireShot(state, blindShot.originShip, direction, speed, event.timeStamp, {
    isTouch,
    swipeDistance: dist,
  });
  // Refresh the menu bar's shot/hit counters right away, so they update as
  // soon as the tracer is shown rather than waiting for the turn to pass
  // (which doesn't happen at all on the shot that ends the match).
  if (onTurnChanged) onTurnChanged();

  // Sinking an enemy ship earns the shooter another turn - only clear the
  // phase back to PLACING without handing control to the other player. A
  // sunk ship of the shooter's own (friendly fire) still ends the turn as
  // normal, same as a miss.
  const sankEnemyShip = sunkShip && sunkShip.owner !== blindShot.originShip.owner;

  if (state.phase !== Phase.GAMEOVER) {
    setTimeout(() => {
      if (!sankEnemyShip) endTurn(state);
      else setPhase(state, Phase.PLACING);
      state.shotLine = null;
      if (onTurnChanged) onTurnChanged();
    }, SHOT_RESOLVE_DISPLAY_MS);
  }
}

/**
 * Record a swipe position sample on `blindShot` and update its `peakSpeed`
 * (relative units/sec) using a sliding window of SWIPE_SPEED_WINDOW_MS: the
 * speed is measured from the oldest sample still inside the window to the
 * new one, so a fast burst anywhere in the swipe - not just the overall
 * average - can set the peak.
 */
function trackSwipeSample(blindShot, rel, t) {
  blindShot.samples.push({ x: rel.x, y: rel.y, t });
  while (blindShot.samples.length > 1 && t - blindShot.samples[0].t > SWIPE_SPEED_WINDOW_MS) {
    blindShot.samples.shift();
  }

  const oldest = blindShot.samples[0];
  const windowMs = t - oldest.t;
  if (windowMs <= 0) return;

  const dist = Math.hypot(rel.x - oldest.x, rel.y - oldest.y);
  const speed = dist / (windowMs / 1000);
  if (speed > blindShot.peakSpeed) blindShot.peakSpeed = speed;
}

/** Convert a pointer event's client coords to relative 0-1 canvas coords. */
function pixelToRel(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

/**
 * Whether a drag path is currently a legal ship placement as a whole (see
 * rules.js's isValidShipPlacementPath) - false the instant any segment has
 * crossed land, not just when the current endpoint sits on one, since the
 * path is now allowed to be dragged over islands and just shown red.
 */
function isPathValid(state, path) {
  const islandWorldShapes = getPlacedIslandWorldShapes(state.islands, state.map);
  return isValidShipPlacementPath(path, islandWorldShapes, state.ships);
}

/** Find `owner`'s ship whose drawn position is within HIT_RADIUS_PX of `rel`. */
function findShipNear(state, owner, rel, canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const point = relToPixel(rel.x, rel.y, width, height);

  for (const ship of getShipsByOwner(state, owner)) {
    const shipPixel = relToPixel(ship.x, ship.y, width, height);
    if (Math.hypot(shipPixel.x - point.x, shipPixel.y - point.y) <= HIT_RADIUS_PX) {
      return ship;
    }
  }
  return undefined;
}
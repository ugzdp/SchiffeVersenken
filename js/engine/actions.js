// actions.js
//
// Player actions that take state + input and mutate state, never draw (see
// CLAUDE.md architecture).

import {
  addShip,
  isGameOver,
  nextTurn,
  Phase,
  recordHit,
  recordShot,
  removeShip,
  resetMatch,
  setMap,
  setPhase,
} from "./gameState.js";
import { generateMap } from "./mapGenerator.js";
import {
  BASE_SHIP_START,
  getPlacedIslandWorldShapes,
  isValidShipPlacementPath,
  resolveShot,
  swipeSpeedToDistance,
} from "./rules.js";

let nextShipId = 1;

/**
 * Place a new ship for `owner` at the end of a freehand drag path, provided
 * the path is legal (CLAUDE.md "Turn structure", Action A): no segment may
 * cross any island, and the final point must not land on another ship. Does
 * NOT end the turn - unlike the old straight-line version, a placement now
 * opens a revert window instead (see beginPlacementConfirmation() below);
 * the caller (input.js) is responsible for calling that next on success.
 * @param {import("./gameState.js").GameState} state
 * @param {1|2} owner
 * @param {Array<{x:number,y:number}>} path - relative 0-1 points, path[0] is the touched ship's position
 * @returns {import("./gameState.js").Ship|null} the newly placed ship, or
 *   null if the path was illegal (no ship placed, turn does not end)
 */
export function placeShip(state, owner, path) {
  const islandWorldShapes = getPlacedIslandWorldShapes(state.islands, state.map);

  const legal = isValidShipPlacementPath(path, islandWorldShapes, state.ships);
  if (!legal) return null;

  const endpoint = path[path.length - 1];
  const ship = { id: `ship-${nextShipId++}`, owner, x: endpoint.x, y: endpoint.y, isBase: false };
  addShip(state, ship);
  return ship;
}

/**
 * Open the post-placement revert window (CLAUDE.md Action A confirm/revert):
 * moves to Phase.CONFIRMING_PLACEMENT and records which ship could still be
 * undone. The turn does NOT pass yet - js/render/ui.js shows the "undo"
 * cross for this ship, and js/input.js owns the timer that eventually calls
 * commitPlacement() (or, if the placing player taps the cross first,
 * revertPlacement()).
 * @param {import("./gameState.js").GameState} state
 * @param {import("./gameState.js").Ship} ship - the ship placeShip() just added
 * @param {number} time - ms timestamp (e.g. event.timeStamp), stamped for reference/debugging
 * @returns {void}
 */
export function beginPlacementConfirmation(state, ship, time) {
  state.pendingPlacement = { shipId: ship.id, owner: ship.owner, startTime: time };
  setPhase(state, Phase.CONFIRMING_PLACEMENT);
}

/**
 * Confirm the pending placement and pass the turn (CLAUDE.md Action A
 * confirm/revert): called once the revert window's timer runs out, or the
 * instant the opponent touches one of their own ships to start their turn
 * early. The ship placed during Phase.CONFIRMING_PLACEMENT stays in play.
 * @param {import("./gameState.js").GameState} state
 * @returns {void}
 */
export function commitPlacement(state) {
  state.pendingPlacement = null;
  nextTurn(state); // also resets phase to Phase.PLACING
}

/**
 * Undo the pending placement (CLAUDE.md Action A confirm/revert): called
 * when the placing player taps the "undo" cross before the window closes.
 * Removes the ship that was just placed and returns to Phase.PLACING for
 * the SAME player - the turn does not pass - so they can redraw the path or
 * switch to Action B (Shoot) instead.
 * @param {import("./gameState.js").GameState} state
 * @returns {void}
 */
export function revertPlacement(state) {
  if (state.pendingPlacement) removeShip(state, state.pendingPlacement.shipId);
  state.pendingPlacement = null;
  setPhase(state, Phase.PLACING);
}

/**
 * Resolve a blind shot (CLAUDE.md "Action B - Shoot" steps 4-7): map the
 * swipe's speed to a travel distance, cast the shot from `originShip` in
 * `direction`, and stop it at the nearest mountain edge or ship hitbox it
 * reaches (whichever is closer - a hit ship stops the shot just like a
 * mountain would, so a single shot sinks at most one ship). Friendly fire
 * is allowed: every other ship in play, regardless of owner, is a valid
 * target. Sets state.shotLine so the tracer can be drawn, removes the sunk
 * ship (if any) from play, and moves the phase to GAMEOVER (sunk ship was a
 * base) or SHOT_RESOLVE. Does not end the turn - the caller (input.js) does
 * that once the tracer has been shown for a bit, via endTurn().
 * @param {import("./gameState.js").GameState} state
 * @param {import("./gameState.js").Ship} originShip - the ship the player
 *   touched to fire, excluded from possible targets
 * @param {[number,number]} direction - unit vector, the swipe's direction
 * @param {number} speed - the swipe's speed (relative units per second)
 * @param {number} time - ms timestamp (e.g. event.timeStamp), stamped onto
 *   state.shotLine / the sunk ship's sinking-animation entry so effects.js
 *   can time their fade-out/animation from the same clock as the render loop
 * @returns {{sunkShip: import("./gameState.js").Ship|null}}
 */
export function fireShot(state, originShip, direction, speed, time) {
  const maxDistance = swipeSpeedToDistance(speed);
  const mountainWorldShapes = getPlacedIslandWorldShapes(state.islands, state.map).flatMap(
    (island) => island.mountainShapes
  );
  const targets = state.ships.filter((ship) => ship.id !== originShip.id);

  const { endpoint, hitShip } = resolveShot(
    [originShip.x, originShip.y],
    direction,
    maxDistance,
    mountainWorldShapes,
    targets
  );

  state.shotLine = {
    fromX: originShip.x,
    fromY: originShip.y,
    toX: endpoint[0],
    toY: endpoint[1],
    owner: originShip.owner,
    startTime: time,
  };

  recordShot(state, originShip.owner);

  if (hitShip) {
    removeShip(state, hitShip.id);
    state.sinkingShips = [...(state.sinkingShips || []), { ...hitShip, startTime: time }];
    recordHit(state, originShip.owner);
  }

  setPhase(state, isGameOver(state) ? Phase.GAMEOVER : Phase.SHOT_RESOLVE);

  return { sunkShip: hitShip || null };
}

/**
 * End the current player's turn and switch control to the other player.
 * @param {import("./gameState.js").GameState} state
 * @returns {void}
 */
export function endTurn(state) {
  nextTurn(state);
}

/**
 * Start a fresh match: generate a brand new random map from the loaded
 * island library, clear every ship in play, and spawn each player's base
 * ship at its fixed start position (BASE_SHIP_START in rules.js) - the
 * same spot every match, independent of the random map. Used both for the
 * very first map of a session and for the settings menu's "Restart game"
 * item.
 * @param {import("./gameState.js").GameState} state
 * @param {number} [seed] - defaults to a random seed, so each restart gets a new layout
 * @returns {void}
 */
export function restartGame(state, seed = Date.now()) {
  const map = generateMap(state.islands, seed);
  setMap(state, map);
  resetMatch(state);

  for (const owner of [1, 2]) {
    const { x, y } = BASE_SHIP_START[owner];
    addShip(state, { id: `ship-${nextShipId++}`, owner, x, y, isBase: true });
  }
}
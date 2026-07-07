// gameState.js
//
// The single source of truth for the whole match: the generated map, the
// static island shape library it was built from, every ship in play, whose
// turn it is, and which phase of a turn we're in.
//
// This module is the SHARED CONTRACT for the rest of the codebase:
//   - js/data/islandLoader.js  calls setIslandLibrary() after loading JSON
//   - js/engine/mapGenerator.js calls setMap() after generating a map
//   - js/engine/actions.js     calls addShip(), removeShip(), setPhase(),
//                               nextTurn() while resolving player actions
//   - js/engine/rules.js       calls getShipsByOwner(), getBaseShip(),
//                               isGameOver() to check collisions and win state
//   - js/render/renderer.js    reads state.map, state.islands, state.ships
//                               to draw the current frame (never mutates it)
//
// Per CLAUDE.md: this file holds PURE game logic only — no rendering, no
// DOM access, no Canvas access. It does not implement any rules yet; the
// functions below are stubs that define the shape of the contract so other
// modules can be built against them. Actual behavior is filled in later,
// one feature at a time.

/**
 * @typedef {Object} IslandLibraryEntry
 * A single static island shape, as loaded from data/islands/*.json.
 * See data/schema.md for the full field-by-field format.
 * @property {string} id
 * @property {"normal"|"base"} type
 * @property {Array<[number, number]>} landShape - polygon, local 0-1 coords
 * @property {Array<Array<[number, number]>>} mountainShapes - polygons, local 0-1 coords
 * @property {Array<{kind: string, x: number, y: number}>} decorations
 * @property {{x: number, y: number}} [baseAnchor] - only present when type is "base"
 */

/**
 * @typedef {Object} PlacedIsland
 * One island instance placed on the generated map, referencing a shape
 * from the island library by id. See data/schema.md.
 * @property {string} islandId - references an IslandLibraryEntry.id
 * @property {number} x - relative 0-1 position on the map
 * @property {number} y - relative 0-1 position on the map
 * @property {number} scale
 * @property {number} rotation - radians
 */

/**
 * @typedef {Object} GeneratedMap
 * The current match's map, built by mapGenerator.js. See data/schema.md.
 * @property {number} seed - random seed used to (re)generate this map
 * @property {PlacedIsland[]} islands
 */

/**
 * @typedef {Object} Ship
 * A single ship belonging to one player. Ships never move once placed.
 * Coordinates are relative 0-1 on the play field, matching the map's
 * coordinate space (converted to pixels only in the renderer).
 * @property {string} id - unique id of this ship
 * @property {1|2} owner - which player this ship belongs to
 * @property {number} x - relative 0-1 position
 * @property {number} y - relative 0-1 position
 * @property {boolean} isBase - true for each player's single base ship
 */

/**
 * @typedef {Object} GameState
 * @property {GeneratedMap|null} map - this match's generated map, or null before generation
 * @property {IslandLibraryEntry[]} islands - the static island shape library (loaded once, shared by all matches)
 * @property {Ship[]} ships - every ship currently in play, both players combined
 * @property {1|2} currentPlayer - whose turn it is
 * @property {string} phase - one of the Phase constants below
 * @property {{1: {shots: number, hits: number}, 2: {shots: number, hits: number}}} stats -
 *   per-player shot/hit counters shown in the menu bar and victory modal
 */

/** Turn/phase state machine values (see CLAUDE.md "Game phases"). */
export const Phase = {
  PLACING: "placing", // waiting for the current player to place a ship (drag path) or press Shoot
  CONFIRMING_PLACEMENT: "confirmingPlacement", // ship just placed; the "undo" cross is up (see actions.js beginPlacementConfirmation)
  AIMING_SHOT: "aimingShot", // Shoot button pressed, waiting for the player to touch one of their ships
  BLIND_SHOT: "blindShot", // screen is blacked out, waiting for the swipe that determines the shot
  SHOT_RESOLVE: "shotResolve", // shot line is being shown to both players before the turn ends
  GAMEOVER: "gameover", // one base ship has sunk, match is over
};

/**
 * Create a fresh game state object with no map, no islands loaded yet,
 * no ships, player 1 starting, and the initial "placing" phase.
 * @returns {GameState}
 */
export function createGameState() {
  return {
    map: null,
    islands: [],
    ships: [],
    currentPlayer: 1,
    phase: Phase.PLACING,
    stats: { 1: { shots: 0, hits: 0 }, 2: { shots: 0, hits: 0 } },
  };
}

/**
 * Store the loaded island shape library on the state.
 * Called by js/data/islandLoader.js once data/islands/*.json has been
 * fetched and validated.
 * @param {GameState} state
 * @param {IslandLibraryEntry[]} islandLibrary
 * @returns {void}
 */
export function setIslandLibrary(state, islandLibrary) {
  state.islands = islandLibrary;
}

/**
 * Store a newly generated map on the state.
 * Called by js/engine/mapGenerator.js after assembling a map from the
 * island library (see CLAUDE.md "Map generation").
 * @param {GameState} state
 * @param {GeneratedMap} map
 * @returns {void}
 */
export function setMap(state, map) {
  state.map = map;
}

/**
 * Add a new ship to play.
 * Called by js/engine/actions.js when placeShip() succeeds (drag-line
 * placement), and once per player at match start for base ships.
 * @param {GameState} state
 * @param {Ship} ship
 * @returns {void}
 */
export function addShip(state, ship) {
  state.ships.push(ship);
}

/**
 * Remove a ship from play (it has sunk).
 * Called by js/engine/actions.js when fireShot() resolves a hit.
 * @param {GameState} state
 * @param {string} shipId
 * @returns {void}
 */
export function removeShip(state, shipId) {
  state.ships = state.ships.filter((ship) => ship.id !== shipId);
}

/**
 * Get all ships belonging to one player.
 * Called by js/engine/rules.js (collision checks) and js/render/renderer.js
 * (drawing each player's fleet).
 * @param {GameState} state
 * @param {1|2} owner
 * @returns {Ship[]}
 */
export function getShipsByOwner(state, owner) {
  return state.ships.filter((ship) => ship.owner === owner);
}

/**
 * Get a player's base ship, if it is still afloat.
 * Called by js/engine/rules.js to check the win condition.
 * @param {GameState} state
 * @param {1|2} owner
 * @returns {Ship|undefined}
 */
export function getBaseShip(state, owner) {
  return state.ships.find((ship) => ship.owner === owner && ship.isBase);
}

/**
 * Change the current turn phase.
 * Called by js/engine/actions.js while stepping through the turn state
 * machine (see CLAUDE.md "Game phases").
 * @param {GameState} state
 * @param {string} phase - one of the Phase constants
 * @returns {void}
 */
export function setPhase(state, phase) {
  state.phase = phase;
}

/**
 * Switch control to the other player and reset the phase to PLACING.
 * Called by js/engine/actions.js at the end of endTurn().
 * @param {GameState} state
 * @returns {void}
 */
export function nextTurn(state) {
  state.currentPlayer = state.currentPlayer === 1 ? 2 : 1;
  state.phase = Phase.PLACING;
}

/**
 * Wipe every ship and hand control back to player 1 in the PLACING phase.
 * Called by js/engine/actions.js's restartGame() after generating a fresh
 * map, right before the two base ships are re-added.
 * @param {GameState} state
 * @returns {void}
 */
export function resetMatch(state) {
  state.ships = [];
  state.currentPlayer = 1;
  state.phase = Phase.PLACING;
  state.stats = { 1: { shots: 0, hits: 0 }, 2: { shots: 0, hits: 0 } };
}

/**
 * Increment a player's shot counter, shown in the menu bar and victory
 * modal (bullet icon). Called by js/engine/actions.js's fireShot() once per
 * blind shot fired, whether or not it hits.
 * @param {GameState} state
 * @param {1|2} owner
 * @returns {void}
 */
export function recordShot(state, owner) {
  state.stats[owner].shots += 1;
}

/**
 * Increment a player's hit counter, shown in the menu bar and victory modal
 * (target icon). Called by js/engine/actions.js's fireShot() when a shot
 * sinks a ship.
 * @param {GameState} state
 * @param {1|2} owner
 * @returns {void}
 */
export function recordHit(state, owner) {
  state.stats[owner].hits += 1;
}

/**
 * Check whether the match is over (a base ship has sunk).
 * Called by js/engine/actions.js after fireShot() resolves, and by
 * js/render/ui.js to decide whether to show the victory screen.
 * @param {GameState} state
 * @returns {boolean}
 */
export function isGameOver(state) {
  return !getBaseShip(state, 1) || !getBaseShip(state, 2);
}

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
 * @property {Array<[number, number]>|Array<Array<[number, number]>>} landShape - polygon, local 0-1 coords; a list of polygons instead of one for a multi-landmass island (e.g. an atoll) - see js/engine/rules.js's landShapeRings()
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
 * @typedef {Object} StatCounters
 * @property {number} shots - blind shots fired
 * @property {number} hits - shots that sank a ship, own or enemy (CLAUDE.md friendly fire)
 * @property {number} ownGoals - of `hits`, how many sank one of the shooter's own ships
 * @property {number} shipsLost - this player's own ships sunk, by either player
 */

/**
 * @typedef {Object} GameState
 * @property {GeneratedMap|null} map - this match's generated map, or null before generation
 * @property {IslandLibraryEntry[]} islands - the static island shape library (loaded once, shared by all matches)
 * @property {Ship[]} ships - every ship currently in play, both players combined
 * @property {1|2} currentPlayer - whose turn it is
 * @property {string} phase - one of the Phase constants below
 * @property {{1: StatCounters, 2: StatCounters}} stats -
 *   per-player counters shown in the menu bar and victory modal (shot/hit
 *   icons, plus ownGoals/shipsLost, which never render directly but feed
 *   js/engine/scoring.js's computeScore())
 * @property {number|null} matchStartTime - timestamp (same clock as
 *   requestAnimationFrame/event.timeStamp) when the current match's clock
 *   started counting up, or null before a match has begun
 * @property {number|null} matchEndTime - timestamp when the match was won
 *   (base ship sunk), freezing the match clock; null while still playing
 * @property {"pvp"|"pvb"} mode - "pvp" (two humans, hot-seat) or "pvb" (one
 *   human, player 1, against the bot, always player 2 - see js/botController.js).
 *   Chosen once on the start modal (js/render/ui.js initStartModal) and left
 *   untouched by resetMatch(), so it survives "Generate new map".
 * @property {"easy"|"medium"|"hard"|"trained"|null} botDifficulty - only
 *   meaningful when mode is "pvb" (see js/engine/bot.js's BOT_DIFFICULTY;
 *   "trained" instead routes to js/engine/trainedBot.js)
 * @property {boolean} paused - true while the match is paused (Settings >
 *   Pause game - see js/render/ui.js). js/input.js blocks canvas pointer
 *   input while this is true, and main.js skips the bot controller's
 *   per-frame update() - see pauseMatch()/resumeMatch() below.
 * @property {number|null} pausedAt - timestamp (same clock as
 *   requestAnimationFrame/event.timeStamp) the current pause began, or null
 *   while not paused
 * @property {number} pausedDurationMs - total time spent paused so far this
 *   match, folded in by resumeMatch() each time a pause ends - see
 *   pauseAdjustedTime() below, which uses this to keep the match clock and
 *   score pace bonus blind to any time spent paused
 * @property {Object<string, number>} botShotMemory - the single-player bot's
 *   own memory of shots that missed their intended target, keyed by
 *   "<originShipId>:<targetShipId>" -> miss count. Ships never move once
 *   placed (see the Ship typedef above), so an (origin, target) pair is a
 *   stable "position" the bot can learn to stop wasting shots from - see
 *   getBotShotMissCount()/recordBotShotOutcome() below and js/engine/bot.js's
 *   MAX_MISSES_BEFORE_AVOIDING_ORIGIN.
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
    stats: { 1: createStatCounters(), 2: createStatCounters() },
    matchStartTime: null,
    matchEndTime: null,
    mode: "pvp",
    botDifficulty: null,
    paused: false,
    pausedAt: null,
    pausedDurationMs: 0,
    botShotMemory: {},
  };
}

/**
 * How many times the single-player bot has fired at `targetId` from
 * `originId` and missed it (hit nothing, or hit some other ship instead) -
 * see js/engine/bot.js's gatherOwnShotCandidates(), which stops proposing a
 * pairing once this reaches MAX_MISSES_BEFORE_AVOIDING_ORIGIN. Safe to call
 * on a state that never went through createGameState() (e.g. a hand-built
 * test fixture) - missing botShotMemory just reads as "never tried yet".
 * @param {GameState} state
 * @param {string} originId
 * @param {string} targetId
 * @returns {number}
 */
export function getBotShotMissCount(state, originId, targetId) {
  return (state.botShotMemory && state.botShotMemory[`${originId}:${targetId}`]) || 0;
}

/**
 * Record the outcome of one of the bot's own aimed shots, for
 * getBotShotMissCount() above. Called by js/botController.js right after
 * js/engine/actions.js's fireShot() resolves. A hit on the intended target
 * clears its memory entry (the ship's gone, so it no longer matters); any
 * other outcome (a miss, or hitting some other ship) counts as one more miss
 * against that exact origin/target pairing.
 * @param {GameState} state
 * @param {string} originId
 * @param {string} targetId
 * @param {string|null} hitShipId - the id of whatever the shot actually sank, or null on a clean miss
 * @returns {void}
 */
export function recordBotShotOutcome(state, originId, targetId, hitShipId) {
  if (!state.botShotMemory) state.botShotMemory = {};
  const key = `${originId}:${targetId}`;
  if (hitShipId === targetId) delete state.botShotMemory[key];
  else state.botShotMemory[key] = (state.botShotMemory[key] || 0) + 1;
}

/**
 * Record the start modal's mode/difficulty choice (js/render/ui.js
 * initStartModal). Called by main.js's startMatch(), before the first map is
 * generated, and again by goHome() whenever the player picks a mode from
 * the Home menu - not reset by resetMatch(), so it otherwise stays in effect
 * across "Generate new map" for the rest of the browser session.
 * @param {GameState} state
 * @param {"pvp"|"pvb"} mode
 * @param {"easy"|"medium"|"hard"|"trained"|null} [botDifficulty] - required when mode is "pvb"
 * @returns {void}
 */
export function setMatchMode(state, mode, botDifficulty = null) {
  state.mode = mode;
  state.botDifficulty = mode === "pvb" ? botDifficulty : null;
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
  state.stats = { 1: createStatCounters(), 2: createStatCounters() };
  state.matchStartTime = null;
  state.matchEndTime = null;
  state.paused = false;
  state.pausedAt = null;
  state.pausedDurationMs = 0;
  state.botShotMemory = {}; // a new match means new ship ids - stale entries can't match anything, but clear them anyway
}

/** @returns {StatCounters} a fresh, all-zero counter block for one player. */
function createStatCounters() {
  return { shots: 0, hits: 0, ownGoals: 0, shipsLost: 0 };
}

/**
 * Start (or restart) the match clock shown as a counting-up timer in the
 * menu bar. Called once a fresh match's base ships are in play - both at
 * the very first match of a session and after "Generate new map".
 * @param {GameState} state
 * @param {number} time - timestamp (same clock as requestAnimationFrame/
 *   event.timeStamp) marking 00:00 for this match
 * @returns {void}
 */
export function startMatchClock(state, time) {
  state.matchStartTime = time;
  state.matchEndTime = null;
}

/**
 * Freeze the match clock at the moment the match is won. Idempotent - only
 * the first call after a fresh startMatchClock() takes effect - so the
 * victory screen always shows the time it actually took to win.
 * @param {GameState} state
 * @param {number} time - timestamp (same clock as startMatchClock) when the
 *   winning shot resolved
 * @returns {void}
 */
export function endMatchClock(state, time) {
  if (state.matchEndTime === null) state.matchEndTime = time;
}

/**
 * Pause the match (Settings > Pause game - see js/render/ui.js). Only
 * freezes the bits of state this module owns (the paused flag/timestamp);
 * js/input.js is responsible for actually blocking canvas pointer input,
 * and main.js for skipping the bot controller's per-frame update(), both by
 * checking state.paused themselves. Idempotent - pausing an already-paused
 * match does nothing.
 * @param {GameState} state
 * @param {number} time - timestamp (same clock as requestAnimationFrame/
 *   event.timeStamp) marking the moment the pause began
 * @returns {void}
 */
export function pauseMatch(state, time) {
  if (state.paused) return;
  state.paused = true;
  state.pausedAt = time;
}

/**
 * Resume a paused match (see pauseMatch): folds the just-finished pause into
 * state.pausedDurationMs, so pauseAdjustedTime() below can keep treating any
 * time spent paused as if it never happened. Idempotent.
 * @param {GameState} state
 * @param {number} time - timestamp marking the moment the match resumed
 * @returns {void}
 */
export function resumeMatch(state, time) {
  if (!state.paused) return;
  state.pausedDurationMs += time - state.pausedAt;
  state.paused = false;
  state.pausedAt = null;
}

/**
 * Adjust a raw timestamp for any calculation anchored on state.matchStartTime
 * (the match clock in js/render/ui.js's updateTimer, and the live score pace
 * bonus in js/engine/scoring.js's computeScore) so a pause is invisible to
 * it: frozen at the instant the pause began while still paused, otherwise
 * live time with every past pause's duration subtracted out.
 *
 * NOT valid for anything else - state.shotLine/sinkingShips timestamps, the
 * bot controller, and state.warning are all stamped with (and compared
 * against) raw, unadjusted time throughout the match rather than anchored to
 * a single fixed point like matchStartTime, so mixing this in would corrupt
 * them instead of fixing them.
 * @param {GameState} state
 * @param {number} time - the real timestamp for the current frame
 * @returns {number}
 */
export function pauseAdjustedTime(state, time) {
  return (state.paused ? state.pausedAt : time) - state.pausedDurationMs;
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
 * Mark one of a player's `hits` as friendly fire (their shot sank one of
 * their own ships rather than an enemy's). Never shown directly - it lets
 * js/engine/scoring.js's computeScore() tell "enemy ships sunk" apart from
 * `hits`, which counts both. Called by js/engine/actions.js's fireShot()
 * alongside recordHit() whenever the sunk ship's owner is the shooter.
 * @param {GameState} state
 * @param {1|2} owner
 * @returns {void}
 */
export function recordOwnGoal(state, owner) {
  state.stats[owner].ownGoals += 1;
}

/**
 * Increment a player's own-ships-lost counter (feeds computeScore() - see
 * js/engine/scoring.js). Called by js/engine/actions.js's fireShot() for the
 * sunk ship's owner whenever any ship (their own or an enemy's) sinks it -
 * friendly fire counts against the ship's owner here, same as it would in
 * real life.
 * @param {GameState} state
 * @param {1|2} owner - the sunk ship's owner, not necessarily the shooter
 * @returns {void}
 */
export function recordShipLost(state, owner) {
  state.stats[owner].shipsLost += 1;
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

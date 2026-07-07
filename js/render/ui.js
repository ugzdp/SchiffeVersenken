// ui.js
//
// Builds DOM-based UI elements inside the #ui-overlay div (see index.html).
// This is separate from renderer.js/effects.js, which draw onto the Canvas.
// Per CLAUDE.md, this module owns the turn indicator, buttons, red border,
// black overlay, warnings and victory screen. For now it only builds the
// top menu bar and the Shoot button.

import { Phase, getBaseShip, isGameOver, setPhase } from "../engine/gameState.js";
import { relToPixel } from "./coords.js";

// Bullet icon (shots fired) - reused at a smaller size from the Shoot
// button's own icon. fill="currentColor" lets CSS pick the color per size.
const BULLET_ICON_SVG =
  '<svg class="stat-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2c-2.2 0-3.5 2.1-3.5 4.5V19a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V6.5C15.5 4.1 14.2 2 12 2z"/>' +
  "</svg>";

// Target icon (shots hit): two concentric circles plus a cross of tick
// marks, i.e. a crosshair reticle.
const TARGET_ICON_SVG =
  '<svg class="stat-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="12" y1="1" x2="12" y2="6" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="12" y1="18" x2="12" y2="23" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="1" y1="12" x2="6" y2="12" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="18" y1="12" x2="23" y2="12" stroke="currentColor" stroke-width="2"/>' +
  "</svg>";

/**
 * Create the top menu bar (Settings dropdown on the left, player labels
 * centered, each flanked by its shot/hit counters) and append it to the UI
 * overlay. The label of `state.currentPlayer` gets a green outline to show
 * whose turn it is.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState} state
 * @param {{onRestart?: () => void}} [callbacks] - handlers for settings menu items
 * @returns {void}
 */
export function initMenuBar(overlayEl, state, callbacks = {}) {
  const bar = document.createElement("div");
  bar.className = "menu-bar";

  bar.appendChild(createSettingsMenu(callbacks, overlayEl));

  const players = document.createElement("div");
  players.className = "players";

  // Player 1's counters sit to the left of their label, player 2's to the
  // right of theirs, so each player's stats stay next to their own name.
  players.appendChild(createStatCounters(1, "bar"));

  const player1 = document.createElement("span");
  player1.className = "player-label";
  player1.dataset.player = "1";
  player1.textContent = "Player 1";
  players.appendChild(player1);

  const player2 = document.createElement("span");
  player2.className = "player-label";
  player2.dataset.player = "2";
  player2.textContent = "Player 2";
  players.appendChild(player2);

  players.appendChild(createStatCounters(2, "bar"));

  bar.appendChild(players);
  overlayEl.appendChild(bar);

  updateMenuBar(overlayEl, state);
}

/**
 * Move the active-player highlight to whichever player label matches
 * `state.currentPlayer`, and refresh the shot/hit counter numbers from
 * `state.stats`. Call this after every turn change and after every shot
 * instead of rebuilding the whole menu bar.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState} state
 * @returns {void}
 */
export function updateMenuBar(overlayEl, state) {
  const labels = overlayEl.querySelectorAll(".player-label");
  labels.forEach((label) => {
    label.classList.toggle("player-label--active", Number(label.dataset.player) === state.currentPlayer);
  });
  updateStatCounters(overlayEl.querySelectorAll(".stat-counters"), state.stats);
}

/**
 * Build one player's shot/hit counter pair (bullet icon + number, target
 * icon + number). Shared between the live menu bar and the victory modal's
 * snapshot copy - `size` ("bar" | "modal") picks the CSS variant.
 * @param {1|2} owner
 * @param {"bar"|"modal"} size
 * @returns {HTMLElement}
 */
function createStatCounters(owner, size) {
  const wrap = document.createElement("div");
  wrap.className = `stat-counters stat-counters--${size}`;
  wrap.dataset.player = String(owner);

  if (size === "modal") {
    const label = document.createElement("span");
    label.className = "stat-counters-label";
    label.textContent = `Player ${owner}`;
    wrap.appendChild(label);
  }

  wrap.appendChild(createStatCounter("shots", BULLET_ICON_SVG));
  wrap.appendChild(createStatCounter("hits", TARGET_ICON_SVG));

  return wrap;
}

/** Build one icon+number counter (e.g. shots or hits) for createStatCounters(). */
function createStatCounter(kind, iconSvg) {
  const el = document.createElement("span");
  el.className = `stat-counter stat-counter--${kind}`;
  el.innerHTML = iconSvg;

  const value = document.createElement("span");
  value.className = "stat-counter-value";
  value.textContent = "0";
  el.appendChild(value);

  return el;
}

/**
 * Sync every stat-counters block's shot/hit numbers with `stats`. Reused for
 * both the live menu bar and the victory modal's one-time snapshot.
 * @param {NodeListOf<HTMLElement>} counterBlocks - elements with class "stat-counters"
 * @param {{1: {shots:number,hits:number}, 2: {shots:number,hits:number}}} stats
 * @returns {void}
 */
function updateStatCounters(counterBlocks, stats) {
  counterBlocks.forEach((block) => {
    const playerStats = stats[Number(block.dataset.player)];
    block.querySelector(".stat-counter--shots .stat-counter-value").textContent = playerStats.shots;
    block.querySelector(".stat-counter--hits .stat-counter-value").textContent = playerStats.hits;
  });
}

/**
 * Build the Settings button and its dropdown menu. The dropdown starts
 * closed, opens on clicking the button, and closes again on picking an
 * item or clicking anywhere else on the page.
 * @param {{onRestart?: () => void}} callbacks
e * @param {HTMLElement} overlayEl - the #ui-overlay element, needed to show the rules modal
 * @returns {HTMLElement} wrapper element containing both the button and its dropdown
 */
function createSettingsMenu(callbacks, overlayEl) {
  const wrap = document.createElement("div");
  wrap.className = "settings-wrap";

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "btn settings-btn";
  settingsBtn.textContent = "Settings";
  wrap.appendChild(settingsBtn);

  const dropdown = document.createElement("div");
  dropdown.className = "settings-dropdown";

  const restartBtn = document.createElement("button");
  restartBtn.type = "button";
  restartBtn.className = "settings-menu-item";
  restartBtn.textContent = "Restart game";
  restartBtn.addEventListener("click", () => {
    dropdown.classList.remove("settings-dropdown--open");
    if (callbacks.onRestart) callbacks.onRestart();
  });
  dropdown.appendChild(restartBtn);

  const rulesBtn = document.createElement("button");
  rulesBtn.type = "button";
  rulesBtn.className = "settings-menu-item";
  rulesBtn.textContent = "Rules";
  rulesBtn.addEventListener("click", () => {
    dropdown.classList.remove("settings-dropdown--open");
    showRulesModal(overlayEl);
  });
  dropdown.appendChild(rulesBtn);

  wrap.appendChild(dropdown);

  settingsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    dropdown.classList.toggle("settings-dropdown--open");
  });
  // Closing on any other click (including on the canvas, which sits outside
  // this overlay) needs a document-level listener rather than one on wrap.
  document.addEventListener("click", () => {
    dropdown.classList.remove("settings-dropdown--open");
  });
  dropdown.addEventListener("click", (event) => event.stopPropagation());

  return wrap;
}

/**
 * Show the start-game modal ("Schiffe Versenken" title, "Spiel starten"
 * button). Blocks interaction with the rest of the UI behind it until
 * the button is pressed, then removes itself and calls `onStart`.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {() => void} onStart - called once the player presses "Spiel starten"
 * @returns {void}
 */
export function initStartModal(overlayEl, onStart) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";

  const title = document.createElement("h1");
  title.className = "modal-title";
  title.textContent = "Schiffe Versenken";
  modal.appendChild(title);

  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "btn modal-start-btn";
  startBtn.textContent = "Spiel starten";
  modal.appendChild(startBtn);

  backdrop.appendChild(modal);
  overlayEl.appendChild(backdrop);

  startBtn.addEventListener("click", () => {
    backdrop.remove();
    onStart();
  });
}

/**
 * Show the "Rules" modal (Settings > Rules): a short, at-a-glance summary
 * of how a turn works and how to win, laid out so both columns fit on
 * screen without scrolling. Closes on the close button or a click outside
 * the modal card. Does nothing if the modal is already open.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @returns {void}
 */
function showRulesModal(overlayEl) {
  if (overlayEl.querySelector(".rules-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop rules-backdrop";
  backdrop.addEventListener("click", () => backdrop.remove());

  const modal = document.createElement("div");
  modal.className = "modal rules-modal";
  modal.addEventListener("click", (event) => event.stopPropagation());

  const header = document.createElement("div");
  header.className = "rules-header";

  const title = document.createElement("h1");
  title.className = "modal-title";
  title.textContent = "Rules";
  header.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn rules-close-btn";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => backdrop.remove());
  header.appendChild(closeBtn);

  modal.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "rules-grid";
  grid.appendChild(
    createRulesColumn("Place a ship", [
      "Drag a line out from one of your ships.",
      "The line stops at max length - keep moving your finger to rotate it.",
      "Release over open water to spawn a new ship there.",
    ]),
  );
  grid.appendChild(
    createRulesColumn("Shoot", [
      "Press Shoot, then touch one of your ships.",
      "The screen goes black - swipe fast to aim!",
      "Swipe direction aims the shot, swipe speed sets its distance.",
    ]),
  );
  modal.appendChild(grid);

  const winLine = document.createElement("p");
  winLine.className = "rules-win";
  winLine.textContent = "Sink the enemy's base ship to win!";
  modal.appendChild(winLine);

  backdrop.appendChild(modal);
  overlayEl.appendChild(backdrop);
}

/** Build one heading + bullet-list column for showRulesModal(). */
function createRulesColumn(heading, items) {
  const col = document.createElement("div");
  col.className = "rules-col";

  const colTitle = document.createElement("h2");
  colTitle.className = "rules-col-title";
  colTitle.textContent = heading;
  col.appendChild(colTitle);

  const list = document.createElement("ul");
  list.className = "rules-list";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  }
  col.appendChild(list);

  return col;
}

/**
 * Create the round Shoot button, centered on the right edge of the screen,
 * and append it to the UI overlay. Pressing it while the current player is
 * still choosing an action (Phase.PLACING) switches to Phase.AIMING_SHOT so
 * the player can shoot instead of placing a ship (CLAUDE.md "Action B -
 * Shoot"); the button turns red while shoot mode is active. Pressing it
 * again before aiming (touching a ship) cancels back to placing.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState} state
 * @returns {void}
 */
export function initShootButton(overlayEl, state) {
  const shootBtn = document.createElement("button");
  shootBtn.type = "button";
  shootBtn.className = "btn shoot-btn";
  shootBtn.setAttribute("aria-label", "Shoot");
  shootBtn.innerHTML =
    '<svg class="shoot-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 2c-2.2 0-3.5 2.1-3.5 4.5V19a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V6.5C15.5 4.1 14.2 2 12 2z"/>' +
    "</svg>";

  shootBtn.addEventListener("click", () => {
    if (state.phase === Phase.PLACING) {
      setPhase(state, Phase.AIMING_SHOT);
    } else if (state.phase === Phase.AIMING_SHOT) {
      setPhase(state, Phase.PLACING);
    } else {
      return; // mid-shot (blind/resolve phases): button does nothing
    }
    updateShootButton(overlayEl, state);
  });

  overlayEl.appendChild(shootBtn);
}

/**
 * Sync the Shoot button's red/grey background with the current phase.
 * Called after the button is pressed, and after a turn changes elsewhere
 * (e.g. a ship was placed) so the button resets for the next player.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState} state
 * @returns {void}
 */
export function updateShootButton(overlayEl, state) {
  const shootBtn = overlayEl.querySelector(".shoot-btn");
  if (!shootBtn) return;
  const shootModeActive = state.phase === Phase.AIMING_SHOT || state.phase === Phase.BLIND_SHOT;
  shootBtn.classList.toggle("shoot-btn--active", shootModeActive);
}

/**
 * Create the DOM elements owned by updateShootUI() (red screen border,
 * black blind-shot cover, "too slow" warning banner) and append them to
 * the UI overlay. All three start hidden; updateShootUI() toggles them
 * every frame based on state.phase/state.warning. Call once at match start,
 * alongside initShootButton().
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @returns {void}
 */
export function initShootUI(overlayEl) {
  const redBorder = document.createElement("div");
  redBorder.className = "red-border";
  overlayEl.appendChild(redBorder);

  const blindCover = document.createElement("div");
  blindCover.className = "blind-cover";
  blindCover.textContent = "Swipe to aim - fast!";
  overlayEl.appendChild(blindCover);

  const warningBanner = document.createElement("div");
  warningBanner.className = "warning-banner";
  overlayEl.appendChild(warningBanner);
}

/**
 * Per-frame sync of everything Action B ("Shoot") needs shown, driven
 * entirely off state (see CLAUDE.md "Action B - Shoot" steps 2-3 and the
 * win condition): the red screen border while shoot mode is active
 * (Phase.AIMING_SHOT/BLIND_SHOT), the black blind-shot cover
 * (Phase.BLIND_SHOT only), the transient "too slow" warning
 * (state.warning, set by js/input.js), and the victory screen once
 * isGameOver(state) - built lazily so it only ever appears once per match.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState & {warning?: {text:string, until:number}|null}} state
 * @param {number} time - ms timestamp, e.g. from requestAnimationFrame
 * @param {{onRematch?: () => void}} [callbacks]
 * @returns {void}
 */
export function updateShootUI(overlayEl, state, time, callbacks = {}) {
  const shootModeActive = state.phase === Phase.AIMING_SHOT || state.phase === Phase.BLIND_SHOT;
  overlayEl.querySelector(".red-border")?.classList.toggle("red-border--active", shootModeActive);
  overlayEl.querySelector(".blind-cover")?.classList.toggle("blind-cover--active", state.phase === Phase.BLIND_SHOT);

  const warningBanner = overlayEl.querySelector(".warning-banner");
  if (warningBanner) {
    const warningActive = !!state.warning && time < state.warning.until;
    warningBanner.classList.toggle("warning-banner--active", warningActive);
    warningBanner.textContent = warningActive ? state.warning.text : "";
  }

  if (isGameOver(state) && !overlayEl.querySelector(".victory-backdrop")) {
    showVictoryScreen(overlayEl, state, callbacks);
  }
}

/**
 * Create the small "undo" cross button shown during Phase.CONFIRMING_PLACEMENT
 * (CLAUDE.md Action A confirm/revert window): tapping it calls `onRevert`
 * (wired up by main.js to js/input.js's revertPendingPlacement()), which
 * removes the ship just placed and hands control back to the same player.
 * Starts hidden; updatePlacementConfirmUI() positions and shows/hides it
 * every frame. Call once at match start, alongside initShootUI().
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {() => void} onRevert
 * @returns {void}
 */
export function initPlacementConfirmUI(overlayEl, onRevert) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "confirm-revert-btn";
  btn.setAttribute("aria-label", "Undo placement");
  btn.textContent = "✕"; // heavy multiplication x, reads as a cross at this size
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (onRevert) onRevert();
  });
  overlayEl.appendChild(btn);
}

/**
 * Per-frame sync of the "undo" cross button (see initPlacementConfirmUI):
 * positioned just off the placed ship's hull and shown only while
 * Phase.CONFIRMING_PLACEMENT is active for the ship named by
 * state.pendingPlacement; hidden (and left in place) the instant the
 * placement commits or reverts, its CSS opacity transition providing the
 * fade described in CLAUDE.md Action A - a quick fade either way, whether
 * the window ran its full course or the opponent force-committed it early.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState & {pendingPlacement?: {shipId:string}|null}} state
 * @param {number} width - canvas CSS width
 * @param {number} height - canvas CSS height
 * @returns {void}
 */
export function updatePlacementConfirmUI(overlayEl, state, width, height) {
  const btn = overlayEl.querySelector(".confirm-revert-btn");
  if (!btn) return;

  const ship =
    state.pendingPlacement && state.ships.find((candidate) => candidate.id === state.pendingPlacement.shipId);
  if (!ship) {
    btn.classList.remove("confirm-revert-btn--active");
    return;
  }

  const pos = relToPixel(ship.x, ship.y, width, height);
  const OFFSET_PX = 26; // keeps the button clear of the ship hull it belongs to
  btn.style.left = `${pos.x + OFFSET_PX}px`;
  btn.style.top = `${pos.y - OFFSET_PX}px`;
  btn.classList.add("confirm-revert-btn--active");
}

/** Build and show the one-time victory screen (see updateShootUI). */
function showVictoryScreen(overlayEl, state, callbacks) {
  const winner = getBaseShip(state, 1) ? 1 : 2;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop victory-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";

  const title = document.createElement("h1");
  title.className = "modal-title";
  title.textContent = `Player ${winner} wins!`;
  modal.appendChild(title);

  const statsRow = document.createElement("div");
  statsRow.className = "victory-stats";
  statsRow.appendChild(createStatCounters(1, "modal"));
  statsRow.appendChild(createStatCounters(2, "modal"));
  modal.appendChild(statsRow);
  updateStatCounters(statsRow.querySelectorAll(".stat-counters"), state.stats);

  const rematchBtn = document.createElement("button");
  rematchBtn.type = "button";
  rematchBtn.className = "btn modal-start-btn";
  rematchBtn.textContent = "Rematch";
  rematchBtn.addEventListener("click", () => {
    backdrop.remove();
    if (callbacks.onRematch) callbacks.onRematch();
  });
  modal.appendChild(rematchBtn);

  backdrop.appendChild(modal);
  overlayEl.appendChild(backdrop);
}
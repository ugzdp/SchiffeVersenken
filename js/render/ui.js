// ui.js
//
// Builds DOM-based UI elements inside the #ui-overlay div (see index.html).
// This is separate from renderer.js/effects.js, which draw onto the Canvas.
// Per CLAUDE.md, this module owns the turn indicator, buttons, red border,
// black overlay, warnings and victory screen. For now it only builds the
// top menu bar and the Shoot button.

import { Phase, getBaseShip, isGameOver, pauseMatch, resumeMatch, setPhase } from "../engine/gameState.js";
import { computeScore } from "../engine/scoring.js";
import { relToPixel } from "./coords.js";
import { isMuted, playClick, playGunCock, toggleMuted, unlockAudio } from "./audio.js";
import { loadLeaderboard, recordMatchResult, resetLeaderboard } from "../data/leaderboardStore.js";

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

// Star icon (skill score): reuses the classic 5-point outline star shape.
const SCORE_ICON_SVG =
  '<svg class="stat-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
  "</svg>";

// Light click/tap sound for every UI button and settings-menu-item press
// (Settings, Rules, Restart, Sound toggle, Leaderboard, Continue, Rematch,
// modal close buttons, Reset stats, etc.). One delegated listener instead of
// wiring playClick() into every individual button's own handler, so buttons
// built lazily (dropdown items, modals) are covered automatically. This has
// to run on the CAPTURE phase (the `true` below): several of these buttons
// sit inside a dropdown/modal whose own click listener calls
// event.stopPropagation() (to stop an outside click closing it), which would
// otherwise stop a bubble-phase document listener from ever seeing the click.
document.addEventListener(
  "click",
  (event) => {
    if (!event.target.closest(".btn, .settings-menu-item")) return;
    unlockAudio(); // safety net - covers the very first click of a session (the start modal), before any canvas touch
    playClick();
  },
  true,
);

/**
 * Create the top menu bar (Settings dropdown and standalone Rules button
 * together in the left corner, player labels centered, each flanked by its
 * shot/hit counters) and append it to the UI overlay. The label of
 * `state.currentPlayer` gets a green outline to show whose turn it is.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState} state
 * @param {{onRestart?: () => void, onHome?: () => void}} [callbacks] - handlers for settings menu items
 * @returns {void}
 */
export function initMenuBar(overlayEl, state, callbacks = {}) {
  const bar = document.createElement("div");
  bar.className = "menu-bar";

  const leftGroup = document.createElement("div");
  leftGroup.className = "menu-bar-left";
  leftGroup.appendChild(createSettingsMenu(callbacks, overlayEl, state));
  leftGroup.appendChild(createRulesButton(overlayEl));
  bar.appendChild(leftGroup);

  const players = document.createElement("div");
  players.className = "players";

  // Player 1's counters sit to the left of their label, player 2's to the
  // right of theirs, so each player's stats stay next to their own name.
  players.appendChild(createStatCounters(1, "bar", state));

  const player1 = document.createElement("span");
  player1.className = "player-label";
  player1.dataset.player = "1";
  player1.textContent = seatLabel(state, 1);
  players.appendChild(player1);

  const timer = document.createElement("span");
  timer.className = "match-timer";
  timer.textContent = "00:00";
  players.appendChild(timer);

  const player2 = document.createElement("span");
  player2.className = "player-label";
  player2.dataset.player = "2";
  player2.textContent = seatLabel(state, 2);
  players.appendChild(player2);

  players.appendChild(createStatCounters(2, "bar", state));

  bar.appendChild(players);
  overlayEl.appendChild(bar);

  updateMenuBar(overlayEl, state);
}

/**
 * Move the active-player highlight to whichever player label matches
 * `state.currentPlayer`, and refresh the shot/hit/score counter numbers from
 * `state.stats` (see computeScore() in js/engine/scoring.js). Called after
 * every turn change and every shot for instant feedback, and again every
 * frame from the main render loop so the score's live pace component keeps
 * ticking even when nothing else has changed.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState} state
 * @param {number} [time] - timestamp (same clock as requestAnimationFrame/
 *   event.timeStamp) for the score's live pace bonus; defaults to "now" for
 *   callers that don't have one handy (e.g. right after a discrete action)
 * @returns {void}
 */
export function updateMenuBar(overlayEl, state, time = performance.now()) {
  const labels = overlayEl.querySelectorAll(".player-label");
  labels.forEach((label) => {
    label.classList.toggle("player-label--active", Number(label.dataset.player) === state.currentPlayer);
  });
  updateStatCounters(overlayEl.querySelectorAll(".stat-counters"), state, time);
}

/**
 * Build one player's shot/hit/score counter trio (bullet icon + number,
 * target icon + number, star icon + number). Shared between the live menu
 * bar and the victory modal's snapshot copy - `size` ("bar" | "modal") picks
 * the CSS variant. The score counter's value is filled in by
 * updateStatCounters() (see computeScore() in js/engine/scoring.js) - it
 * needs `state` and a timestamp, neither of which this builder has.
 * @param {1|2} owner
 * @param {"bar"|"modal"} size
 * @param {import("../engine/gameState.js").GameState} [state] - only needed
 *   for the "modal" label text (see seatLabel); omit for the live bar, whose
 *   own player-label span next to it already carries the name
 * @returns {HTMLElement}
 */
function createStatCounters(owner, size, state) {
  const wrap = document.createElement("div");
  wrap.className = `stat-counters stat-counters--${size}`;
  wrap.dataset.player = String(owner);

  if (size === "modal") {
    const label = document.createElement("span");
    label.className = "stat-counters-label";
    label.textContent = state ? seatLabel(state, owner) : `Player ${owner}`;
    wrap.appendChild(label);
  }

  wrap.appendChild(createStatCounter("shots", BULLET_ICON_SVG));
  wrap.appendChild(createStatCounter("hits", TARGET_ICON_SVG));
  wrap.appendChild(createStatCounter("score", SCORE_ICON_SVG));

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
 * Format a duration in milliseconds as "MM:SS" (zero-padded, no hour digit -
 * minutes just keep climbing past 59). Shared by the live match-clock
 * display and the victory screen's "Time to win" line.
 * @param {number} ms
 * @returns {string}
 */
function formatMatchTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Per-frame sync of the match-clock display in the menu bar (see
 * initMenuBar): counts up from 00:00 from state.matchStartTime, freezing at
 * state.matchEndTime once the match has been won so the final "time to win"
 * stays visible under the victory screen too.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState} state
 * @param {number} time - timestamp (same clock as requestAnimationFrame/
 *   startMatchClock) for the current frame
 * @returns {void}
 */
export function updateTimer(overlayEl, state, time) {
  const timerEl = overlayEl.querySelector(".match-timer");
  if (!timerEl || state.matchStartTime === null) return;
  const elapsed = (state.matchEndTime ?? time) - state.matchStartTime;
  timerEl.textContent = formatMatchTime(elapsed);
}

/**
 * Sync every stat-counters block's shot/hit/score numbers with `state`.
 * Reused for both the live menu bar and the victory modal's one-time
 * snapshot (which passes state.matchEndTime as `time`, freezing the score
 * exactly like the match clock - see computeScore() in js/engine/scoring.js).
 * @param {NodeListOf<HTMLElement>} counterBlocks - elements with class "stat-counters"
 * @param {import("../engine/gameState.js").GameState} state
 * @param {number} time - timestamp for the score's live pace bonus (see updateMenuBar)
 * @returns {void}
 */
function updateStatCounters(counterBlocks, state, time) {
  counterBlocks.forEach((block) => {
    const owner = Number(block.dataset.player);
    const playerStats = state.stats[owner];
    block.querySelector(".stat-counter--shots .stat-counter-value").textContent = playerStats.shots;
    block.querySelector(".stat-counter--hits .stat-counter-value").textContent = playerStats.hits;
    block.querySelector(".stat-counter--score .stat-counter-value").textContent = computeScore(state, owner, time);
  });
}

/**
 * Build the Settings button and its dropdown menu. The dropdown starts
 * closed, opens on clicking the button, and closes again on picking an
 * item or clicking anywhere else on the page. Rules lives in its own
 * standalone button next to Settings (see createRulesButton) rather than
 * in this dropdown.
 * @param {{onRestart?: () => void, onHome?: () => void}} callbacks
 * @param {HTMLElement} overlayEl - the #ui-overlay element, needed to show the leaderboard modal
 * @param {import("../engine/gameState.js").GameState} state - needed by the
 *   Pause game item (reads/writes state.paused/state.phase/state.dragPath)
 * @returns {HTMLElement} wrapper element containing both the button and its dropdown
 */
function createSettingsMenu(callbacks, overlayEl, state) {
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
  restartBtn.textContent = "Generate new map";
  restartBtn.addEventListener("click", () => {
    dropdown.classList.remove("settings-dropdown--open");
    if (callbacks.onRestart) callbacks.onRestart();
  });
  dropdown.appendChild(restartBtn);

  const pauseBtn = document.createElement("button");
  pauseBtn.type = "button";
  pauseBtn.className = "settings-menu-item";
  const syncPauseLabel = () => {
    pauseBtn.textContent = state.paused ? "Continue game" : "Pause game";
  };
  syncPauseLabel();
  pauseBtn.addEventListener("click", () => {
    dropdown.classList.remove("settings-dropdown--open");
    if (state.paused) {
      resumeMatch(state, performance.now());
    } else {
      // Only pausable during the "calm" moment between turns - waiting for
      // the current player to place a ship or press Shoot, with no drag in
      // progress - so it never has to race the real-wallclock setTimeout
      // windows CONFIRMING_PLACEMENT/SHOT_RESOLVE briefly run (the undo-cross
      // timer, the shot-tracer display), which would otherwise be able to
      // silently fire and pass the turn while the screen reads "paused".
      // Matches the Shoot button's own existing precedent of being a no-op
      // outside the phases it's meant for.
      if (state.phase !== Phase.PLACING || state.dragPath) return;
      pauseMatch(state, performance.now());
    }
    syncPauseLabel();
  });
  dropdown.appendChild(pauseBtn);

  const leaderboardBtn = document.createElement("button");
  leaderboardBtn.type = "button";
  leaderboardBtn.className = "settings-menu-item";
  leaderboardBtn.textContent = "Leaderboard";
  leaderboardBtn.addEventListener("click", () => {
    dropdown.classList.remove("settings-dropdown--open");
    showLeaderboardModal(overlayEl);
  });
  dropdown.appendChild(leaderboardBtn);

  const soundBtn = document.createElement("button");
  soundBtn.type = "button";
  soundBtn.className = "settings-menu-item";
  const syncSoundLabel = () => {
    soundBtn.textContent = isMuted() ? "Sound: Off" : "Sound: On";
  };
  syncSoundLabel();
  soundBtn.addEventListener("click", () => {
    toggleMuted();
    syncSoundLabel();
  });
  dropdown.appendChild(soundBtn);

  const homeBtn = document.createElement("button");
  homeBtn.type = "button";
  homeBtn.className = "settings-menu-item";
  homeBtn.textContent = "Home menu";
  homeBtn.addEventListener("click", () => {
    dropdown.classList.remove("settings-dropdown--open");
    // Mid-match this abandons real progress (unlike the post-game Home menu
    // button next to Rematch, which has nothing left to lose) - confirm
    // first, same as the leaderboard's "Reset stats".
    if (!confirm("Leave this match and return to the home menu?")) return;
    if (callbacks.onHome) callbacks.onHome();
  });
  dropdown.appendChild(homeBtn);

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
 * Build the standalone Rules button shown next to Settings in the menu bar.
 * Opens the same rules modal as before, just without going through the
 * Settings dropdown first.
 * @param {HTMLElement} overlayEl - the #ui-overlay element, needed to show the rules modal
 * @returns {HTMLElement}
 */
function createRulesButton(overlayEl) {
  const rulesBtn = document.createElement("button");
  rulesBtn.type = "button";
  rulesBtn.className = "btn rules-btn";
  rulesBtn.textContent = "Rules";
  rulesBtn.addEventListener("click", () => showRulesModal(overlayEl));
  return rulesBtn;
}

/**
 * Show the start modal: first a Multiplayer/Single Player choice, then -
 * only if Single Player was picked - a bot difficulty choice (easy/medium/
 * hard/trained), before finally starting the match.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {(mode: "pvp"|"pvb", botDifficulty: "easy"|"medium"|"hard"|"trained"|null) => void} onStart
 * @returns {void}
 */
export function initStartModal(overlayEl, onStart) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";
  backdrop.appendChild(modal);
  overlayEl.appendChild(backdrop);

  renderModeStep();

  /** Step 1: Multiplayer starts right away, Single Player advances to the difficulty step. */
  function renderModeStep() {
    modal.replaceChildren();

    const title = document.createElement("h1");
    title.className = "modal-title";
    title.textContent = "Schiffe Versenken";
    modal.appendChild(title);

    const choices = document.createElement("div");
    choices.className = "modal-choice-row";
    choices.appendChild(
      createChoiceButton("Mehrspieler", () => {
        backdrop.remove();
        onStart("pvp", null);
      })
    );
    choices.appendChild(createChoiceButton("Einzelspieler", renderDifficultyStep));
    modal.appendChild(choices);
  }

  /** Step 2 (Single Player only): pick the bot's difficulty, or go back. */
  function renderDifficultyStep() {
    modal.replaceChildren();

    const title = document.createElement("h1");
    title.className = "modal-title";
    title.textContent = "Gegnerstärke wählen";
    modal.appendChild(title);

    const choices = document.createElement("div");
    choices.className = "modal-choice-row";
    for (const [key, label] of [
      ["easy", "Leicht"],
      ["medium", "Mittel"],
      ["hard", "Schwer"],
      ["trained", "Trainiert"],
    ]) {
      choices.appendChild(
        createChoiceButton(label, () => {
          backdrop.remove();
          onStart("pvb", key);
        })
      );
    }
    modal.appendChild(choices);

    const back = document.createElement("button");
    back.type = "button";
    back.className = "btn modal-back-btn";
    back.textContent = "Zurück";
    back.addEventListener("click", renderModeStep);
    modal.appendChild(back);
  }

  function createChoiceButton(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn modal-start-btn";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }
}

// Display names for the bot difficulty label shown wherever "Player 2" would
// otherwise appear once state.mode is "pvb" (see seatLabel below).
const BOT_DIFFICULTY_LABEL = { easy: "Leicht", medium: "Mittel", hard: "Schwer", trained: "Trainiert" };

/**
 * The name to show for one seat: "Player N" normally, or "Bot (<difficulty>)"
 * for player 2 once a single-player match is running (state.mode === "pvb").
 * @param {import("../engine/gameState.js").GameState} state
 * @param {1|2} seat
 * @returns {string}
 */
function seatLabel(state, seat) {
  if (seat === 2 && state.mode === "pvb") {
    return `Bot (${BOT_DIFFICULTY_LABEL[state.botDifficulty] || "?"})`;
  }
  return `Player ${seat}`;
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
      "Freehand-drag a path out from one of your ships - it can curve around islands.",
      "The path has a max length, then it freezes - release over open water to spawn a ship.",
      "You get a second to undo the placement before the turn passes.",
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
 * Show the "Leaderboard" modal (Settings > Leaderboard): all-time totals per
 * seat (Player 1 / Player 2), read from js/data/leaderboardStore.js. Since
 * this game has no player accounts, "all-time" means every match played on
 * this device/browser, tracked by seat rather than by name (see that
 * module's header comment). Closes on the close button or an outside click;
 * "Reset stats" wipes the stored history after a confirmation prompt.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @returns {void}
 */
function showLeaderboardModal(overlayEl) {
  if (overlayEl.querySelector(".leaderboard-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop leaderboard-backdrop";
  backdrop.addEventListener("click", () => backdrop.remove());

  const modal = document.createElement("div");
  modal.className = "modal leaderboard-modal";
  modal.addEventListener("click", (event) => event.stopPropagation());

  const header = document.createElement("div");
  header.className = "rules-header";

  const title = document.createElement("h1");
  title.className = "modal-title";
  title.textContent = "Leaderboard";
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
  grid.className = "leaderboard-grid";
  modal.appendChild(grid);
  renderLeaderboardGrid(grid);

  const note = document.createElement("p");
  note.className = "leaderboard-note";
  note.textContent = "All-time stats for this device - stored locally, not shared across devices.";
  modal.appendChild(note);

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "btn leaderboard-reset-btn";
  resetBtn.textContent = "Reset stats";
  resetBtn.addEventListener("click", () => {
    if (!confirm("Reset all-time leaderboard stats? This can't be undone.")) return;
    resetLeaderboard();
    renderLeaderboardGrid(grid);
  });
  modal.appendChild(resetBtn);

  backdrop.appendChild(modal);
  overlayEl.appendChild(backdrop);
}

/** (Re)fill `grid` with one stats column per seat, read fresh from storage. */
function renderLeaderboardGrid(grid) {
  grid.innerHTML = "";
  const data = loadLeaderboard();
  grid.appendChild(createLeaderboardColumn(1, data.totals[1]));
  grid.appendChild(createLeaderboardColumn(2, data.totals[2]));
}

/** Build one seat's stats column (games/wins/losses/shots/sunk/accuracy) for the leaderboard modal. */
function createLeaderboardColumn(seat, totals) {
  const col = document.createElement("div");
  col.className = "leaderboard-col";

  const heading = document.createElement("h2");
  heading.className = "rules-col-title";
  heading.textContent = `Player ${seat}`;
  col.appendChild(heading);

  const accuracy = totals.shots > 0 ? Math.round((totals.hits / totals.shots) * 100) : 0;
  const rows = [
    ["Games played", totals.gamesPlayed],
    ["Wins", totals.wins],
    ["Losses", totals.losses],
    ["Shots fired", totals.shots],
    ["Ships sunk", totals.hits],
    ["Accuracy", `${accuracy}%`],
  ];

  const list = document.createElement("dl");
  list.className = "leaderboard-stats";
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    row.appendChild(dt);
    row.appendChild(dd);
    list.appendChild(row);
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
    // A button click is a trusted user gesture too - safety net in case this
    // is the very first interaction of the match (before any canvas touch).
    unlockAudio();

    // Single-player: don't let the human arm shoot mode on the bot's turn -
    // js/botController.js resolves a bot shot straight through
    // js/engine/actions.js's fireShot() (no blackout, no swipe - see
    // CLAUDE.md), it never presses this button or passes through
    // Phase.AIMING_SHOT/BLIND_SHOT at all.
    if (state.mode === "pvb" && state.currentPlayer === 2) return;

    if (state.phase === Phase.PLACING) {
      setPhase(state, Phase.AIMING_SHOT);
      playGunCock(); // arming shoot mode - only on the way in, not on cancel
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
 * black blind-shot cover, "too slow" warning banner, paused overlay) and
 * append them to the UI overlay. All start hidden; updateShootUI() toggles
 * them every frame based on state.phase/state.warning/state.paused. Call
 * once at match start, alongside initShootButton().
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

  // Purely visual - js/input.js is what actually blocks pointer input while
  // state.paused (pointer-events: none here, same as .blind-cover, so it
  // never gets in the way of reopening Settings to press Continue game).
  const pauseOverlay = document.createElement("div");
  pauseOverlay.className = "pause-overlay";
  pauseOverlay.textContent = "Paused";
  overlayEl.appendChild(pauseOverlay);
}

/**
 * Per-frame sync of everything Action B ("Shoot") needs shown, driven
 * entirely off state (see CLAUDE.md "Action B - Shoot" steps 2-3 and the
 * win condition): the red screen border while shoot mode is active
 * (Phase.AIMING_SHOT/BLIND_SHOT), the black blind-shot cover
 * (Phase.BLIND_SHOT only), the transient "too slow" warning
 * (state.warning, set by js/input.js), the dim "Paused" overlay
 * (state.paused, set by Settings > Pause game), and the victory screen once
 * isGameOver(state) - built lazily so it only ever appears once per match.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState & {warning?: {text:string, until:number}|null}} state
 * @param {number} time - ms timestamp, e.g. from requestAnimationFrame
 * @param {{onRematch?: () => void, onHome?: () => void}} [callbacks]
 * @returns {void}
 */
export function updateShootUI(overlayEl, state, time, callbacks = {}) {
  const shootModeActive = state.phase === Phase.AIMING_SHOT || state.phase === Phase.BLIND_SHOT;
  overlayEl.querySelector(".red-border")?.classList.toggle("red-border--active", shootModeActive);
  overlayEl.querySelector(".blind-cover")?.classList.toggle("blind-cover--active", state.phase === Phase.BLIND_SHOT);
  overlayEl.querySelector(".pause-overlay")?.classList.toggle("pause-overlay--active", state.paused);

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

// Must match the CSS transition durations on .confirm-revert-btn /
// .confirm-revert-btn--touch in style.css: once the button stops being
// --active, it keeps taking taps for exactly this long (via --fading) so a
// tap that lands mid-fade still registers, then goes inert. Touch placements
// get a slower fade (and thus a longer clickable tail) since a finger's tap
// lands later/less precisely than a mouse click - see CLAUDE.md Action A.
const CONFIRM_FADE_MS = 200;
const TOUCH_CONFIRM_FADE_MS = 600;

let confirmFadeTimer = null;

/**
 * Per-frame sync of the "undo" cross button (see initPlacementConfirmUI):
 * positioned just off the placed ship's hull and shown only while
 * Phase.CONFIRMING_PLACEMENT is active for the ship named by
 * state.pendingPlacement; hidden the instant the placement commits or
 * reverts, its CSS opacity transition providing the fade described in
 * CLAUDE.md Action A - a quick fade either way, whether the window ran its
 * full course or the opponent force-committed it early. The button stays
 * tappable for the whole fade (see --fading below), and touch placements
 * (state.pendingPlacement.isTouch) get a slower fade with a longer tappable
 * tail than mouse ones, since a finger's tap lands later/less precisely.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState & {pendingPlacement?: {shipId:string, isTouch?:boolean}|null}} state
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
    if (btn.classList.contains("confirm-revert-btn--active")) {
      const isTouch = btn.classList.contains("confirm-revert-btn--touch");
      btn.classList.remove("confirm-revert-btn--active");
      btn.classList.add("confirm-revert-btn--fading");
      clearTimeout(confirmFadeTimer);
      confirmFadeTimer = setTimeout(
        () => btn.classList.remove("confirm-revert-btn--fading", "confirm-revert-btn--touch"),
        isTouch ? TOUCH_CONFIRM_FADE_MS : CONFIRM_FADE_MS
      );
    }
    return;
  }

  const pos = relToPixel(ship.x, ship.y, width, height);
  const OFFSET_PX = 26; // keeps the button clear of the ship hull it belongs to
  btn.style.left = `${pos.x + OFFSET_PX}px`;
  btn.style.top = `${pos.y - OFFSET_PX}px`;
  btn.classList.toggle("confirm-revert-btn--touch", !!state.pendingPlacement.isTouch);
  btn.classList.remove("confirm-revert-btn--fading");
  clearTimeout(confirmFadeTimer);
  btn.classList.add("confirm-revert-btn--active");
}

/**
 * Build and show the one-time victory screen (see updateShootUI). Records
 * the match into the all-time (localStorage) leaderboard right away, but the
 * "Top Scores" high-score screen (showHighScoresScreen) only appears once
 * the player presses Continue here - the round summary is shown first.
 */
function showVictoryScreen(overlayEl, state, callbacks) {
  const winner = getBaseShip(state, 1) ? 1 : 2;
  const durationMs =
    state.matchStartTime !== null && state.matchEndTime !== null ? state.matchEndTime - state.matchStartTime : null;

  // Record this finished match into the all-time (localStorage) leaderboard,
  // from the winner's side - their frozen final score (see computeScore() in
  // js/engine/scoring.js) is the leaderboard's sort key. Safe to call exactly
  // here: updateShootUI() only calls showVictoryScreen() once per match,
  // guarded by the ".victory-backdrop" check below.
  const attempt = {
    score: computeScore(state, winner, performance.now()),
    shots: state.stats[winner].shots,
    hits: state.stats[winner].hits,
    durationMs,
  };
  const { timestamp: matchTimestamp } = recordMatchResult(winner, state.stats, attempt, {
    mode: state.mode,
    botDifficulty: state.botDifficulty,
  });

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop victory-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";

  const title = document.createElement("h1");
  title.className = "modal-title";
  title.textContent = `${seatLabel(state, winner)} wins!`;
  modal.appendChild(title);

  if (state.matchStartTime !== null && state.matchEndTime !== null) {
    const timeLine = document.createElement("p");
    timeLine.className = "victory-time";
    timeLine.textContent = `Time to win: ${formatMatchTime(state.matchEndTime - state.matchStartTime)}`;
    modal.appendChild(timeLine);
  }

  const statsRow = document.createElement("div");
  statsRow.className = "victory-stats";
  statsRow.appendChild(createStatCounters(1, "modal", state));
  statsRow.appendChild(createStatCounters(2, "modal", state));
  modal.appendChild(statsRow);
  // `time` is irrelevant here - state.matchEndTime is already set by this
  // point, so computeScore() ignores it and returns each player's frozen
  // final score, same as the match clock.
  updateStatCounters(statsRow.querySelectorAll(".stat-counters"), state, performance.now());

  const continueBtn = document.createElement("button");
  continueBtn.type = "button";
  continueBtn.className = "btn modal-start-btn";
  continueBtn.textContent = "Continue";
  continueBtn.addEventListener("click", () => {
    // Hide, don't remove: state.phase is still Phase.GAMEOVER until the
    // eventual Rematch press actually restarts the match, and updateShootUI()
    // re-triggers showVictoryScreen() the instant it can no longer find a
    // ".victory-backdrop" element - removing this one now would pop the round
    // summary right back up on top of the high-score screen next frame.
    backdrop.style.display = "none";
    // Solo (vs-bot) results have their own record, kept separate from the
    // PvP "Top Scores" ranking - see leaderboardStore.js's `vsBot`.
    if (state.mode === "pvb") showSoloResultScreen(overlayEl, state, callbacks);
    else showHighScoresScreen(overlayEl, attempt, matchTimestamp, callbacks);
  });
  modal.appendChild(continueBtn);

  backdrop.appendChild(modal);
  overlayEl.appendChild(backdrop);
}

/**
 * Show the post-game screen for a single-player match, reached by pressing
 * Continue on the victory screen: just the human's all-time record against
 * this bot difficulty (js/data/leaderboardStore.js's `vsBot`, kept separate
 * from the PvP "Top Scores" ranking - see showHighScoresScreen) and a
 * Rematch button, plus a Home menu button (see showHighScoresScreen's for
 * what that does) next to it. Pressing Rematch here is what actually starts
 * the next match, same as showHighScoresScreen's.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {import("../engine/gameState.js").GameState} state
 * @param {{onRematch?: () => void, onHome?: () => void}} callbacks
 * @returns {void}
 */
function showSoloResultScreen(overlayEl, state, callbacks) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop high-scores-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";

  const title = document.createElement("h1");
  title.className = "modal-title";
  title.textContent = "Round Summary";
  modal.appendChild(title);

  const record = loadLeaderboard().vsBot[state.botDifficulty] || { gamesPlayed: 0, wins: 0, losses: 0 };
  const note = document.createElement("p");
  note.className = "leaderboard-note";
  note.textContent =
    `Vs. ${BOT_DIFFICULTY_LABEL[state.botDifficulty] || "Bot"}: ` +
    `${record.wins} win${record.wins === 1 ? "" : "s"} / ${record.losses} loss${record.losses === 1 ? "" : "es"} ` +
    `(${record.gamesPlayed} played)`;
  modal.appendChild(note);

  const actions = document.createElement("div");
  actions.className = "modal-choice-row";

  const rematchBtn = document.createElement("button");
  rematchBtn.type = "button";
  rematchBtn.className = "btn modal-start-btn";
  rematchBtn.textContent = "Rematch";
  rematchBtn.addEventListener("click", () => {
    backdrop.remove();
    overlayEl.querySelector(".victory-backdrop")?.remove(); // the hidden round-summary screen (see showVictoryScreen's Continue handler)
    if (callbacks.onRematch) callbacks.onRematch();
  });
  actions.appendChild(rematchBtn);
  actions.appendChild(createHomeButton(overlayEl, callbacks));
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  overlayEl.appendChild(backdrop);
}

/**
 * Build the "Home menu" button shown next to Rematch on both post-game
 * screens (showSoloResultScreen/showHighScoresScreen): drops whichever of
 * the two post-game backdrops is currently showing, same cleanup Rematch
 * itself does, then hands off to `callbacks.onHome` (main.js's goHome()) to
 * bring back the Multiplayer/Single Player picker.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {{onHome?: () => void}} callbacks
 * @returns {HTMLElement}
 */
function createHomeButton(overlayEl, callbacks) {
  const homeBtn = document.createElement("button");
  homeBtn.type = "button";
  homeBtn.className = "btn modal-back-btn";
  homeBtn.textContent = "Home menu";
  homeBtn.addEventListener("click", () => {
    overlayEl.querySelector(".high-scores-backdrop")?.remove();
    overlayEl.querySelector(".victory-backdrop")?.remove(); // the hidden round-summary screen (see showVictoryScreen's Continue handler)
    if (callbacks.onHome) callbacks.onHome();
  });
  return homeBtn;
}

// Column labels shared between the header row and each data row of the
// "Top Scores" screen's table (see showHighScoresScreen/createHighScoreRow):
// rank first, then score (the sort key), then the stats behind it - shots
// fired, ships hit, time to win.
const HIGH_SCORE_COLUMNS = ["#", "Score", "Shots", "Hits", "Time"];

/**
 * Show the post-game "Top Scores" high-score screen, reached by pressing
 * Continue on the victory screen (round summary first, this second): a
 * ranked table of up to the three highest-scoring wins ever recorded on
 * this device/browser (see js/data/leaderboardStore.js's `attempts`, sorted
 * by computeScore() - js/engine/scoring.js), each row showing that win's
 * score, shots fired, ships hit and time to win. The match that was just
 * played is highlighted - in place if it lands in that top three, or as its
 * own row below a small gap, labeled with its actual rank, if it doesn't.
 * Pressing Rematch here is what actually starts the next match; the Home
 * menu button next to it (see createHomeButton) instead returns to the
 * Multiplayer/Single Player picker.
 * @param {HTMLElement} overlayEl - the #ui-overlay element from index.html
 * @param {{score:number, shots:number, hits:number, durationMs:number|null}} attempt -
 *   the just-played match's winning-side result (see showVictoryScreen)
 * @param {number} matchTimestamp - the id recordMatchResult() gave this
 *   match's `attempts` entry, used to find/highlight it again after sorting
 * @param {{onRematch?: () => void, onHome?: () => void}} callbacks
 * @returns {void}
 */
function showHighScoresScreen(overlayEl, attempt, matchTimestamp, callbacks) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop high-scores-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal high-scores-modal";

  const title = document.createElement("h1");
  title.className = "modal-title";
  title.textContent = "Top Scores";
  modal.appendChild(title);

  const sortedAttempts = [...loadLeaderboard().attempts].sort((a, b) => b.score - a.score);
  const totalAttempts = sortedAttempts.length;
  const currentRank = sortedAttempts.findIndex((entry) => entry.timestamp === matchTimestamp) + 1; // 0 if not found

  const table = document.createElement("div");
  table.className = "high-scores-table";
  table.appendChild(createHighScoreRow(HIGH_SCORE_COLUMNS, "high-scores-header"));

  sortedAttempts.slice(0, 3).forEach((entry, i) => {
    table.appendChild(createHighScoreRow(scoreRowValues(i + 1, entry), null, entry.timestamp === matchTimestamp));
  });

  // The just-played match didn't crack the top three: show it separately,
  // set off by a gap, labeled with where it actually landed among every
  // match ever won on this device.
  if (currentRank > 3) {
    const gap = document.createElement("div");
    gap.className = "high-scores-gap";
    table.appendChild(gap);
    table.appendChild(createHighScoreRow(scoreRowValues(currentRank, attempt), null, true));
  }

  modal.appendChild(table);

  const note = document.createElement("p");
  note.className = "leaderboard-note";
  note.textContent = `Rank ${currentRank} of ${totalAttempts} win${totalAttempts === 1 ? "" : "s"} on this device.`;
  modal.appendChild(note);

  const actions = document.createElement("div");
  actions.className = "modal-choice-row";

  const rematchBtn = document.createElement("button");
  rematchBtn.type = "button";
  rematchBtn.className = "btn modal-start-btn";
  rematchBtn.textContent = "Rematch";
  rematchBtn.addEventListener("click", () => {
    backdrop.remove();
    overlayEl.querySelector(".victory-backdrop")?.remove(); // the hidden round-summary screen (see showVictoryScreen's Continue handler)
    if (callbacks.onRematch) callbacks.onRematch();
  });
  actions.appendChild(rematchBtn);
  actions.appendChild(createHomeButton(overlayEl, callbacks));
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  overlayEl.appendChild(backdrop);
}

/** Build one row's five column values (rank, score, shots, hits, time) for showHighScoresScreen()'s table. */
function scoreRowValues(rank, entry) {
  return [
    `#${rank}`,
    String(entry.score),
    String(entry.shots),
    String(entry.hits),
    entry.durationMs !== null ? formatMatchTime(entry.durationMs) : "--:--",
  ];
}

/**
 * Build one row of the "Top Scores" table - either the header (column
 * labels, `extraClass` "high-scores-header") or a data row (five values from
 * scoreRowValues(), optionally `highlighted` for the just-played match).
 * @param {string[]} values - exactly HIGH_SCORE_COLUMNS.length cell strings
 * @param {string|null} extraClass - extra class for a header row, or null for a data row
 * @param {boolean} [highlighted]
 * @returns {HTMLElement}
 */
function createHighScoreRow(values, extraClass, highlighted = false) {
  const row = document.createElement("div");
  row.className = ["high-scores-row", extraClass, highlighted ? "high-scores-row--current" : ""]
    .filter(Boolean)
    .join(" ");

  for (const value of values) {
    const cell = document.createElement("span");
    cell.textContent = value;
    row.appendChild(cell);
  }

  return row;
}
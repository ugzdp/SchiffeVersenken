// botController.js
//
// Plays the single-player bot's turn out through the exact same
// js/engine/actions.js functions and timing js/input.js uses for a human -
// js/engine/bot.js only decides WHAT to do; this is the WHEN/HOW, the bot's
// counterpart to js/input.js's pointer-event handling. Like input.js, this
// file is allowed to touch timers/sound/state.dragPath (UI-adjacent glue),
// unlike js/engine/ which must stay pure - see CLAUDE.md architecture.
//
// Driven entirely by a per-frame update(time) call from main.js's render
// loop (the same pattern main.js already uses for updateMenuBar() etc.)
// rather than setTimeout chains, so a mid-turn "Generate new map"/Home menu
// can't leave a stale timer waiting to fire against the next match - reset()
// (called by main.js on restart, same as js/input.js's
// cancelPendingPlacementTimer()) is all that's needed to stop a bot turn
// cleanly.

import { Phase, recordBotShotOutcome, setPhase } from "./engine/gameState.js";
import { beginPlacementConfirmation, commitPlacement, endTurn, fireShot, placeShip } from "./engine/actions.js";
import { BOT_DIFFICULTY, decideBotMove } from "./engine/bot.js";
import { PLACEMENT_CONFIRM_WINDOW_MS } from "./engine/rules.js";
import { TRAINED_BOT_THINK_MS, decideTrainedBotMove } from "./engine/trainedBot.js";
import { playHitEnemy, playHitFriendly, playPlaceShip, playShotFired, playSplash, playVictory } from "./render/audio.js";

// The bot is always player 2 (human is always player 1 in single-player
// mode - see BASE_SHIP_START in rules.js and js/input.js's pvb guard).
const BOT_OWNER = 2;

// How long the bot's placement path takes to draw itself across the screen,
// point by point, before the ship actually spawns - purely cosmetic (reuses
// the same state.dragPath the renderer already draws for a human's drag) so
// a bot's turn doesn't just teleport a new ship into place.
const PLACEMENT_ANIM_MS = 450;

// Matches js/input.js's SHOT_RESOLVE_DISPLAY_MS: how long the tracer/sinking
// animation is shown before the turn passes.
const SHOT_RESOLVE_DISPLAY_MS = 1400;

/**
 * Wire up the bot's turn-taking. Call once at match start when
 * state.mode === "pvb", alongside js/input.js's initInput().
 * @param {import("./engine/gameState.js").GameState & {dragPath?:object|null, botDifficulty?: "easy"|"medium"|"hard"|"trained"}} state
 * @param {() => void} [onTurnChanged] - same callback main.js passes to
 *   initInput(), so the menu bar/shoot button refresh after a bot action too
 * @returns {{update: (time:number) => void, reset: () => void}}
 */
export function initBotController(state, onTurnChanged) {
  // "idle" | "thinking" | "placing" | "confirming" | "shotResolve"
  let phase = "idle";
  let phaseStartTime = 0;
  let animPath = null; // full path being drawn during "placing"
  let shotOutcome = null; // {sankEnemyShip, sankOwnShip, soundPlayed, victoryAt, victoryPlayed} during "shotResolve"

  function update(time) {
    if (state.mode !== "pvb" || state.phase === Phase.GAMEOVER) {
      if (state.phase === Phase.GAMEOVER && phase === "shotResolve") runShotResolve(time); // let the winning shot's own fanfare still play out
      return;
    }

    switch (phase) {
      case "idle":
        if (state.currentPlayer === BOT_OWNER && state.phase === Phase.PLACING) {
          phase = "thinking";
          phaseStartTime = time;
        }
        return;
      case "thinking":
        runThinking(time);
        return;
      case "placing":
        runPlacing(time);
        return;
      case "confirming":
        runConfirming(time);
        return;
      case "shotResolve":
        runShotResolve(time);
        return;
    }
  }

  function runThinking(time) {
    const difficultyKey = state.botDifficulty || "medium";
    const isTrained = difficultyKey === "trained";
    const thinkMs = isTrained ? TRAINED_BOT_THINK_MS : BOT_DIFFICULTY[difficultyKey].thinkMs;
    if (time - phaseStartTime < thinkMs) return;

    const move = isTrained ? decideTrainedBotMove(state, BOT_OWNER) : decideBotMove(state, BOT_OWNER, difficultyKey);
    if (!move) {
      // No legal move at all - should not happen given the map generator's
      // playability guarantee, but don't soft-lock the match if it does.
      phase = "idle";
      return;
    }

    if (move.type === "shoot") {
      startShot(move, time);
    } else {
      animPath = move.path;
      phase = "placing";
      phaseStartTime = time;
    }
  }

  function runPlacing(time) {
    const t = Math.min(1, (time - phaseStartTime) / PLACEMENT_ANIM_MS);
    const pointCount = Math.max(1, Math.ceil(t * animPath.length));
    state.dragPath = { points: animPath.slice(0, pointCount), owner: BOT_OWNER, valid: true };
    if (t < 1) return;

    const path = animPath;
    animPath = null;
    state.dragPath = null;

    const ship = placeShip(state, BOT_OWNER, path);
    if (!ship) {
      // bot.js only ever proposes paths pre-validated against the real
      // isValidShipPlacementPath, so this shouldn't happen - fall back to
      // just ending the bot's turn rather than getting stuck.
      phase = "idle";
      return;
    }
    playPlaceShip();
    beginPlacementConfirmation(state, ship, time, false); // isTouch: false - the bot has no touch/mouse distinction
    phase = "confirming";
    phaseStartTime = time;
    if (onTurnChanged) onTurnChanged();
  }

  function runConfirming(time) {
    if (state.phase !== Phase.CONFIRMING_PLACEMENT) {
      // Already resolved from elsewhere - the human touched one of their own
      // ships to start their turn early (see js/input.js's
      // Phase.CONFIRMING_PLACEMENT branch, which works the same regardless
      // of which side's placement is pending).
      phase = "idle";
      return;
    }
    if (time - phaseStartTime < PLACEMENT_CONFIRM_WINDOW_MS) return;
    commitPlacement(state);
    phase = "idle";
    if (onTurnChanged) onTurnChanged();
  }

  function startShot(move, time) {
    playShotFired();
    const { sunkShip } = fireShot(state, move.originShip, move.direction, move.speed, time);
    // Remember whether this shot actually landed on the ship bot.js meant to
    // hit, so a repeated miss from the same ship at the same target can
    // eventually be ruled out - see js/engine/bot.js's
    // MAX_MISSES_BEFORE_AVOIDING_ORIGIN.
    if (move.target) recordBotShotOutcome(state, move.originShip.id, move.target.id, sunkShip ? sunkShip.id : null);
    if (onTurnChanged) onTurnChanged();

    phase = "shotResolve";
    phaseStartTime = time;
    shotOutcome = {
      sankEnemyShip: !!sunkShip && sunkShip.owner !== BOT_OWNER,
      sankOwnShip: !!sunkShip && sunkShip.owner === BOT_OWNER,
      soundPlayed: false,
      victoryAt: null,
      victoryPlayed: false,
    };
  }

  function runShotResolve(time) {
    const elapsed = time - phaseStartTime;

    // Impact sound plays a beat after the cannon fire, like a shell in
    // flight, matching js/input.js's own timing for a human's shot.
    if (!shotOutcome.soundPlayed && elapsed >= 160) {
      if (shotOutcome.sankEnemyShip) playHitEnemy();
      else if (shotOutcome.sankOwnShip) playHitFriendly();
      else playSplash();
      shotOutcome.soundPlayed = true;
      if (state.phase === Phase.GAMEOVER) shotOutcome.victoryAt = time + 350;
    }
    if (shotOutcome.victoryAt !== null && !shotOutcome.victoryPlayed && time >= shotOutcome.victoryAt) {
      playVictory();
      shotOutcome.victoryPlayed = true;
    }

    if (state.phase === Phase.GAMEOVER) return; // match over - nothing left to advance

    if (elapsed >= SHOT_RESOLVE_DISPLAY_MS) {
      if (!shotOutcome.sankEnemyShip) endTurn(state);
      else setPhase(state, Phase.PLACING); // sinking an enemy ship earns the bot another turn
      state.shotLine = null;
      phase = "idle";
      shotOutcome = null;
      if (onTurnChanged) onTurnChanged();
    }
  }

  /** Stop mid-turn (e.g. "Generate new map" or Home menu), so a stale in-progress bot turn can't act on the next match. */
  function reset() {
    phase = "idle";
    animPath = null;
    shotOutcome = null;
    if (state.dragPath && state.dragPath.owner === BOT_OWNER) state.dragPath = null;
  }

  return { update, reset };
}

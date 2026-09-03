// leaderboardStore.js
//
// Persists all-time match stats in the browser's localStorage, so a
// "leaderboard" survives page reloads without any server (see CLAUDE.md
// hard requirements: static files only, no backend/no build tools). This is
// browser I/O, like js/data/islandLoader.js's fetch() calls, so it lives in
// js/data/ rather than js/engine/ (which must stay DOM/browser-free) or
// js/render/ (which owns drawing, not storage).
//
// IMPORTANT CAVEAT: localStorage is per-browser, per-device. Since this is a
// hot-seat game with no player accounts, "all-time" here means "all matches
// played on this device/browser", tracked per seat (Player 1 / Player 2) -
// the same shape state.stats already uses in js/engine/gameState.js - not
// per named person. Clearing site data, or playing in a different browser or
// on a different device, starts a fresh leaderboard.

const STORAGE_KEY = "insel-schlacht:leaderboard:v1";

// Cap on how many individual match entries are kept in `history`, so
// localStorage (a few MB limit, shared with the mute setting) can't grow
// without bound over a long play history. The running `totals` below are
// unaffected by this cap - they keep every match ever recorded.
const MAX_MATCH_HISTORY = 50;

/**
 * @typedef {Object} SeatTotals
 * @property {number} gamesPlayed
 * @property {number} wins
 * @property {number} losses
 * @property {number} shots
 * @property {number} hits - shots that sank a ship, own or enemy (see CLAUDE.md friendly fire)
 */

/**
 * @typedef {Object} MatchRecord - one finished match, newest first in history
 * @property {number} timestamp - Date.now() when the match ended
 * @property {1|2} winner
 * @property {{1: {shots:number, hits:number}, 2: {shots:number, hits:number}}} stats
 */

/**
 * @typedef {Object} AttemptEntry - one finished match, from the winning
 * player's side, used for the post-game "Top Scores" screen
 * (js/render/ui.js showHighScoresScreen). Kept separate from `history` (and
 * never capped/trimmed) because ranking a match against "every game ever"
 * needs the full set, not just the recent window `history` keeps - these
 * entries are tiny (a handful of numbers each), so keeping all of them is cheap.
 * @property {number} timestamp - Date.now() when the match ended - doubles
 *   as this entry's id, so a specific match can be found again after a sort
 * @property {number} score - the winner's final computeScore() (js/engine/scoring.js) - sort key
 * @property {number} shots - the winner's shots fired
 * @property {number} hits - the winner's ships sunk (own or enemy)
 * @property {number|null} durationMs - state.matchEndTime - state.matchStartTime,
 *   or null if the match clock wasn't available for that match
 */

/**
 * @typedef {Object} VsBotRecord - the human's all-time record against one
 *   bot difficulty (js/engine/bot.js's BOT_DIFFICULTY keys), from the
 *   human's own side (they're always player 1 in single-player - see
 *   js/botController.js's BOT_OWNER)
 * @property {number} gamesPlayed
 * @property {number} wins
 * @property {number} losses
 * @property {number} shots
 * @property {number} hits
 *
 * @typedef {Object} LeaderboardData
 * @property {{1: SeatTotals, 2: SeatTotals}} totals - PvP (hot-seat) matches only
 * @property {MatchRecord[]} history - most recent MAX_MATCH_HISTORY PvP matches, newest first
 * @property {AttemptEntry[]} attempts - every PvP match's winning-side result, unordered, uncapped
 * @property {{easy: VsBotRecord, medium: VsBotRecord, hard: VsBotRecord, trained: VsBotRecord}} vsBot -
 *   single-player results, kept separate from the PvP totals/history/attempts
 *   above so a beaten easy bot and a hard-fought PvP win don't get mixed
 *   together on the "Top Scores"/leaderboard screens.
 */

/** @returns {LeaderboardData} a fresh, empty leaderboard. */
function emptyLeaderboard() {
  return {
    totals: {
      1: { gamesPlayed: 0, wins: 0, losses: 0, shots: 0, hits: 0 },
      2: { gamesPlayed: 0, wins: 0, losses: 0, shots: 0, hits: 0 },
    },
    history: [],
    attempts: [],
    vsBot: {
      easy: emptyVsBotRecord(),
      medium: emptyVsBotRecord(),
      hard: emptyVsBotRecord(),
      trained: emptyVsBotRecord(),
    },
  };
}

/** @returns {VsBotRecord} a fresh, empty single-player record for one difficulty. */
function emptyVsBotRecord() {
  return { gamesPlayed: 0, wins: 0, losses: 0, shots: 0, hits: 0 };
}

/**
 * Read the all-time leaderboard from localStorage.
 * Falls back to an empty leaderboard if nothing is stored yet, or if
 * storage is unavailable (e.g. private browsing) or holds unreadable data.
 * @returns {LeaderboardData}
 */
export function loadLeaderboard() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyLeaderboard();
    const parsed = JSON.parse(raw);
    // Guard against a corrupt or older-shape value rather than trusting it blindly.
    if (!parsed || !parsed.totals || !parsed.totals[1] || !parsed.totals[2]) return emptyLeaderboard();
    return { ...emptyLeaderboard(), ...parsed };
  } catch {
    return emptyLeaderboard();
  }
}

/**
 * Record one finished match into the all-time leaderboard. For a PvP match
 * (the default): updates both seats' totals (games played, win/loss, shots,
 * hits), prepends a capped match history entry, and adds an `attempts` entry
 * (the winner's score, shots, hits and time to win) for the "Top Scores"
 * screen. For a single-player match (`matchMeta.mode === "pvb"`): updates
 * only `vsBot[matchMeta.botDifficulty]` from the human's side (always player
 * 1 - see js/botController.js) and leaves the PvP totals/history/attempts
 * above untouched entirely, so bot results never mix into the PvP
 * leaderboard. Call exactly once per match, right when the victory screen
 * first appears (js/render/ui.js showVictoryScreen()).
 * @param {1|2} winner
 * @param {{1: {shots:number, hits:number}, 2: {shots:number, hits:number}}} matchStats - state.stats at game end
 * @param {{score:number, shots:number, hits:number, durationMs:number|null}} attempt -
 *   the winning player's final computeScore() plus shots/hits/time-to-win
 * @param {{mode?: "pvp"|"pvb", botDifficulty?: "easy"|"medium"|"hard"|"trained"|null}} [matchMeta] -
 *   defaults to a PvP match, matching every call site before single-player existed
 * @returns {{data: LeaderboardData, timestamp: number}} the updated leaderboard
 *   (already saved) plus this match's timestamp, so the caller can find its
 *   own entry again (e.g. in `attempts`) after sorting.
 */
export function recordMatchResult(winner, matchStats, attempt, matchMeta = {}) {
  const data = loadLeaderboard();
  const timestamp = Date.now();

  if (matchMeta.mode === "pvb") {
    const record = data.vsBot[matchMeta.botDifficulty] || (data.vsBot[matchMeta.botDifficulty] = emptyVsBotRecord());
    record.gamesPlayed += 1;
    if (winner === 1) record.wins += 1;
    else record.losses += 1;
    record.shots += matchStats[1].shots;
    record.hits += matchStats[1].hits;

    save(data);
    return { data, timestamp };
  }

  for (const seat of [1, 2]) {
    const totals = data.totals[seat];
    const seatStats = matchStats[seat];
    totals.gamesPlayed += 1;
    if (seat === winner) totals.wins += 1;
    else totals.losses += 1;
    totals.shots += seatStats.shots;
    totals.hits += seatStats.hits;
  }

  data.history.unshift({ timestamp, winner, stats: matchStats });
  data.history = data.history.slice(0, MAX_MATCH_HISTORY);

  data.attempts.push({ timestamp, score: attempt.score, shots: attempt.shots, hits: attempt.hits, durationMs: attempt.durationMs });

  save(data);
  return { data, timestamp };
}

/**
 * Wipe all-time stats back to zero (Settings > Leaderboard > "Reset stats").
 * @returns {LeaderboardData} the fresh, empty leaderboard (already saved)
 */
export function resetLeaderboard() {
  const data = emptyLeaderboard();
  save(data);
  return data;
}

/** Persist `data` to localStorage; silently does nothing if storage is unavailable. */
function save(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // e.g. private browsing or storage quota - the match still played fine,
    // it just won't be remembered next time.
  }
}

// audio.js
//
// Sound effects for the game, synthesized entirely with the Web Audio API -
// no audio files to fetch, matching CLAUDE.md's "no build tools, no
// dependencies" constraint. Every playXxx() function below builds a short
// tone or noise burst on the fly from oscillators/noise buffers shaped with
// a volume envelope, then throws the nodes away. This file is presentation
// layer (like effects.js) - it's called from js/input.js right after a game
// action resolves, never from js/engine/, which must stay silent and DOM-free.
//
// iOS Safari only allows an AudioContext to start/resume inside a direct
// user gesture, so unlockAudio() is called from js/input.js's pointerdown
// handler (a trusted gesture) to create/resume the context as early as
// possible, before any sound actually needs to play.

const MUTE_STORAGE_KEY = "insel-schlacht:muted";

let ctx = null;
let masterGain = null;

/** Lazily create the shared AudioContext + master gain node. Returns null if Web Audio isn't available. */
function getCtx() {
  if (ctx) return ctx;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    ctx = new AudioContextClass();
    masterGain = ctx.createGain();
    masterGain.gain.value = isMuted() ? 0 : 1;
    masterGain.connect(ctx.destination);
  } catch {
    ctx = null; // Web Audio blocked/unsupported - every playXxx() below becomes a silent no-op
  }
  return ctx;
}

/**
 * Create/resume the AudioContext. Call this from a pointerdown handler (a
 * trusted user gesture) so iOS Safari doesn't block audio the first time a
 * sound actually needs to play mid-gesture.
 * @returns {void}
 */
export function unlockAudio() {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

/** @returns {boolean} whether sound is currently muted (persisted across sessions). */
export function isMuted() {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === "1";
  } catch {
    return false; // e.g. private browsing blocking localStorage - default to sound on
  }
}

/**
 * Mute/unmute every sound. Persists the choice so it survives a reload.
 * @param {boolean} muted
 * @returns {void}
 */
export function setMuted(muted) {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // no persistent storage available - still apply the mute for this session
  }
  if (masterGain) masterGain.gain.value = muted ? 0 : 1;
}

/** Flip the current mute state. @returns {void} */
export function toggleMuted() {
  setMuted(!isMuted());
}

/**
 * Play a short tone with a percussive volume envelope.
 * @param {{freq:number, freqEnd?:number, type?:OscillatorType, duration?:number, volume?:number, attack?:number, startTime?:number}} options
 */
function tone({ freq, freqEnd, type = "sine", duration = 0.15, volume = 0.2, attack = 0.005, startTime = 0 }) {
  const audioCtx = getCtx();
  if (!audioCtx) return;

  const osc = audioCtx.createOscillator();
  osc.type = type;
  const gain = audioCtx.createGain();
  const t0 = audioCtx.currentTime + startTime;

  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);

  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(gain).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/**
 * Play a burst of filtered white noise (used for splashes, explosions, the
 * cannon shot) with a filter sweep and volume envelope.
 * @param {{duration?:number, volume?:number, filterType?:BiquadFilterType, freqStart?:number, freqEnd?:number, q?:number, startTime?:number}} options
 */
function noiseBurst({ duration = 0.3, volume = 0.3, filterType = "lowpass", freqStart = 4000, freqEnd = 300, q = 0.7, startTime = 0 }) {
  const audioCtx = getCtx();
  if (!audioCtx) return;

  const sampleCount = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
  const buffer = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type = filterType;
  filter.Q.value = q;
  const t0 = audioCtx.currentTime + startTime;
  filter.frequency.setValueAtTime(freqStart, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 40), t0 + duration);

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  source.connect(filter).connect(gain).connect(masterGain);
  source.start(t0);
  source.stop(t0 + duration + 0.02);
}

/** Light "tap" sound for any UI button/menu-item press (Settings, Rules, Restart, Sound toggle, Continue, Rematch, modal close, etc.). */
export function playClick() {
  tone({ freq: 900, type: "sine", duration: 0.035, volume: 0.1, attack: 0.001 });
  noiseBurst({ duration: 0.02, volume: 0.05, filterType: "highpass", freqStart: 3000, freqEnd: 2200, q: 1 });
}

// The looping water sound played while a ship-placement path is being
// dragged (see startDragWater/stopDragWater below). Module-level since only
// one drag can be in progress at a time - js/input.js owns start/stop calls.
let dragWaterSource = null;
let dragWaterGain = null;

/**
 * Start a soft, continuous water-ripple loop for as long as a freehand
 * placement path (CLAUDE.md Action A) is being dragged. Idempotent - calling
 * this while already playing does nothing, so js/input.js can call it once
 * on pointerdown without tracking its own "is it already running" flag.
 * @returns {void}
 */
export function startDragWater() {
  const audioCtx = getCtx();
  if (!audioCtx || dragWaterSource) return;

  // A couple of seconds of looping filtered noise reads as a steady water
  // texture rather than an audibly repeating loop.
  const loopDuration = 2;
  const sampleCount = Math.floor(audioCtx.sampleRate * loopDuration);
  const buffer = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 650;
  filter.Q.value = 0.8;

  const gain = audioCtx.createGain();
  const t0 = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.08, t0 + 0.1); // quick fade-in, avoids a click at start

  source.connect(filter).connect(gain).connect(masterGain);
  source.start(t0);

  dragWaterSource = source;
  dragWaterGain = gain;
}

/**
 * Fade out and stop the drag-water loop started by startDragWater(). Safe to
 * call even if nothing is playing (e.g. Web Audio unavailable, or the drag
 * ended without ever moving).
 * @returns {void}
 */
export function stopDragWater() {
  if (!dragWaterSource) return;
  const audioCtx = getCtx();
  const source = dragWaterSource;
  const gain = dragWaterGain;
  dragWaterSource = null;
  dragWaterGain = null;
  if (!audioCtx) return;

  const t0 = audioCtx.currentTime;
  gain.gain.cancelScheduledValues(t0);
  gain.gain.setValueAtTime(gain.gain.value, t0);
  gain.gain.linearRampToValueAtTime(0, t0 + 0.12); // quick fade-out, avoids a click at the end
  source.stop(t0 + 0.15);
}

/** A new ship legally lands on open water (CLAUDE.md Action A step 4). */
export function playPlaceShip() {
  tone({ freq: 520, freqEnd: 200, type: "sine", duration: 0.14, volume: 0.22, attack: 0.004 });
  noiseBurst({ duration: 0.08, volume: 0.08, filterType: "lowpass", freqStart: 1200, freqEnd: 300 });
}

/** A drag path is rejected on release - crossed land or ended on a ship/land (Action A step 3). */
export function playPlacementRejected() {
  tone({ freq: 260, type: "square", duration: 0.09, volume: 0.14 });
  tone({ freq: 180, type: "square", duration: 0.12, volume: 0.14, startTime: 0.1 });
}

/** The cannon firing, played the instant a blind shot resolves (Action B step 5). */
export function playShotFired() {
  tone({ freq: 130, freqEnd: 40, type: "triangle", duration: 0.22, volume: 0.32, attack: 0.002 });
  noiseBurst({ duration: 0.2, volume: 0.28, filterType: "lowpass", freqStart: 3500, freqEnd: 250 });
}

/** A shot lands in open water without hitting anything. */
export function playSplash() {
  noiseBurst({ duration: 0.35, volume: 0.22, filterType: "bandpass", freqStart: 900, freqEnd: 250, q: 1.2 });
}

/** A shot sinks an enemy ship (Action B step 6). */
export function playHitEnemy() {
  noiseBurst({ duration: 0.45, volume: 0.35, filterType: "lowpass", freqStart: 4500, freqEnd: 200 });
  tone({ freq: 90, freqEnd: 30, type: "sine", duration: 0.4, volume: 0.4, attack: 0.002 });
}

/** A shot sinks one of the shooter's own ships (friendly fire). Duller/lower than a normal hit. */
export function playHitFriendly() {
  noiseBurst({ duration: 0.4, volume: 0.3, filterType: "lowpass", freqStart: 2200, freqEnd: 150 });
  tone({ freq: 70, freqEnd: 25, type: "sawtooth", duration: 0.35, volume: 0.28, attack: 0.002 });
  tone({ freq: 185, type: "triangle", duration: 0.18, volume: 0.1, startTime: 0.05 }); // sour little "oops" note
}

/**
 * Pressing the Shoot button to arm shoot mode (Action B step 1) - a
 * mechanical "cha-chunk" like racking a rifle bolt/pump-action shotgun: a
 * quick metallic click (the bolt sliding back) followed a beat later by a
 * heavier click+thud (it slamming forward and locking).
 */
export function playGunCock() {
  noiseBurst({ duration: 0.035, volume: 0.22, filterType: "highpass", freqStart: 2500, freqEnd: 1500, q: 1.5 });
  tone({ freq: 1400, type: "square", duration: 0.02, volume: 0.08, attack: 0.001 });

  noiseBurst({ duration: 0.05, volume: 0.3, filterType: "highpass", freqStart: 2000, freqEnd: 900, q: 1.3, startTime: 0.09 });
  tone({ freq: 140, type: "sine", duration: 0.06, volume: 0.22, attack: 0.001, startTime: 0.09 });
}

/** The blind-shot swipe was too slow or barely moved (Action B step 3). */
export function playTooSlow() {
  tone({ freq: 200, type: "square", duration: 0.08, volume: 0.14 });
  tone({ freq: 200, type: "square", duration: 0.08, volume: 0.14, startTime: 0.1 });
}

/** The "undo" cross was tapped to revert a just-placed ship. */
export function playUndo() {
  tone({ freq: 300, freqEnd: 500, type: "sine", duration: 0.09, volume: 0.16, attack: 0.002 });
}

/** A base ship has sunk - match over. Short ascending fanfare. */
export function playVictory() {
  const notes = [523.25, 659.25, 784.0, 1046.5]; // C5 E5 G5 C6
  notes.forEach((freq, i) => {
    tone({ freq, type: "triangle", duration: 0.18, volume: 0.25, attack: 0.004, startTime: i * 0.14 });
  });
}

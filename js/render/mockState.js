// mockState.js
//
// Hardcoded example state for previewing renderer.js/effects.js
// standalone, before js/data/islandLoader.js, js/engine/mapGenerator.js
// and js/engine/actions.js exist to produce a real one. Shape matches
// js/engine/gameState.js's GameState, plus the optional dragPath /
// shotLine / sinkingShips fields renderer.js and effects.js read (see
// their JSDoc) - fields actions.js/input.js will start populating on the
// real state once they're built.
//
// TEST FLAG: this file is only ever imported by js/render/previewMain.js
// (loaded from js/render/preview.html). It is never imported by the real
// js/main.js and has no effect on the actual game.

export const mockIslandLibrary = [
  {
    id: "base_west",
    type: "base",
    landShape: [
      [0.5, 0.0], [0.85, 0.15], [1.0, 0.5], [0.85, 0.85],
      [0.5, 1.0], [0.15, 0.85], [0.0, 0.5], [0.15, 0.15],
    ],
    mountainShapes: [
      [[0.55, 0.55], [0.75, 0.5], [0.8, 0.7], [0.6, 0.78]],
    ],
    decorations: [{ kind: "palm", x: 0.3, y: 0.3 }],
    baseAnchor: { x: 0.25, y: 0.6 },
  },
  {
    id: "base_east",
    type: "base",
    landShape: [
      [0.5, 0.0], [0.85, 0.15], [1.0, 0.5], [0.85, 0.85],
      [0.5, 1.0], [0.15, 0.85], [0.0, 0.5], [0.15, 0.15],
    ],
    mountainShapes: [
      [[0.4, 0.5], [0.25, 0.55], [0.2, 0.75], [0.45, 0.78]],
    ],
    decorations: [{ kind: "palm", x: 0.7, y: 0.3 }],
    baseAnchor: { x: 0.75, y: 0.6 },
  },
  {
    // Real shape from data/islands/island_beach_round.json, copied here so
    // the preview can show the actual authored island instead of a
    // placeholder (see TEST FLAG note above - this file never fetches).
    id: "island_beach_round",
    type: "normal",
    landShape: [
      [0.8868, 0.4822], [0.7604, 0.6621], [0.6667, 0.7884], [0.4928, 0.8792],
      [0.3744, 0.7456], [0.2067, 0.6532], [0.2279, 0.491], [0.1782, 0.3171],
      [0.288, 0.1601], [0.5139, 0.2242], [0.6547, 0.1909], [0.789, 0.3538],
    ],
    mountainShapes: [],
    decorations: [
      { kind: "palm", x: 0.5, y: 0.45 },
      { kind: "palm", x: 0.42, y: 0.6 },
    ],
  },
  {
    id: "island_mountain_ring",
    type: "normal",
    landShape: [
      [0.5, 0.0], [1.0, 0.5], [0.5, 1.0], [0.0, 0.5],
    ],
    mountainShapes: [
      [[0.5, 0.2], [0.8, 0.5], [0.5, 0.8], [0.2, 0.5]],
    ],
    decorations: [],
  },
];

export const mockMap = {
  seed: 42,
  islands: [
    { islandId: "base_west", x: 0.12, y: 0.5, scale: 1.4, rotation: 0 },
    { islandId: "base_east", x: 0.88, y: 0.5, scale: 1.4, rotation: 0 },
    { islandId: "island_beach_round", x: 0.5, y: 0.5, scale: 0.9, rotation: 0.4 },
    { islandId: "island_mountain_ring", x: 0.58, y: 0.7, scale: 1.1, rotation: 0.9 },
  ],
};

export const mockShips = [
  { id: "p1-base", owner: 1, x: 0.16, y: 0.53, isBase: true },
  { id: "p1-scout-1", owner: 1, x: 0.28, y: 0.4, isBase: false },
  { id: "p1-scout-2", owner: 1, x: 0.35, y: 0.62, isBase: false },
  { id: "p2-base", owner: 2, x: 0.84, y: 0.53, isBase: true },
  { id: "p2-scout-1", owner: 2, x: 0.72, y: 0.45, isBase: false },
];

/** Example in-progress freehand drag path for Action A (see CLAUDE.md), curving around the mountain ring's corner. */
export const mockDragPath = {
  points: [
    { x: 0.35, y: 0.62 },
    { x: 0.4, y: 0.66 },
    { x: 0.46, y: 0.64 },
    { x: 0.47, y: 0.58 },
  ],
  owner: 1,
};

/**
 * Example resolved shot line for Action B. startTime is stamped relative
 * to "now" so the fade-out effect is visible right from the preview's
 * first frame instead of already-expired.
 */
function makeMockShotLine(now) {
  return { fromX: 0.72, fromY: 0.45, toX: 0.4, toY: 0.5, owner: 2, startTime: now };
}

/** Example sinking ship, mid-animation from the moment the preview starts. */
function makeMockSinkingShips(now) {
  return [{ x: 0.4, y: 0.5, owner: 1, isBase: false, startTime: now }];
}

/**
 * Build a full mock GameState for previewMain.js. Pass the render loop's
 * current timestamp so the time-based effects (shot line fade, sinking
 * animation) start in sync with the preview's first frame.
 * @param {number} [now] - ms timestamp, e.g. from performance.now()
 */
export function createMockState(now = 0) {
  return {
    map: mockMap,
    islands: mockIslandLibrary,
    ships: mockShips,
    currentPlayer: 1,
    phase: "placing",
    dragPath: mockDragPath,
    shotLine: makeMockShotLine(now),
    sinkingShips: makeMockSinkingShips(now),
  };
}
// tests.js
//
// Minimal smoke tests for rules.js and mapGenerator.js, using hand-written
// mock island data (no fetch, no data/islands/*.json). Run with:
//
//   node js/engine/tests.js
//
// (js/engine/package.json marks this folder as ES modules so plain `node`
// can load the `import`/`export` syntax shared with the browser build.)

import {
  pointInPolygon,
  segmentsIntersect,
  linePolygonIntersects,
  lineCircleIntersects,
  rayCircleEntryDistance,
  rayPolygonHitDistance,
  resolveShot,
  transformIslandPolygon,
  getIslandWorldShapes,
  getPolygonBoundingRadius,
  swipeSpeedToDistance,
  MIN_SHOT_DISTANCE,
  MAX_SHOT_DISTANCE,
  SHIP_HITBOX_RADIUS,
  shipHitRadius,
  tryExtendDragPath,
  isValidShipPlacementPath,
} from "./rules.js";
import { generateMap, createSeededRandom } from "./mapGenerator.js";

// ---------------------------------------------------------------------------
// Tiny assert helper
// ---------------------------------------------------------------------------

let failures = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ok - ${message}`);
  } else {
    failures++;
    console.log(`  FAIL - ${message}`);
  }
}

function approxEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon;
}

// ---------------------------------------------------------------------------
// Mock island library
// ---------------------------------------------------------------------------

/** A base island: a square with a bay cut into its right edge. */
const mockBaseIsland = {
  id: "base_01",
  type: "base",
  landShape: [
    [0.0, 0.0],
    [1.0, 0.0],
    [1.0, 0.4],
    [0.6, 0.5],
    [1.0, 0.6],
    [1.0, 1.0],
    [0.0, 1.0],
  ],
  mountainShapes: [],
  decorations: [],
  baseAnchor: { x: 0.75, y: 0.5 },
};

/** A normal island: a square with a mountain core. */
const mockNormalIslandA = {
  id: "island_a",
  type: "normal",
  landShape: [
    [0.0, 0.0],
    [1.0, 0.0],
    [1.0, 1.0],
    [0.0, 1.0],
  ],
  mountainShapes: [
    [
      [0.3, 0.3],
      [0.7, 0.3],
      [0.7, 0.7],
      [0.3, 0.7],
    ],
  ],
  decorations: [{ kind: "palm", x: 0.5, y: 0.2 }],
};

/** A normal island: beach-only diamond, no mountain. */
const mockNormalIslandB = {
  id: "island_b",
  type: "normal",
  landShape: [
    [0.5, 0.0],
    [1.0, 0.5],
    [0.5, 1.0],
    [0.0, 0.5],
  ],
  mountainShapes: [],
  decorations: [],
};

const mockLibrary = [mockBaseIsland, mockNormalIslandA, mockNormalIslandB];

// ---------------------------------------------------------------------------
// pointInPolygon
// ---------------------------------------------------------------------------

console.log("pointInPolygon");
{
  const unitSquare = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  assert(pointInPolygon([0.5, 0.5], unitSquare) === true, "center of square is inside");
  assert(pointInPolygon([1.5, 0.5], unitSquare) === false, "point to the right is outside");
  assert(pointInPolygon([-0.1, -0.1], unitSquare) === false, "point outside top-left is outside");
}

// ---------------------------------------------------------------------------
// segmentsIntersect
// ---------------------------------------------------------------------------

console.log("segmentsIntersect");
{
  assert(
    segmentsIntersect([0, 0], [1, 1], [0, 1], [1, 0]) === true,
    "crossing diagonals intersect"
  );
  assert(
    segmentsIntersect([0, 0], [1, 0], [0, 1], [1, 1]) === false,
    "parallel non-touching segments do not intersect"
  );
  assert(
    segmentsIntersect([0, 0], [1, 0], [1, 0], [2, 0]) === true,
    "segments touching at a shared endpoint intersect"
  );
}

// ---------------------------------------------------------------------------
// linePolygonIntersects
// ---------------------------------------------------------------------------

console.log("linePolygonIntersects");
{
  const unitSquare = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  assert(
    linePolygonIntersects([-0.5, 0.5], [1.5, 0.5], unitSquare) === true,
    "line crossing straight through the square intersects"
  );
  assert(
    linePolygonIntersects([-1, -1], [-0.5, -0.5], unitSquare) === false,
    "line entirely outside the square does not intersect"
  );
  assert(
    linePolygonIntersects([0.5, 0.5], [2, 2], unitSquare) === true,
    "line starting inside the square intersects, even though it only crosses one edge"
  );
}

// ---------------------------------------------------------------------------
// lineCircleIntersects (ship hitboxes)
// ---------------------------------------------------------------------------

console.log("lineCircleIntersects");
{
  assert(
    lineCircleIntersects([0, 0.5], [1, 0.5], [0.5, 0.5], 0.1) === true,
    "line passing through the circle's center hits"
  );
  assert(
    lineCircleIntersects([0, 0], [1, 0], [0.5, 0.5], 0.1) === false,
    "line passing well above the circle misses"
  );
  assert(
    lineCircleIntersects([0, 0.5], [1, 0.5], [0.5, 0.6], 0.1) === true,
    "line grazing the edge of the circle counts as a hit"
  );
}

// ---------------------------------------------------------------------------
// transformIslandPolygon / getIslandWorldShapes
// ---------------------------------------------------------------------------

console.log("transformIslandPolygon");
{
  const localSquare = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const placement = { x: 0.5, y: 0.5, scale: 0.2, rotation: 0 };
  const world = transformIslandPolygon(localSquare, placement);
  // Local (1, 0.5) is the square's right-middle edge point, 0.5 away from
  // its own center (0.5, 0.5) along x. Scaled by 0.2 and placed at (0.5,0.5)
  // it should land at x = 0.5 + 0.5*0.2 = 0.6, y = 0.5.
  const rightMid = transformIslandPolygon([[1, 0.5]], placement)[0];
  assert(approxEqual(rightMid[0], 0.6), "scale+translate places local right-mid point at x=0.6");
  assert(approxEqual(rightMid[1], 0.5), "scale+translate keeps local right-mid point at y=0.5");
  assert(world.length === 4, "transformed polygon keeps the same point count");

  const rotated = transformIslandPolygon([[1, 0.5]], { x: 0, y: 0, scale: 1, rotation: Math.PI / 2 });
  assert(approxEqual(rotated[0][0], 0, 1e-9), "90deg rotation of right-mid point lands near x=0");
  assert(approxEqual(rotated[0][1], 0.5, 1e-9), "90deg rotation of right-mid point lands near y=0.5");

  const worldShapes = getIslandWorldShapes(mockNormalIslandA, placement);
  assert(worldShapes.landShape.length === 4, "getIslandWorldShapes transforms the land shape");
  assert(
    worldShapes.mountainShapes.length === 1,
    "getIslandWorldShapes transforms every mountain shape"
  );

  const radius = getPolygonBoundingRadius(mockNormalIslandA.landShape);
  assert(approxEqual(radius, Math.hypot(0.5, 0.5)), "bounding radius of a unit square is its half-diagonal");
}

// ---------------------------------------------------------------------------
// rayCircleEntryDistance / rayPolygonHitDistance (blind shot geometry)
// ---------------------------------------------------------------------------

console.log("rayCircleEntryDistance");
{
  assert(
    approxEqual(rayCircleEntryDistance([0, 0.5], [1, 0], [0.5, 0.5], 0.1), 0.4),
    "ray hits the near edge of a circle straight ahead"
  );
  assert(
    rayCircleEntryDistance([0, 0], [1, 0], [0.5, 0.5], 0.1) === null,
    "ray passing well clear of the circle never enters it"
  );
  assert(
    rayCircleEntryDistance([0.5, 0.5], [1, 0], [0.5, 0.5], 0.1) === 0,
    "ray starting inside the circle enters at distance 0"
  );
}

console.log("rayPolygonHitDistance");
{
  const unitSquare = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  assert(
    approxEqual(rayPolygonHitDistance([-0.5, 0.5], [1, 0], 5, unitSquare), 0.5),
    "ray hits the near edge of a square straight ahead"
  );
  assert(
    rayPolygonHitDistance([-0.5, -0.5], [-1, 0], 5, unitSquare) === null,
    "ray pointing away from the square never hits it"
  );
  assert(
    rayPolygonHitDistance([-0.5, 0.5], [1, 0], 0.2, unitSquare) === null,
    "ray too short to reach the square never hits it"
  );
}

// ---------------------------------------------------------------------------
// resolveShot (blind shot resolution: mountains and ships both stop it)
// ---------------------------------------------------------------------------

console.log("resolveShot");
{
  const noMountains = [];
  const mountainAhead = [
    [
      [0.4, 0.4],
      [0.6, 0.4],
      [0.6, 0.6],
      [0.4, 0.6],
    ],
  ];

  {
    const { endpoint, hitShip } = resolveShot([0, 0.5], [1, 0], 0.9, noMountains, []);
    assert(approxEqual(endpoint[0], 0.9) && approxEqual(endpoint[1], 0.5), "no obstacles: shot travels its full max distance");
    assert(hitShip === null, "no obstacles: nothing sinks");
  }

  {
    const { endpoint, hitShip } = resolveShot([0, 0.5], [1, 0], 0.9, mountainAhead, []);
    assert(approxEqual(endpoint[0], 0.4) && approxEqual(endpoint[1], 0.5), "mountain in the way clips the shot at its near edge");
    assert(hitShip === null, "clipped by a mountain: nothing sinks");
  }

  {
    const ship = { id: "target", owner: 2, x: 0.5, y: 0.5, isBase: false };
    const { endpoint, hitShip } = resolveShot([0, 0.5], [1, 0], 0.9, noMountains, [ship]);
    assert(hitShip && hitShip.id === "target", "ship on the line sinks");
    assert(approxEqual(endpoint[0], 0.5 - shipHitRadius(ship)) && approxEqual(endpoint[1], 0.5), "shot stops at the near edge of the hit ship's hitbox");
  }

  {
    // The hull drawn in renderer.js is a pointed shape, not a perfect circle,
    // so its hitbox is enlarged beyond SHIP_HITBOX_RADIUS to cover the full
    // silhouette (see HULL_SILHOUETTE_FACTOR in rules.js) - a shot that would
    // miss the bare core but clips that wider margin must still sink the ship.
    const ship = { id: "corner", owner: 2, x: 0.5, y: 0.5 + SHIP_HITBOX_RADIUS * 1.15, isBase: false };
    const { hitShip } = resolveShot([0, 0.5], [1, 0], 0.9, noMountains, [ship]);
    assert(hitShip && hitShip.id === "corner", "a shot clipping just the hull's enlarged silhouette still sinks the ship");
  }

  {
    // Base ships are drawn bigger (BASE_SHIP_RADIUS_FACTOR in theme.js) and
    // must have a correspondingly bigger hitbox, sensitive across that whole
    // larger size the same way a normal ship's is.
    const baseShip = { id: "base", owner: 2, x: 0.5, y: 0.5 + SHIP_HITBOX_RADIUS * 1.5, isBase: true };
    const { hitShip } = resolveShot([0, 0.5], [1, 0], 0.9, noMountains, [baseShip]);
    assert(hitShip && hitShip.id === "base", "a shot passing that far from a normal ship's center still hits the larger base ship's hitbox");
  }

  {
    // Two ships on the same line: only the nearer one should be hit - a
    // single shot sinks at most one ship (CLAUDE.md open decision, resolved
    // as "stops at first hit").
    const nearShip = { id: "near", owner: 2, x: 0.3, y: 0.5, isBase: false };
    const farShip = { id: "far", owner: 2, x: 0.7, y: 0.5, isBase: false };
    const { hitShip } = resolveShot([0, 0.5], [1, 0], 0.9, noMountains, [nearShip, farShip]);
    assert(hitShip.id === "near", "of two ships on the line, only the nearer one is hit");
  }

  {
    // Friendly fire: the shooter's fleet is not filtered out by resolveShot
    // itself - that's fireShot()'s job in actions.js, but resolveShot must
    // still be willing to hit any ship it's given regardless of owner.
    const ownShip = { id: "own", owner: 1, x: 0.5, y: 0.5, isBase: false };
    const { hitShip } = resolveShot([0, 0.5], [1, 0], 0.9, noMountains, [ownShip]);
    assert(hitShip.id === "own", "resolveShot hits ships regardless of owner (friendly fire allowed)");
  }
}

// ---------------------------------------------------------------------------
// swipeSpeedToDistance
// ---------------------------------------------------------------------------

console.log("swipeSpeedToDistance");
{
  assert(
    swipeSpeedToDistance(0) === MIN_SHOT_DISTANCE,
    "speed below the min cap clamps to MIN_SHOT_DISTANCE"
  );
  assert(
    swipeSpeedToDistance(100) === MAX_SHOT_DISTANCE,
    "speed above the max cap clamps to MAX_SHOT_DISTANCE"
  );
  const mid = swipeSpeedToDistance(1.6); // midpoint of [0.2, 3.0]
  assert(
    mid > MIN_SHOT_DISTANCE && mid < MAX_SHOT_DISTANCE,
    "mid-range speed maps to a distance strictly between the caps"
  );
}

// ---------------------------------------------------------------------------
// tryExtendDragPath / isValidShipPlacementPath (freehand drag-path placement)
// ---------------------------------------------------------------------------

console.log("tryExtendDragPath");
{
  {
    const path = [{ x: 0, y: 0.5 }];
    const result = tryExtendDragPath(path, { x: 0.1, y: 0.5 }, { x: 0, y: 500 }, { x: 100, y: 500 }, 0, 1000);
    assert(result.extended === true, "a short segment extends the path");
    assert(result.path.length === 2, "the extended path gains one point");
    assert(approxEqual(result.lengthPx, 100), "the running pixel length grows by the new segment's length");
  }

  {
    // Budget already spent: even a tiny segment is dropped.
    const path = [{ x: 0, y: 0.5 }];
    const result = tryExtendDragPath(path, { x: 0.01, y: 0.5 }, { x: 0, y: 500 }, { x: 10, y: 500 }, 100, 100);
    assert(result.extended === false, "a path already at its length budget is frozen");
    assert(result.path === path, "a frozen path is returned unchanged (same reference)");
  }

  {
    // Segment would overshoot the remaining budget: clip to land exactly on the cap.
    const path = [{ x: 0, y: 0.5 }];
    const result = tryExtendDragPath(path, { x: 0.2, y: 0.5 }, { x: 0, y: 500 }, { x: 200, y: 500 }, 0, 50);
    assert(result.extended === true, "an over-budget segment still extends the path, clipped");
    assert(approxEqual(result.lengthPx, 50), "a clipped segment lands the path exactly on maxLengthPx");
    assert(approxEqual(result.path[1].x, 0.05), "the clipped point is scaled back proportionally in relative coords too");
  }

  {
    // A segment cutting through an island's land shape still extends the
    // path (it's no longer blocked at the coastline) - it's up to
    // isValidShipPlacementPath to flag the path invalid so the renderer
    // shows it red and the eventual placeShip() refuses to spawn a ship.
    const path = [{ x: 0.3, y: 0.5 }];
    const result = tryExtendDragPath(path, { x: 0.7, y: 0.5 }, { x: 300, y: 500 }, { x: 700, y: 500 }, 0, 1000);
    assert(result.extended === true, "a segment cutting through land still extends the path");
    assert(result.path.length === 2, "the path gains the point even though it crosses land");
  }
}

console.log("isValidShipPlacementPath");
{
  const unitSquareIsland = [
    {
      landShape: [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
        [0.4, 0.6],
      ],
    },
  ];

  assert(
    isValidShipPlacementPath(
      [{ x: 0, y: 0.5 }, { x: 0.2, y: 0.5 }],
      unitSquareIsland,
      []
    ) === true,
    "a path that never approaches the island or another ship is valid"
  );
  assert(
    isValidShipPlacementPath(
      [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }],
      unitSquareIsland,
      []
    ) === false,
    "a path with any segment crossing land is invalid, even if only one segment does"
  );
  assert(
    isValidShipPlacementPath(
      [{ x: 0, y: 0.5 }, { x: 0.1, y: 0.5 }],
      [],
      [{ x: 0.1, y: 0.5 }]
    ) === false,
    "a path whose endpoint lands on top of another ship is invalid"
  );
}

// ---------------------------------------------------------------------------
// createSeededRandom
// ---------------------------------------------------------------------------

console.log("createSeededRandom");
{
  const rngA = createSeededRandom(42);
  const rngB = createSeededRandom(42);
  const sequenceA = [rngA(), rngA(), rngA()];
  const sequenceB = [rngB(), rngB(), rngB()];
  assert(
    JSON.stringify(sequenceA) === JSON.stringify(sequenceB),
    "same seed produces the same sequence of draws"
  );
  assert(
    sequenceA.every((v) => v >= 0 && v < 1),
    "all draws land in [0, 1)"
  );
}

// ---------------------------------------------------------------------------
// generateMap
// ---------------------------------------------------------------------------

console.log("generateMap");
{
  const mapA = generateMap(mockLibrary, 42);
  const mapB = generateMap(mockLibrary, 42);
  const mapC = generateMap(mockLibrary, 43);

  assert(mapA.seed === 42, "generated map records the seed it was built with");
  assert(
    JSON.stringify(mapA) === JSON.stringify(mapB),
    "same seed reproduces an identical map"
  );
  assert(
    JSON.stringify(mapA) !== JSON.stringify(mapC),
    "different seeds produce different maps"
  );
  assert(mapA.islands.length >= 2, "generated map has at least the two base islands");

  const [firstIsland, secondIsland] = mapA.islands;
  assert(firstIsland.islandId === mockBaseIsland.id, "first placed island is a base shape");
  assert(secondIsland.islandId === mockBaseIsland.id, "second placed island is a base shape");
  assert(firstIsland.x < 0.5, "player 1 base sits in the left half of the map");
  assert(secondIsland.x > 0.5, "player 2 base sits in the right half of the map");

  // Every pair of placed islands should keep at least MIN_ISLAND_DISTANCE of
  // open water between their (approximate, circle-based) edges.
  let allSeparated = true;
  for (let i = 0; i < mapA.islands.length; i++) {
    for (let j = i + 1; j < mapA.islands.length; j++) {
      const a = mapA.islands[i];
      const b = mapA.islands[j];
      const entryA = mockLibrary.find((e) => e.id === a.islandId);
      const entryB = mockLibrary.find((e) => e.id === b.islandId);
      const radiusA = getPolygonBoundingRadius(entryA.landShape) * a.scale;
      const radiusB = getPolygonBoundingRadius(entryB.landShape) * b.scale;
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - radiusA - radiusB;
      if (gap < 0) allSeparated = false;
    }
  }
  assert(allSeparated, "no two placed islands' bounding circles overlap");

  console.log(`  (generated ${mapA.islands.length} islands for seed 42)`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll assertions passed.");
}

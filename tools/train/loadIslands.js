// loadIslands.js
//
// Node-only equivalent of js/data/islandLoader.js: reads data/islands/*.json
// straight off disk (fs, no fetch, no browser) for the offline training
// simulation. Trusts the shipped files as-is - no schema validation, since
// these are the exact same files the real game already loads and validates
// via js/data/islandLoader.js.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ISLANDS_DIR = join(__dirname, "..", "..", "data", "islands");

/**
 * Load the whole island shape library (data/islands/index.json plus every
 * island file it lists), the same set of shapes real matches are built
 * from.
 * @returns {Array<import("../../js/engine/gameState.js").IslandLibraryEntry>}
 */
export function loadIslandLibrary() {
  const index = JSON.parse(readFileSync(join(ISLANDS_DIR, "index.json"), "utf8"));
  return index.islands.map((filename) => JSON.parse(readFileSync(join(ISLANDS_DIR, filename), "utf8")));
}

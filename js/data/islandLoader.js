// islandLoader.js
//
// Loads the static island shape library from data/islands/*.json (see
// data/schema.md for the authoritative field-by-field format). Fetches the
// index file first, then every island file it lists, validates each one
// against the schema, and returns the array of valid entries. Invalid files
// are logged with a clear error and skipped rather than aborting the whole
// load, so one bad file doesn't take down the game.
//
// This module only reads data — it never touches js/engine/ or js/render/.
// Whatever calls loadIslandLibrary() is responsible for handing the result
// to js/engine/gameState.js's setIslandLibrary().

const DEFAULT_BASE_PATH = "data/islands/";
const VALID_TYPES = ["normal", "base"];

/**
 * Check that a value is a finite number.
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Check that a value is a valid relative coordinate, per the schema's
 * "0-1 in the island's own local space" convention.
 * @param {*} value
 * @returns {boolean}
 */
function isRelativeCoord(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/**
 * Validate a single [x, y] point.
 * @param {*} point
 * @param {string} label - human-readable label for error messages
 * @param {string[]} errors - array to push error messages onto
 */
function validatePoint(point, label, errors) {
  if (!Array.isArray(point) || point.length !== 2) {
    errors.push(`${label} must be a [x, y] pair, got ${JSON.stringify(point)}`);
    return;
  }
  const [x, y] = point;
  if (!isRelativeCoord(x) || !isRelativeCoord(y)) {
    errors.push(`${label} must have x and y in range 0-1, got [${x}, ${y}]`);
  }
}

/**
 * Validate a polygon: an array of at least 3 [x, y] points.
 * @param {*} polygon
 * @param {string} label
 * @param {string[]} errors
 */
function validatePolygon(polygon, label, errors) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    errors.push(`${label} must be an array of at least 3 points`);
    return;
  }
  polygon.forEach((point, i) => validatePoint(point, `${label}[${i}]`, errors));
}

/**
 * Validate one island shape entry against the schema documented in
 * data/schema.md. Returns a list of human-readable error strings; an empty
 * list means the entry is valid.
 * @param {*} entry - parsed JSON of one island file
 * @returns {string[]}
 */
export function validateIslandShape(entry) {
  const errors = [];

  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return ["island file must contain a single JSON object"];
  }

  if (typeof entry.id !== "string" || entry.id.length === 0) {
    errors.push(`"id" must be a non-empty string`);
  }

  if (!VALID_TYPES.includes(entry.type)) {
    errors.push(`"type" must be one of ${JSON.stringify(VALID_TYPES)}, got ${JSON.stringify(entry.type)}`);
  }

  if (entry.landShape === undefined) {
    errors.push(`"landShape" is required`);
  } else {
    validatePolygon(entry.landShape, "landShape", errors);
  }

  if (entry.mountainShapes !== undefined) {
    if (!Array.isArray(entry.mountainShapes)) {
      errors.push(`"mountainShapes" must be an array of polygons`);
    } else {
      entry.mountainShapes.forEach((polygon, i) =>
        validatePolygon(polygon, `mountainShapes[${i}]`, errors)
      );
    }
  }

  if (entry.decorations !== undefined) {
    if (!Array.isArray(entry.decorations)) {
      errors.push(`"decorations" must be an array`);
    } else {
      entry.decorations.forEach((deco, i) => {
        if (typeof deco !== "object" || deco === null) {
          errors.push(`decorations[${i}] must be an object`);
          return;
        }
        if (typeof deco.kind !== "string" || deco.kind.length === 0) {
          errors.push(`decorations[${i}].kind must be a non-empty string`);
        }
        if (!isRelativeCoord(deco.x) || !isRelativeCoord(deco.y)) {
          errors.push(`decorations[${i}] must have x and y in range 0-1`);
        }
      });
    }
  }

  if (entry.type === "base") {
    if (typeof entry.baseAnchor !== "object" || entry.baseAnchor === null) {
      errors.push(`"baseAnchor" is required when type is "base"`);
    } else if (!isRelativeCoord(entry.baseAnchor.x) || !isRelativeCoord(entry.baseAnchor.y)) {
      errors.push(`"baseAnchor" must have x and y in range 0-1`);
    }
  }

  return errors;
}

/**
 * Fetch and parse a single JSON file.
 * @param {string} url
 * @returns {Promise<*>}
 */
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Load the whole island shape library: fetch data/islands/index.json, then
 * every island file it lists, validating each one against the schema.
 * Invalid or unreadable files are logged with console.error and skipped —
 * they do not stop the rest of the library from loading.
 * @param {string} [basePath] - folder containing index.json and the island files
 * @returns {Promise<Array>} the array of valid island shape entries
 */
export async function loadIslandLibrary(basePath = DEFAULT_BASE_PATH) {
  let index;
  try {
    index = await fetchJson(`${basePath}index.json`);
  } catch (err) {
    console.error(`islandLoader: failed to load ${basePath}index.json: ${err.message}`);
    return [];
  }

  if (!index || !Array.isArray(index.islands)) {
    console.error(`islandLoader: ${basePath}index.json must have an "islands" array of filenames`);
    return [];
  }

  const library = [];
  const seenIds = new Set();

  for (const filename of index.islands) {
    const url = `${basePath}${filename}`;
    let entry;
    try {
      entry = await fetchJson(url);
    } catch (err) {
      console.error(`islandLoader: failed to load ${url}: ${err.message}`);
      continue;
    }

    const errors = validateIslandShape(entry);
    if (errors.length > 0) {
      console.error(`islandLoader: ${url} is invalid, skipping:\n  - ${errors.join("\n  - ")}`);
      continue;
    }

    if (seenIds.has(entry.id)) {
      console.error(`islandLoader: ${url} has duplicate id "${entry.id}", skipping`);
      continue;
    }
    seenIds.add(entry.id);

    library.push(entry);
  }

  return library;
}
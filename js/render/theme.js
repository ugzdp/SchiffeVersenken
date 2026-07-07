// theme.js
//
// Shared Boom-Beach-style palette so renderer.js and effects.js agree on
// what "player 1" and "player 2" look like, and how big a ship is.

export const PLAYER_COLORS = {
  1: { hull: "#2f7ed8", outline: "#173a63" },
  2: { hull: "#8e3fd8", outline: "#3f1a63" },
};

export const SHIP_RADIUS_FACTOR = 0.016; // * unit (see coords.js getUnit) - normal ship
export const BASE_SHIP_RADIUS_FACTOR = 0.026; // * unit - base ship, drawn bigger

export function colorsForOwner(owner) {
  return PLAYER_COLORS[owner] || PLAYER_COLORS[1];
}
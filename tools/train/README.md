# Bot training simulation

Offline-only tooling (never referenced by `index.html`, never ships to
GitHub Pages) that evolves the weights of a single "smart bot" decision
policy via self-play. See the chat this was scoped from for the full
reasoning; short version below.

## Run it

```
node tools/train/evolve.js
```

No npm install needed - zero dependencies, plain Node ES modules (same
pattern as `js/engine/tests.js`). Prints one line per generation and, at
the end, writes the best genome found to `tools/train/best-genome.json`.

Lower `POPULATION_SIZE`/`GENERATIONS` at the top of `evolve.js` for a quick
smoke-test run first; raise them for a real search once you've confirmed it
runs on your machine.

## What's fixed vs. what's learned

- **Fixed**: shooting accuracy (`AIM_ERROR_DEG`/`DISTANCE_ERROR_FACTOR` in
  `policy.js`, copied from `js/engine/bot.js`'s `medium` preset) and all the
  geometry (hit-probability model, path legality, A* water routing) -
  reused directly from `js/engine/bot.js` rather than duplicated.
- **Removed entirely**: the shipped bot's difficulty presets (easy/hard) and
  every hand-picked strategy threshold (`OPPORTUNISTIC_SHOT_PROB`,
  `THREAT_WEIGHT_IN_SHOT_SCORE`, `SAFE_ADVANCE_MAX_THREAT`, the P0-P4
  priority cascade, etc.). `policy.js` replaces all of it with one unified
  scoring pass: every legal shot and placement this turn gets one score,
  highest wins.
- **Learned** (`evolve.js` searches this): the 6-number `Genome` - how much
  sinking an ordinary ship, sinking the enemy base, advancing a ship closer
  to the enemy base, defensively sinking the enemy's biggest threat,
  avoiding a risky placement, and opening up a future shot are each worth,
  relative to each other.

## Why `setup` was added

Playtesting the shipped `trained` bot (see js/engine/trainedBot.js) surfaced
a real gap: placement was scored purely by straight-line distance to the
enemy base, so a spot that's farther away but clears a shot on a blocking
enemy ship - or accepts real risk to get there - could never outscore just
advancing in a straight line or standing pat. `setup` fixes this: a
placement is now also scored by the best hit-chance it opens up next turn
against ANY enemy ship (not just the base) - see
`placementRiskAndOpportunity()`. This still doesn't give the bot true multi-
turn lookahead (a sacrifice that only pays off three turns later is still
invisible to a one-turn-ahead scorer), but it does let a tactically-better-
but-farther spot beat a straight-line-closer one.

The opponent moves before the setup shot can be taken, though, so a setup's
value is discounted by the enemy's own best chance of sinking the new ship
first: `setup * opportunity * (1 - exposure)`, on top of the flat
`safety * exposure` cost every placement already pays. Between two spots
with an equally good shot lined up, the safer one wins - while a spot that
loses the target out of range entirely still scores zero setup value
regardless of how safe it is.

## Two separate scoring systems, on purpose

`simulate.js`'s `FITNESS` constants and `policy.js`'s `Genome` look like the
same four numbers, but they're not shared:

- `Genome` drives what the bot actually *does* each turn - it's what
  evolution mutates.
- `FITNESS` is a **fixed** yardstick used only to grade a finished game,
  never evolved. If a genome's own weights were also used to grade its
  performance, evolution could win by simply inflating its numbers rather
  than by playing better - `FITNESS` is the fair, common ruler every genome
  is measured against instead.

`SEED_GENOME` in `evolve.js` starts the search at the same values as
`FITNESS`, as a sane prior, then lets mutation/selection move away from it.

## Reading the per-generation log line

Each generation's `avg margin`/`best margin` are relative to that
generation's own (co-evolving) peers - in a self-play population, that
number can stay flat even while everyone is genuinely getting better
together, since the yardstick is moving too. `vs benchmark` is the one
number that isn't: every generation's best genome also plays
`BENCHMARK_GAMES` games against `BENCHMARK_GENOME`, a frozen copy of
`SEED_GENOME` that never mutates and is never part of the population - so
its win rate trending up over the run is the real "is this working" signal.
`turns avg/min/max` and a `hit MAX_TURNS!` flag (if any game in that
generation was cut off by the stalemate cap) are also logged per
generation, to catch runaway match lengths skewing the results.

## Reward shape

Per the brief: placing a ship earns nothing by itself, only distance
progress does; hits are what score. Concretely, credited the instant it
happens during a simulated match (see `simulate.js`):

- sinking an ordinary enemy ship → `FITNESS.hitShip`
- sinking the enemy base → `FITNESS.hitBase` (also ends the match)
- a placement that shortens the closest own ship's distance to the enemy
  base → `FITNESS.advance` × the distance shaved off
- a kill that was specifically the enemy's closest ship to *our* base →
  `FITNESS.defense` × however much further away the next-closest enemy ship
  now sits (ships never move, so this is the only way that distance changes)
- winning/losing the match → a large flat `FITNESS.win`/`FITNESS.loss` on
  top, so a decisive result always outweighs accumulated small-event points
  - the winner's `win` bonus additionally shrinks by `speedPenaltyPerTurn`
    for every turn the match took (floored at `WIN_SPEED_FLOOR` so a win is
    always still worth more than a loss) - a fast win scores higher than a
    slow one. This has to be asymmetric (applied only to the winner) to
    matter at all: a cost applied equally to both players every turn would
    cancel out of the margin (`fitness[1] - fitness[2]`) evolve.js actually
    selects on, since it'd be identical on both sides of the same match.

There's no separate fixed reward for placing safely - `Genome.safety`
(unlike the other four weights) isn't graded against a fixed `FITNESS`
counterpart at all. It only shapes *decision-making*: a placement's score
is `advance × progress − safety × exposure`, where `exposure` is the worst
hit chance any single nearby enemy ship would have against the new spot
(reusing the policy's own fixed accuracy as a stand-in for "the enemy aims
about this well too," rather than inventing a separate assumed-enemy-
accuracy constant). Losing that ship to a bad placement still shows up in
fitness naturally - the *opponent's* `hitShip` credit for sinking it lowers
your relative margin - so no explicit "ship lost" penalty was needed.

## Using a trained genome

`best-genome.json` is just `{ hitShip, hitBase, advance, defense }` - not
wired into the shipped game yet. To try it, pass it as the `genome`
argument to `policy.js`'s `decideMove()` from your own script (see
`simulate.js`'s `playMatch()` for the calling pattern), or use it as a
starting point for a future `js/engine/bot.js` rewrite once you're happy
with what it discovered.

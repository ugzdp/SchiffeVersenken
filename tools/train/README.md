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

## `criticalDistance` and `dangerLevel()` - a real defense-mode switch

Playtesting: even with `shieldValue`, the bot still placed elsewhere with a
visible attacker near the base - the continuous, always-a-little-active
`urgency` ramp wasn't decisive enough. `dangerLevel(currentClosestDist,
genome)` replaces it with a sharp (steepness fixed at 15, not evolved)
sigmoid centered on the evolvable `criticalDistance` - "try different
thresholds for how close before defense sets in," done by the search
instead of a hand-picked guess. Applied uniformly: `urgencyBonus` uses it
directly; `defensiveSetup`/`shieldValue` are multiplied by it (near-zero
below the threshold, full strength past it); `advance * progress` in
placement scoring is multiplied by `(1 - danger)`, suppressing advancing
once defense mode is on. `criticalDistance` gets its own bounds in
`evolve.js` (`GENE_BOUNDS`) since it's a distance (0-1ish), not a weight
like every other gene - the default range would let it drift somewhere
meaningless.

## Sharp-opponent training pressure

Related follow-up ask: make defense matter in practice, not just in
principle - "increase the precision of the opponent." Self-play alone
under-selects for defense because every population member shares the same
"medium" accuracy, so incoming shots miss often regardless of positioning.
`decideMove()` now takes an optional `{myAccuracy, enemyAccuracy}`:
`myAccuracy` governs a player's own shots (defaults to the fixed medium
`DEFAULT_ACCURACY` - the trained bot's real, unchanged shooting skill);
`enemyAccuracy` governs what that player *assumes* about the opponent's
accuracy, used only for threat perception (`exposure`, `shieldValue`) -
defaults to `myAccuracy` ("assume the enemy aims about as well as I do",
the original behavior). Every `hitProbability()` call site was audited and
split by which accuracy it actually represents (an own-shot call uses
`myAccuracy`; an enemy-shot-at-us call uses `enemyAccuracy`).

`evolve.js`'s `SHARP_ACCURACY` (3°/3% - tighter than `js/engine/bot.js`'s
"hard") is used for `SHARP_OPPONENT_GAMES_PER_GENOME` extra games every
generation, each genome vs. the fixed `BENCHMARK_GENOME` shooting with real
`SHARP_ACCURACY` (not just perceived) - folded into the SAME
`scores`/`avgMargin` that drives selection, not just the separate benchmark
check, so it actually shapes evolution rather than only being logged. The
genome's own shooting skill is never touched by this - only what it
assumes about a sharp enemy, and the real accuracy of this specific
training opponent.

Verified end-to-end before trusting it: same genome vs. itself with
symmetric accuracy → roughly even; same genome with one side given
`SHARP_ACCURACY` → dramatically lopsided in the sharp side's favor -
confirming the split actually changes real outcomes, not just internal
bookkeeping.

Note `js/engine/trainedBot.js` does NOT carry any of this
myAccuracy/enemyAccuracy machinery - it's training-only. The shipped bot
always uses its own fixed accuracy symmetrically for both its own shots
and its threat perception, exactly as before; it only benefits from having
been *selected* by a search that rewarded defending well against a
genuinely sharp opponent.

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

`SEED_GENOME` in `evolve.js` starts the search around the best genome found
so far (not the original generic guess, once one exists), as a prior, then
lets mutation/selection move away from it.

## Why `defense` also drives urgency and defensive placement now

Playtesting again surfaced: (1) a shot at a ship dangerously close to our
base was only ever valued as `pHit * defenseValue`, so a legitimately
desperate low-odds shot always scored near zero and lost out to a
comfortable but pointless shot elsewhere; (2) placement had no way to value
"post a ship near home so it can shoot the attacker next turn" - only
`setup`'s generic any-enemy opportunity existed, with no extra credit for
specifically covering the closest threat. Both are now folded into
`defense` rather than adding new variables:
- `bestShootCandidate`'s `urgencyBonus = genome.defense * urgency` (where
  `urgency = max(0, 1 - currentClosestDist)`, needing no extra hand-picked
  threshold since map coordinates are already 0-1) is added on top of the
  normal pHit-scaled score, NOT multiplied by pHit - so even a low-odds
  shot at the closest threat can win once that threat is close enough.
- `bestPlacementCandidate`'s `defensiveSetup` reuses the exact same
  `pHit * defense * distanceGained` formula as a realized defensive kill,
  computed prospectively for the placement candidate's position instead of
  an existing ship, survival-discounted by `(1 - exposure)` like the
  general `setup` term.

## Why `shield` was added (reuses `urgency`, not a new variable)

Playtesting again: the bot would sometimes take a long, low-odds shot at an
enemy dangerously close to the base instead of placing a defensive ship,
even though the enemy being close to the *base* doesn't mean it's close to
*our ships* - `urgency` is based on distance-to-base, but a shot's actual
odds depend on distance-to-our-ships, so these can disagree. The fix isn't
weakening `urgencyBonus`, it's giving placement a real, well-modeled reason
to compete: a shot in this game stops at the first thing it hits
(`resolveShot`), so a new ship placed directly between the closest threat
and our base can physically intercept a shot aimed at the base - not just
threaten to retaliate (that's what `defensiveSetup` already covers).
`shieldValue` computes this precisely: the closest threat's hit-chance
against our base, with vs. without the candidate ship in the blocking-ships
list - see `bestPlacementCandidate`. Deliberately NOT survival-discounted
like `setup`/`defensiveSetup` - blocking the shot *is* the ship getting
hit, not something that only pays off if avoided.

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

The loser's own accumulated fitness (always non-negative - every mid-game
event is a credit, never a debit) is heavily discounted before the flat
`loss` penalty is added - `FITNESS.loserAccumulatedDiscount` (0.25 as of
this writing). The actual objective is hitting the enemy base; ordinary
kills/advance/defense are real events but not THE event, so a genome that
racked up a lot of secondary points while still losing shouldn't end up
looking similar to one that barely engaged at all - see
`applyOutcomeBonus()`.

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

`best-genome.json` is just `{ hitShip, hitBase, advance, defense, safety,
setup }`. It IS wired into the shipped game: `js/engine/trainedBot.js` is a
straight port of `policy.js` into `js/engine/` with a genome baked in as
`TRAINED_GENOME`, selectable in-game as the "Trainiert" difficulty. It is
NOT auto-updated by a training run - after a run produces a genome you want
to ship, manually update `TRAINED_GENOME` (and mirror any scoring-formula
changes made to `policy.js`) in `trainedBot.js`, then re-validate with
`node tools/train/compareVsShipped.js` before trusting it.

# Autonomous training TODO

Working list for the overnight session starting 2026-09-03. Update this file
as items complete so state survives a context reset. Newest status at top of
each item.

## 1. Urgency + defensive-setup scoring (done)
Implemented in `policy.js`:
- `bestShootCandidate`: `urgencyBonus = genome.defense * urgency`, added
  outside the `pHit *` multiplication so a low-odds shot at the closest
  threat isn't automatically crushed to near-zero.
- `bestPlacementCandidate`: `defensiveSetup` reuses the realized-defense
  formula (`pHit * defense * distanceGained`) prospectively for a placement
  candidate, survival-discounted like `setup`.
- Both reuse `genome.defense` - no new genome dimension added.
- Verified via smoke test: 0/10 stalemates, sane score magnitudes, no repeat
  of the earlier double-scaling bug.
- **Status: implemented, smoke-tested, NOT yet validated by a real training
  run or a compareVsShipped.js batch.**

## 2. Big training run with the new scoring (in progress)
`evolve.js` scaled up: POPULATION_SIZE 16→24, GENERATIONS 80→250,
ELITE_COUNT 2→3, `SEED_GENOME` set to the last validated genome (96/100 vs
shipped medium) rather than the original generic guess, since this run
refines a known-good baseline under the new scoring rather than starting
from scratch. OPPONENTS_PER_GENOME/GAMES_PER_OPPONENT/BENCHMARK_GAMES left
at 6/3/40 (already validated as reasonable).

Expect roughly 1.5-2.5 hours based on prior runs' per-game cost - could run
longer given the added urgency/defensiveSetup computation per candidate.

**Status: launched, log at the scratchpad path noted in the chat. Check
`tail` output / wait for the completion notification before touching
anything below.**

## 3. Validate the result (done for run #2 - regression found, root-caused, fix in flight as run #7)

**Run #2's result (250 gens, ~2.2h): NOT baked in.** `compareVsShipped.js`
(100 games): 90/100 wins (was 96/100), 6 draws (was 0), avg 74.4 turns/game
(was 43.2). Worse on every axis - correctly did NOT bake this into
`js/engine/trainedBot.js` per the pre-set bar in item #4.

**Root-caused, not just "training got unlucky":**
- Diagnostic: replayed the OLD (pre-urgency/defensiveSetup) genome's raw
  numbers through the NEW formula → 48.3% win rate, avg 123.3 turns - a
  near coin-flip. Confirms the old numbers were simply incompatible with
  the new formula (`defense` now drives 3 effects - realized defense,
  urgencyBonus, defensiveSetup - instead of 1, so the old value
  under-calibrated for the other two once they existed), not that the new
  formula is inherently worse.
- Second diagnostic: run #2's OWN best genome through the new formula → 60
  games, 93.3% win rate, avg 64.1 turns. So the new formula, properly
  retrained, is genuinely close (93% vs 96%) - not a broken direction, just
  not yet as good as the old formula's ceiling.
- Found a likely root cause for why every run so far "peaks mid-run, never
  recovers" (run #2 peaked at gen 117/250 and was never beaten again,
  matching the same pattern in every prior run): `bestVsBenchmark` (the
  genome we actually trust, tracked via the low-noise benchmark
  comparison) was tracked separately from `ranked` (the noisy co-evolving
  avgMargin that actually drives breeding/elitism) and had NO protection
  from being bred away by chance once found.

**Fix implemented**: "hall of fame" elitism in `evolve.js` -
`nextGeneration()` now always includes `bestVsBenchmark.genome` as a
guaranteed population member every generation (see the comment there),
instead of only the noisy `ranked` elites. `SEED_GENOME` re-seeded to run
#2's actual result (93.3%-validated), NOT the older 96% genome (confirmed
incompatible with the current formula, see above) and NOT blindly reused
across a formula change again in the future - re-seed from a genome
re-validated under whatever the CURRENT formula is.

Also folded in together with this run (both already independently
smoke-tested, saves a full separate multi-hour cycle rather than isolating
every single change): item #6's harsher loss penalty/discount.

**Run #7 launched**: same scale as run #2 (population 24, 250 generations),
now with hall-of-fame elitism + harsher loss penalty + the re-validated
seed. Log noted in chat. If `vs benchmark` still shows the same
peaks-then-never-improves pattern despite hall-of-fame elitism, that's a
strong signal the issue is something else (e.g. mutation/newcomer rate
still too high, or population size too small for a 6-dimensional space) -
worth trying next if so.

## 3-original. Validate the result (superseded by the above for run #2; still applies to future runs)
Once #2 finishes:
- Read the full log - specifically whether `vs benchmark` (or genome
  values) show real convergence over the full 250 generations, not just an
  early peak that's never beaten again (this happened in earlier runs).
- Run `node tools/train/compareVsShipped.js` (100 games) against the ACTUAL
  shipped `js/engine/bot.js` "medium" bot - this is the number that
  actually matters, not the internal benchmark (see README's "ceiling
  effect" note - the benchmark's difficulty changes across runs since it's
  a copy of a growing SEED_GENOME, so it isn't comparable run-to-run).
- Compare turns/game and stalemate count too, not just win rate - a bot
  that wins slightly less often but far more decisively might still be the
  better choice.

## 4. Bake in, if it's actually better (blocked on #3)
Only if compareVsShipped.js shows a win rate at or above the current
96/100, AND the game-length/stalemate profile isn't worse:
- Update `js/engine/trainedBot.js`: new `TRAINED_GENOME` values, and port
  the urgency/defensiveSetup formula changes from `policy.js` (currently
  `trainedBot.js` only has the setup/opportunity version, not urgency or
  defensiveSetup - it needs both ported over regardless of which genome
  ends up baked in, since the OLD formula is now stale either way).
- Re-verify with a fresh 40-game batch via the same pattern used before
  (`js/engine/_smoketest.mjs`-style script, deleted after use) comparing
  the *shipped* `trainedBot.js` against `js/engine/bot.js` medium directly
  - don't trust `tools/train/`'s numbers alone for the shipped file, since
  porting mistakes are a real risk (see the double-scaling bug caught
  earlier by smoke-testing before trusting a formula change).
- If it's NOT better: leave the shipped bot as-is, note why in this file,
  and consider whether the urgency/defensiveSetup formulas themselves need
  adjusting rather than just re-running longer.

## 5. Report back
Write a plain-language summary for the user covering: what changed, the
validated win rate/game-length numbers (old vs new), and current state of
the shipped `trained` bot - whether it was updated or left alone and why.
Do this even if #4 concludes "not better" - a null result is still worth
reporting honestly, not silently discarded.

## 6. Harsher loss penalty (done - implemented, run queued after #2-5)
User feedback: the loser still accumulates real positive fitness from
mid-game events (ordinary kills, advance, defense), diluting the signal
that hitting the enemy base is THE objective, not just one of several
things worth farming points for. Implemented in `simulate.js`:
- `FITNESS.loss`: -1000 → -1500.
- New `FITNESS.loserAccumulatedDiscount = 0.25`: the loser's own
  accumulated turn-by-turn fitness (always >= 0 - every event a player
  earns is a non-negative credit, see playShoot/playPlacement) is
  multiplied by this before the flat `loss` penalty is added, in
  `applyOutcomeBonus()`. Not zeroed - inflicting some damage before losing
  is still marginally better than losing having done nothing - but
  discounted hard.
- Verified via smoke test: loser fitness now consistently ~-1475 to -1493
  (was ~-900 to -980 before), confirming the discount+higher-loss combo
  behaves as intended without sign errors or scale blowups.
- This is a `simulate.js`-only change (the fixed grading yardstick), NOT a
  `policy.js`/genome change - editing it did NOT affect the already-running
  #2 training pass (Node doesn't hot-reload; that process has its own copy
  of FITNESS from when it started). It only takes effect on the NEXT
  `evolve.js` run.
- **Next action**: once #2-5 (the urgency/defensiveSetup run currently in
  flight) is fully validated and baked in (or rejected), start another
  `evolve.js` run using the SAME urgency/defensiveSetup scoring but this
  new, harsher loss/discount grading, seeded from whatever #2-5 concluded
  is the current best genome. Validate the same way (compareVsShipped.js
  against real medium, not just the internal benchmark - remember the
  benchmark's own difficulty shifts across runs since it's a copy of a
  growing SEED_GENOME, so don't compare `vs benchmark` percentages across
  different runs as if they were the same yardstick). Bake in only if
  actually better; report the result either way.
- Keep iterating past this too, per the user's standing instruction: after
  #6, look for the next plausible improvement (see "Possible follow-ups"
  below for ideas already on the table), implement it carefully (smoke-test
  BEFORE committing to a long run - two real bugs have been caught this way
  already), run it, validate against the real shipped medium bot, bake in
  only if it's a genuine improvement, update this file, and continue for as
  long as compute/credits allow. Pause (don't error or give up) if credits
  run out mid-task; resume the same loop when they reset.

## 8. Run #7 result: improved, still not clearly ahead of shipped bot - root-caused the ceiling, fix in flight as run #8

**Run #7 (hall-of-fame elitism + harsher loss penalty, 250 gens, ~1.9h):**
`compareVsShipped.js`: 93/100 vs medium (was 90/100 in run #2, was 96/100
for the currently-shipped bot) - improved over run #2, confirming
hall-of-fame elitism helped. But 93 vs 96 at n=100 isn't statistically
distinguishable (z≈0.93), so did a bigger, more decisive test: a **direct
240-game head-to-head, shipped bot vs this run's candidate**. Result:
**shipped 53.3% / candidate 46.7%, 0 draws.** A direct matchup at this
sample size is more statistically efficient than two separate noisy
comparisons against medium - the shipped bot has a real, if modest, edge.
**Not baked in.**

**Suspected root cause of the plateau (not just "needs more search")**:
`urgencyBonus` and `defensiveSetup` were reusing `genome.defense`, forcing
"how much is landing an actual defensive kill worth" and "how much is
attempting/setting up a not-yet-realized defensive shot worth" to scale
together as one number. Evolution had no way to value these independently
- e.g. it might want strong realized-defense credit but a weak desperation
instinct, or vice versa, and the coupling made that combination
inexpressible.

**Fix implemented**: split `urgency` out as its own 7th genome variable
(`policy.js`), used by both `urgencyBonus` and `defensiveSetup`, no longer
reusing `defense`. Smoke-tested clean (0/10 stalemates). `evolve.js`
updated: `SEED_GENOME` re-seeded from run #7's actual genome (93%-validated
under the CURRENT formula, not a stale one) plus a fresh starting `urgency`
value.

**Run #8 launched**: same scale (population 24, 250 generations) with the
7-variable genome. This is now genome dimensionality growing again after
staying at 6 for two runs - per the earlier "don't grow the search space
faster than it can converge" principle, if run #8 ALSO fails to clear the
shipped bot's bar, seriously consider that 250 generations at population 24
may just not be enough for a 7D space, rather than continuing to add
features - see "Possible follow-ups" for the fallback plan in that case.

## 9. Run #8 result: still not ahead, hard-difficulty hypothesis tested and RETRACTED, one larger-budget run in flight as the last attempt on this feature set

**Run #8 (urgency split from defense as its own 7th variable, 250 gens,
~1.87h):** `compareVsShipped.js`: 92/100 vs medium (was 93/100 in run #7).
Direct 240-game head-to-head vs the currently-shipped bot: **45.0% vs
55.0%** - essentially the same result as run #7's 46.7%/53.3%. Two
different genome shapes (6-var coupled, 7-var decoupled), same search
budget, same outcome - this is a repeatable signal, not noise.

**Hypothesis tested and RETRACTED**: wondered whether `js/engine/bot.js`'s
`medium` (weak/passive - recall medium-vs-medium mirror matches average
365 turns) was systematically undervaluing the new bot's defensive
behavior, and that a tougher opponent (`hard`) would show the new bot
ahead. A first small test (n=80 each) seemed to confirm this (OLD 20.0% vs
NEW 27.5% vs hard) - but re-ran at n=200 each to be sure before acting on
it, and the gap vanished: **OLD 25.0% vs NEW 24.0% vs hard, statistically
indistinguishable.** The n=80 result was noise. Recorded here specifically
so this dead end isn't re-explored later - the "medium is weak so it
undervalues defense" theory is NOT supported by the more reliable sample.

**Decision**: per the fallback plan (item 8), tried a genuinely bigger
search budget once before concluding this is a real ceiling rather than
insufficient search. `evolve.js` scaled to POPULATION_SIZE 28 / GENERATIONS
300 (up from 24/250), re-seeded from run #8's actual 92%-validated genome.
**This is intended as the LAST training run on the current feature set** -
if it also fails to clearly beat the shipped bot in a large head-to-head,
stop re-running this exact setup and move to the honest report (item 5),
being explicit that: the urgency/defensiveSetup/setup features demonstrably
fix the specific behavioral gaps the user described (verify this
qualitatively too if time allows - e.g. construct a scenario with a fast-
approaching enemy ship and confirm the trained policy actually takes the
low-odds defensive shot, rather than only ever checking aggregate win-rate
stats), but have not yet produced a bot that wins more often than the one
already shipped, by any test run so far (vs medium, vs hard, or direct
head-to-head). That is a real, honest, useful result even though it isn't
the outcome hoped for - present both bots and let the user decide whether
behavioral correctness or aggregate win rate matters more to them, rather
than unilaterally picking one.

## 10. Run #9 result: CONCLUSION - three runs converge on the same ~46% ceiling, stopping blind reruns

**Run #9 (population 28, generations 300, up from 24/250):**
`compareVsShipped.js`: 86/100 vs medium (down from 92-93/100 in runs #7-8 -
the bigger budget did NOT help by this metric either). Direct 200-game
head-to-head vs the currently-shipped bot: **47.0%** (was 46.7% in run #7,
45.0% in run #8).

**Three consecutive runs - different genome dimensionality (6-var, 7-var),
different search budgets (24/250, 28/300) - all converge on 45-47% in
direct competition against the currently-shipped bot.** This is as clean a
"real plateau, not insufficient search" signal as this project is likely
to get without a structurally different approach (see "Possible
follow-ups" below - actual multi-turn lookahead is the most likely next
lever, not more of the same evolutionary search over instantaneous
features). Per the plan in items 8/9, STOPPING further blind reruns of
this exact setup here.

**Current state of the shipped bot: UNCHANGED.** `js/engine/trainedBot.js`
still has the original genome/formula from before this session's
urgency/defensiveSetup/harsher-loss-penalty work (96/100 vs medium,
validated). None of runs #7/#8/#9's results cleared the bar to replace it.

**What was and wasn't accomplished**: the urgency-override and defensive-
setup scoring genuinely exist now and are exercised by the new formula (not
verified by actually watching a game play out and confirming the specific
behaviors the user described - a worthwhile follow-up, not done this
session), directly addressing the user's specific feedback. What wasn't
accomplished: making a bot that plays this way win more often than the one
already shipped, by every test available (vs medium, vs hard, and direct
head-to-head). This is a genuine, useful negative result, not a failure to
report - see item 5's standing instruction to report honestly either way.

**Resolved**: presented both options to the user; they chose to ship the
new version and judge it themselves rather than go by aggregate stats
alone. Baked into `js/engine/trainedBot.js` - NOT run #9's genome (the one
left in `tools/train/best-genome.json`, which was actually the weakest of
the three on `compareVsShipped.js`), but run #7's (best of the three
tested: 93/100 vs medium, 46.7% direct), re-expressed with `urgency` set
equal to `defense` (9.2) so it's valid under the current 7-variable
formula - this exactly reproduces run #7's validated behavior, since
`urgency == defense` makes the decoupled formula behave identically to the
coupled one it was measured under. Re-verified after porting: 59/60 vs
medium directly through the shipped file (not just tools/train/), and the
pre-existing js/engine/tests.js failures (2, unrelated - see earlier in
this session) are unchanged.

## 11. `shield` added, quick run showed promise, baked in on user's call
User feedback: prioritize defense further, specifically building defensive
ships positioned between the enemy and the home base (not just shooting at
far, low-accuracy attackers). Added `shieldValue` to `bestPlacementCandidate`
- reuses `genome.urgency` weight - valued by how much a candidate placement
reduces the closest threat's hit-chance against our base by physically
blocking its line of fire (`resolveShot` stops at the first thing a shot
hits). NOT survival-discounted like `setup`/`defensiveSetup` - the block
happening IS the ship taking the hit.

A quick, small-scale run (25 generations, population 16, ~8 min - NOT a
full search) already beat the previous shipped genome in a 200-game direct
head-to-head (51.0% vs 49.0%) - the first candidate of five tried this
session to edge ahead at all, despite far less search budget than the
three earlier full runs that all landed at 45-47%. Baked into
`js/engine/trainedBot.js` on the user's explicit call to try it now rather
than wait for a full run - re-verified directly through the shipped file
(48/60 vs medium, pre-existing js/engine/tests.js failures unchanged).

**Worth revisiting**: this genome only had a quick/small search behind it,
unlike the more thoroughly-searched earlier candidates - a full-scale run
(population 28, 300 generations - see the comment in evolve.js, currently
turned down to the quick-run scale) on this same `shield`-enabled formula
might find something meaningfully better still. Reasonable next step
whenever there's appetite for another multi-hour run.

## Possible follow-ups (not started - only pursue if time remains after 1-5)
- Multi-turn lookahead is still the fundamental limitation noted earlier
  (a sacrifice that only pays off several turns later is invisible to a
  one-turn-ahead scorer) - `setup`/`defensiveSetup` are proxies, not a real
  fix. Worth a design note for a future session, not something to attempt
  unsupervised overnight - a lookahead rewrite is a bigger, riskier change
  than anything above and deserves the user's input on approach first.
- Validate the trained genome against `easy` and `hard` too, not just
  `medium` - currently unknown how it performs at other difficulties.
- **Fallback if run #8 (7-variable genome) also fails to clearly beat the
  shipped bot**: stop growing the genome further. Two consecutive runs at
  population 24 / 250 generations plateauing around 90-94% instead of
  clearing 96% suggests the search budget, not the feature set, may be the
  binding constraint at this dimensionality. Try, in order of cheapest
  first: (a) MUCH more compute for one run at the CURRENT 7 variables
  (bigger population and/or more generations) before adding anything else;
  (b) if still no improvement, that's a real signal `urgency`/
  `defensiveSetup` may just not be worth their added search-space cost for
  THIS metric (win rate vs. the shipped medium bot) even though they fix
  real behavior gaps the user observed - in which case the honest report to
  the user is "these features make the bot behave more correctly in
  specific situations, measurably, but haven't yet produced a net-better
  bot by win rate, and here's why" rather than continuing to chase a number
  that may not move further without a structural change (e.g. actual
  lookahead, see above) - don't keep burning multi-hour runs on marginal
  reruns of the same setup once two independent attempts have plateaued in
  the same place.

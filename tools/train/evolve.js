// evolve.js
//
// Evolutionary self-play trainer for the single "smart bot" policy in
// policy.js. There is no neural net and no gradient descent here - the
// thing being searched over is just the 4-number Genome (see policy.js's
// typedef) that decides how much a candidate shot/placement's expected
// kill value, base-kill value, advance progress, and defensive value are
// worth relative to each other. Random mutation + selection is plenty for
// a 4-dimensional search space, and far cheaper to get right than a full
// RL setup, which this game's turn structure and continuous swipe-based
// action space don't need.
//
// Run with:  node tools/train/evolve.js
// Tune the constants right below to trade run time for search quality -
// start small to sanity-check it runs, then raise POPULATION_SIZE/
// GENERATIONS for a real search.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIslandLibrary } from "./loadIslands.js";
import { MAX_TURNS, playMatch } from "./simulate.js";

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------
const POPULATION_SIZE = 16;
const GENERATIONS = 80;
const OPPONENTS_PER_GENOME = 6; // sampled from the same generation, not a full round-robin (keeps cost linear in population size)
const GAMES_PER_OPPONENT = 3; // alternating sides, to cancel out any first-move edge - 18 games/genome/gen total, vs. 8 in the first smoke-test run
const ELITE_COUNT = 2; // top genomes carried into the next generation unchanged
// Lowered from the first real run (0.25/0.1): that run's best-ever result
// happened at generation 13 and was never beaten again in the remaining 67
// generations - a sign the population was drifting via mutation/newcomer
// churn faster than selection could refine a good genome. Gentler jitter
// and fewer fully-random newcomers should let good genomes actually get
// refined instead of overwritten.
const MUTATION_RATE = 0.15;
const RANDOM_NEWCOMER_RATE = 0.05;
// Raised from 10: an "80% win rate" off only 10 games is 8 wins - could
// easily just be a lucky seed draw, not real skill. 40 games is still
// cheap (each game is well under 100ms) and makes this number trustworthy.
const BENCHMARK_GAMES = 40;

// Sane starting scale for the search - the same numbers as simulate.js's
// fixed FITNESS yardstick, since that's a reasonable prior for how much
// each event SHOULD matter before evolution adjusts it.
const SEED_GENOME = { hitShip: 10, hitBase: 200, advance: 50, defense: 50, safety: 50, setup: 50 };
const MIN_GENE = 0.1;
const MAX_GENE = 2000;

// A frozen copy of SEED_GENOME, NEVER mutated and never part of the
// evolving population - a fixed yardstick to measure real progress
// against. Everything else in this file (avgMargin, winRate) compares a
// genome to its *current, co-evolving* peers, which drifts over time and
// can hover flat even while genuine skill is improving (a "Red Queen"
// effect: if the whole population gets better together, relative margin
// stays roughly the same). Win rate against this one constant opponent is
// the number that actually answers "is training working".
const BENCHMARK_GENOME = { ...SEED_GENOME };

// ---------------------------------------------------------------------------
// Genome helpers
// ---------------------------------------------------------------------------

function randomGenome() {
  return {
    hitShip: jitter(SEED_GENOME.hitShip, 3),
    hitBase: jitter(SEED_GENOME.hitBase, 3),
    advance: jitter(SEED_GENOME.advance, 3),
    defense: jitter(SEED_GENOME.defense, 3),
    safety: jitter(SEED_GENOME.safety, 3),
    setup: jitter(SEED_GENOME.setup, 3),
  };
}

/** Multiplicative random jitter around `base`, roughly in [base/spread, base*spread]. Keeps genes positive, unlike additive noise. */
function jitter(base, spread) {
  const factor = Math.exp((Math.random() * 2 - 1) * Math.log(spread));
  return clamp(base * factor, MIN_GENE, MAX_GENE);
}

function mutate(genome) {
  const result = {};
  for (const key of Object.keys(genome)) {
    const factor = Math.exp((Math.random() * 2 - 1) * MUTATION_RATE);
    result[key] = clamp(genome[key] * factor, MIN_GENE, MAX_GENE);
  }
  return result;
}

function crossover(a, b) {
  const result = {};
  for (const key of Object.keys(a)) result[key] = Math.random() < 0.5 ? a[key] : b[key];
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Fitness evaluation
// ---------------------------------------------------------------------------

/**
 * Play genome `i` against a handful of randomly sampled opponents from the
 * same generation, both sides, and reduce the results to one comparable
 * number per genome: average per-game (own fitness - opponent fitness),
 * which already has simulate.js's big win/loss bonus folded in.
 */
function evaluate(population, islandLibrary) {
  const scores = population.map(() => ({ total: 0, games: 0, wins: 0 }));
  // Turn-count/stalemate tracking is generation-wide, not per-genome - see
  // gameStats below and run()'s log line, which answers "how long is one
  // simulated match" and flags whether MAX_TURNS is being hit at all (if it
  // is, a lot of the fitness noise is coming from truncated, undecided
  // games rather than real skill differences).
  const gameStats = { count: 0, totalTurns: 0, minTurns: Infinity, maxTurns: 0, stalemates: 0 };

  for (let i = 0; i < population.length; i++) {
    const opponents = sampleOpponentIndices(population.length, i, OPPONENTS_PER_GENOME);
    for (const j of opponents) {
      for (let g = 0; g < GAMES_PER_OPPONENT; g++) {
        const seed = Math.floor(Math.random() * 2 ** 31);
        const iIsPlayer1 = g % 2 === 0;
        const genome1 = iIsPlayer1 ? population[i] : population[j];
        const genome2 = iIsPlayer1 ? population[j] : population[i];
        const result = playMatch(genome1, genome2, islandLibrary, seed);

        const myFitness = iIsPlayer1 ? result.fitness[1] : result.fitness[2];
        const oppFitness = iIsPlayer1 ? result.fitness[2] : result.fitness[1];
        scores[i].total += myFitness - oppFitness;
        scores[i].games += 1;
        if (result.winner === (iIsPlayer1 ? 1 : 2)) scores[i].wins += 1;

        gameStats.count += 1;
        gameStats.totalTurns += result.turns;
        gameStats.minTurns = Math.min(gameStats.minTurns, result.turns);
        gameStats.maxTurns = Math.max(gameStats.maxTurns, result.turns);
        if (result.turns >= MAX_TURNS) gameStats.stalemates += 1;
      }
    }
  }

  const perGenome = scores.map((s) => ({ avgMargin: s.games ? s.total / s.games : 0, winRate: s.games ? s.wins / s.games : 0 }));
  return { perGenome, gameStats };
}

/**
 * Play `genome` against the fixed BENCHMARK_GENOME (never mutated), both
 * sides, and reduce to one win rate / average margin - the one number in
 * this file not relative to a moving target, so it's what actually tracks
 * whether the population is improving in absolute terms over the run.
 */
function evaluateVsBenchmark(genome, islandLibrary) {
  let total = 0;
  let wins = 0;
  for (let g = 0; g < BENCHMARK_GAMES; g++) {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const genomeIsPlayer1 = g % 2 === 0;
    const genome1 = genomeIsPlayer1 ? genome : BENCHMARK_GENOME;
    const genome2 = genomeIsPlayer1 ? BENCHMARK_GENOME : genome;
    const result = playMatch(genome1, genome2, islandLibrary, seed);

    const myFitness = genomeIsPlayer1 ? result.fitness[1] : result.fitness[2];
    const oppFitness = genomeIsPlayer1 ? result.fitness[2] : result.fitness[1];
    total += myFitness - oppFitness;
    if (result.winner === (genomeIsPlayer1 ? 1 : 2)) wins += 1;
  }
  return { avgMargin: total / BENCHMARK_GAMES, winRate: wins / BENCHMARK_GAMES };
}

function sampleOpponentIndices(populationSize, excludeIndex, count) {
  const pool = [];
  for (let k = 0; k < populationSize; k++) if (k !== excludeIndex) pool.push(k);
  for (let k = pool.length - 1; k > 0; k--) {
    const swap = Math.floor(Math.random() * (k + 1));
    [pool[k], pool[swap]] = [pool[swap], pool[k]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

// ---------------------------------------------------------------------------
// Main GA loop
// ---------------------------------------------------------------------------

function run() {
  const islandLibrary = loadIslandLibrary();
  let population = Array.from({ length: POPULATION_SIZE }, randomGenome);

  let best = null;
  let bestVsBenchmark = null;
  const runStart = Date.now();
  for (let gen = 1; gen <= GENERATIONS; gen++) {
    const genStart = Date.now();
    const { perGenome, gameStats } = evaluate(population, islandLibrary);

    const ranked = population.map((genome, i) => ({ genome, ...perGenome[i] })).sort((a, b) => b.avgMargin - a.avgMargin);
    if (!best || ranked[0].avgMargin > best.avgMargin) best = ranked[0];

    const vsBenchmark = evaluateVsBenchmark(ranked[0].genome, islandLibrary);
    if (!bestVsBenchmark || vsBenchmark.winRate > bestVsBenchmark.winRate) {
      bestVsBenchmark = { genome: ranked[0].genome, ...vsBenchmark, gen };
    }
    const genMs = Date.now() - genStart;

    const avgMargin = ranked.reduce((sum, r) => sum + r.avgMargin, 0) / ranked.length;
    const avgTurns = gameStats.totalTurns / gameStats.count;
    const gamesThisGen = gameStats.count + BENCHMARK_GAMES;
    const msPerGame = genMs / gamesThisGen;
    console.log(
      `gen ${String(gen).padStart(3)} | best margin ${ranked[0].avgMargin.toFixed(1)} (win rate ${(ranked[0].winRate * 100).toFixed(0)}%) | ` +
        `avg margin ${avgMargin.toFixed(1)} | vs benchmark ${(vsBenchmark.winRate * 100).toFixed(0)}% (margin ${vsBenchmark.avgMargin.toFixed(1)}) | ` +
        `turns avg/min/max ${avgTurns.toFixed(0)}/${gameStats.minTurns}/${gameStats.maxTurns}` +
        `${gameStats.stalemates > 0 ? ` (${gameStats.stalemates}/${gameStats.count} hit MAX_TURNS!)` : ""} | ` +
        `${gamesThisGen} games in ${(genMs / 1000).toFixed(1)}s (${msPerGame.toFixed(1)}ms/game) | best genome ${formatGenome(ranked[0].genome)}`
    );

    population = nextGeneration(ranked);
  }

  console.log(`\nTotal run time: ${((Date.now() - runStart) / 1000).toFixed(1)}s`);
  console.log("Best genome by co-evolving margin:", formatGenome(best.genome), `(margin ${best.avgMargin.toFixed(1)}, win rate ${(best.winRate * 100).toFixed(0)}%)`);
  console.log(
    "Best genome vs fixed benchmark:",
    formatGenome(bestVsBenchmark.genome),
    `(gen ${bestVsBenchmark.gen}, win rate ${(bestVsBenchmark.winRate * 100).toFixed(0)}%, margin ${bestVsBenchmark.avgMargin.toFixed(1)})`
  );
  writeBestGenome(bestVsBenchmark.genome);
}

function nextGeneration(ranked) {
  const next = ranked.slice(0, ELITE_COUNT).map((r) => r.genome);
  while (next.length < ranked.length) {
    if (Math.random() < RANDOM_NEWCOMER_RATE) {
      next.push(randomGenome());
      continue;
    }
    const parentA = tournamentPick(ranked).genome;
    const parentB = tournamentPick(ranked).genome;
    next.push(mutate(crossover(parentA, parentB)));
  }
  return next;
}

/** Pick one of the top half at random - simple, cheap selection pressure. */
function tournamentPick(ranked) {
  const poolSize = Math.max(2, Math.floor(ranked.length / 2));
  return ranked[Math.floor(Math.random() * poolSize)];
}

function formatGenome(genome) {
  return `{ hitShip: ${genome.hitShip.toFixed(1)}, hitBase: ${genome.hitBase.toFixed(1)}, advance: ${genome.advance.toFixed(1)}, defense: ${genome.defense.toFixed(1)}, safety: ${genome.safety.toFixed(1)}, setup: ${genome.setup.toFixed(1)} }`;
}

function writeBestGenome(genome) {
  const outPath = join(dirname(fileURLToPath(import.meta.url)), "best-genome.json");
  writeFileSync(outPath, JSON.stringify(genome, null, 2) + "\n");
  console.log(`Saved to ${outPath}`);
}

run();

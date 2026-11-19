// GTA VI trophy rarity forecast (gta6-trophy-rarity-forecast-01).
//
// Idea: the Exophase page a case's history records is frozen between the site's
// own refreshes, so every change in the history IS a refresh: at a refresh the
// tracked-player count jumps and every rate is diluted toward the profile of
// the players who just arrived (they hold far fewer trophies than the players
// tracked so far). Between refreshes nothing moves. So the forecast is built
// from three pieces, all estimated from the case's own history when it shows
// them, and from stated priors when it does not:
//
//   1. Progression: holders keep earning trophies. Per trophy, the logit of
//      its rate (after removing the dilution of past refreshes) is fitted
//      against ln(1 + hours since release) and read at the target, shrunk
//      toward the pooled slope across trophies.
//   2. Dilution: future refreshes arrive as a renewal process (rate fitted
//      from the refreshes in the history, prior one per 4 hours), each one
//      multiplying the tracked players by a log-normal growth factor (fitted
//      from the history's jumps and its log-player curve, prior median x3
//      early in a game's life, when tracking grows explosively). Because
//      the page has already sat unchanged for a while at the checkpoint, the
//      chance of a refresh inside the horizon is read off the renewal
//      process's residual life, not a memoryless rate: a page flat for three
//      hours with refreshes hours apart is due one soon. At a refresh the
//      new players arrive holding each trophy at a fraction kappa of the
//      current rate (kappa fitted from past refreshes, prior 0.15: a fresh
//      cohort holds about a seventh of the rate of the players tracked so
//      far); a trophy already at 100% stays there (kappa = 1).
//   3. Spread: the forecast is a mixture over the number of refreshes before
//      the target, each branch a normal on the logit scale whose width adds
//      trend uncertainty, refresh-size uncertainty, binomial holder noise
//      and a random-walk floor. The five quantiles are read off the mixture
//      distribution, so a refresh that may or may not happen before the
//      target widens the low quantiles honestly instead of being averaged
//      away.
//
// Nothing is read from the network; the program is deterministic (pure
// arithmetic, no randomness, no clock reads) and stdlib-only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at the levels. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Prior mean gap between refreshes, in hours. */
const PRIOR_REFRESH_INTERVAL_H = 4;
/** Shape of the inter-refresh gap distribution (2 = somewhat regular). */
const GAP_SHAPE = 2;
/** Prior median growth of tracked players per refresh, early in a game's life. */
const PRIOR_LOG_GROWTH = Math.log(3);
/** Prior spread (logit) of one refresh's log growth factor. */
const PRIOR_LOG_GROWTH_SD = 0.8;
/** Prior new-cohort rate as a fraction of the current rate. */
const PRIOR_KAPPA = 0.15;
/** Random-walk spread floor, in logit units per square-root day. */
const FLOOR_SIGMA = 0.5;

interface Trophy {
  id: number;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  game: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |err| < 1.5e-7). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const c = 1 - Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI) * poly;
  return x >= 0 ? c : 1 - c;
}
function poissonPmf(k: number, m: number): number {
  let p = Math.exp(-m);
  for (let i = 1; i <= k; i++) p *= m / i;
  return p;
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/** Least-squares slope of y on x (0 when the spread of x is 0). */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  return sxx > 1e-12 ? sxy / sxx : 0;
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const nT = c.trophies.length;
  const releaseMs = Date.parse(`${c.game.release_date ?? '2026-11-19'}T00:00:00Z`);
  const hoursSinceRelease = (iso: string): number =>
    Math.max(0, (Date.parse(iso) - releaseMs) / 3600000);
  const xOf = (iso: string): number => Math.log1p(hoursSinceRelease(iso));
  const xTarget = xOf(c.target);
  const xLast = c.history.length ? xOf(c.history[c.history.length - 1].at) : xTarget;
  const dx = Math.max(0, xTarget - xLast);
  const horizonH = c.horizon_minutes / 60;
  const horizonDays = c.horizon_minutes / 1440;

  // Collapse the history to distinct states: between refreshes the page is
  // frozen, so consecutive identical reads carry no information.
  const states: Read[] = [];
  for (const r of c.history) {
    const prev = states[states.length - 1];
    if (
      prev &&
      prev.players_tracked === r.players_tracked &&
      prev.rates.length === r.rates.length &&
      prev.rates.every((v, i) => v === r.rates[i])
    ) {
      continue;
    }
    states.push(r);
  }
  const last = states[states.length - 1];
  const Nlast = last.players_tracked;
  const lastRates: number[] = c.trophies.map((_, i) => last.rates[i] ?? 0);

  // Refresh steps: consecutive distinct states where anything changed.
  interface Step {
    dLogN: number;
    dN: number;
    prevRates: number[];
    nextRates: number[];
    prevN: number;
    nextN: number;
  }
  const steps: Step[] = [];
  for (let s = 1; s < states.length; s++) {
    const a = states[s - 1];
    const b = states[s];
    steps.push({
      dLogN: Math.log(b.players_tracked / a.players_tracked),
      dN: b.players_tracked - a.players_tracked,
      prevRates: c.trophies.map((_, i) => a.rates[i] ?? 0),
      nextRates: c.trophies.map((_, i) => b.rates[i] ?? 0),
      prevN: a.players_tracked,
      nextN: b.players_tracked,
    });
  }
  const refreshSteps = steps.filter((s) => s.dN !== 0 || s.prevRates.some((v, i) => v !== s.nextRates[i]));
  const spanH = states.length > 1
    ? Math.max(0.5, (Date.parse(states[states.length - 1].at) - Date.parse(states[0].at)) / 3600000)
    : 3;

  // --- kappa: the new cohort's rate as a fraction of the current rate. ---
  let kappa = PRIOR_KAPPA;
  {
    let num = 0;
    let den = 0;
    for (const s of refreshSteps) {
      if (s.dN <= 0) continue;
      for (let i = 0; i < nT; i++) {
        if (s.prevRates[i] >= 99) continue; // the 100% trophy: kappa is 1 by construction
        const prevH = (s.prevRates[i] / 100) * s.prevN;
        const nextH = (s.nextRates[i] / 100) * s.nextN;
        num += Math.max(0, nextH - prevH);
        den += (s.prevRates[i] / 100) * s.dN;
      }
    }
    if (den > 0) kappa = Math.min(1, Math.max(0.02, num / den));
  }

  // --- Pooled dilution coefficient, to strip past dilution out of the trend. ---
  let cPool = -(1 - kappa);
  {
    let num = 0;
    let den = 0;
    for (const s of refreshSteps) {
      if (Math.abs(s.dLogN) < 1e-9) continue;
      for (let i = 0; i < nT; i++) {
        if (s.prevRates[i] >= 99 || s.prevRates[i] <= 0) continue;
        const d = logit(s.nextRates[i]) - logit(s.prevRates[i]);
        num += d * s.dLogN;
        den += s.dLogN * s.dLogN;
      }
    }
    if (den > 0) cPool = Math.max(-1.5, Math.min(0, num / den));
  }

  // --- Progression slopes: adjusted logit rate on ln(1 + hours). ---
  const xs = states.map((s) => xOf(s.at));
  const slopes: number[] = [];
  for (let i = 0; i < nT; i++) {
    const ys = states.map((s) => {
      const r = s.rates[i] ?? 0;
      return logit(r) - cPool * Math.log(s.players_tracked / states[0].players_tracked);
    });
    slopes.push(states.length >= 3 ? slope(xs, ys) : 0);
  }
  const bPool = median(slopes.filter((b) => Number.isFinite(b)));
  const bShrunk = slopes.map((b, i) => {
    const n = states.length;
    const w = n / (n + 3);
    return bPool + (b - bPool) * w;
  });

  // --- Refresh rate and growth per refresh. ---
  const lambda = (refreshSteps.length + 1) / (spanH + PRIOR_REFRESH_INTERVAL_H);
  const m = lambda * horizonH; // expected refreshes before the target
  let muLogG = PRIOR_LOG_GROWTH;
  let sdLogG = PRIOR_LOG_GROWTH_SD;
  {
    const jumps = refreshSteps.filter((s) => s.dN > 0).map((s) => s.dLogN);
    if (jumps.length >= 2) {
      const mean = jumps.reduce((a, b) => a + b, 0) / jumps.length;
      const variance = jumps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (jumps.length - 1);
      sdLogG = Math.min(1.5, Math.max(0.3, Math.sqrt(Math.max(0.04, variance))));
    }
    // Anchor expected player growth to the history's log-player curve when it
    // shows one (recent reads when there are enough of them), damped because
    // tracking growth decelerates as the player base saturates.
    const recent = states.filter((s) => hoursSinceRelease(s.at) >= hoursSinceRelease(last.at) - 24);
    const fitStates = recent.length >= 3 ? recent : states;
    if (fitStates.length >= 3) {
      const fx = fitStates.map((s) => xOf(s.at));
      const fy = fitStates.map((s) => Math.log(s.players_tracked));
      const sN = slope(fx, fy);
      if (sN > 0) {
        const dLogN = Math.min(3, Math.max(0, 0.7 * sN * dx));
        if (m > 0.05) muLogG = Math.min(2.0, Math.max(0, dLogN / m));
      }
    }
  }

  // --- Mixture over refresh counts. ---
  // The zero-refresh weight comes from the renewal process's residual life:
  // the page has sat unchanged since the last distinct state, so with gaps
  // averaging muI hours the chance of at least one refresh inside the
  // horizon is (F(a+h) - F(a)) / (1 - F(a)) for the gap CDF F at the
  // state's current age a. Counts of one and more follow the Poisson rate
  // above, renormalised to that chance.
  const muI = (() => {
    // Times at which a refresh was seen, in hours since the first read.
    const refreshTimes: number[] = [];
    for (let s = 1; s < states.length; s++) {
      const a = states[s - 1];
      const b = states[s];
      const changed =
        b.players_tracked !== a.players_tracked ||
        b.rates.some((v, i) => v !== a.rates[i]);
      if (changed) refreshTimes.push(Date.parse(b.at) / 3600000);
    }
    const gaps: number[] = [];
    for (let j = 1; j < refreshTimes.length; j++) gaps.push(refreshTimes[j] - refreshTimes[j - 1]);
    if (gaps.length >= 2) return Math.min(24, Math.max(1, gaps.reduce((a, b) => a + b, 0) / gaps.length));
    return PRIOR_REFRESH_INTERVAL_H;
  })();
  const gapCdf = (t: number): number => {
    // Gamma(shape=2, mean muI) CDF.
    const u = (GAP_SHAPE * t) / muI;
    return 1 - Math.exp(-u) * (1 + u);
  };
  const ageH = Math.max(
    0,
    (Date.parse(c.at) - Date.parse(states[states.length - 1].at)) / 3600000,
  );
  const pAtLeastOne = (() => {
    const surv = 1 - gapCdf(ageH);
    if (surv <= 1e-9) return 1;
    return Math.min(1, Math.max(0, (gapCdf(ageH + horizonH) - gapCdf(ageH)) / surv));
  })();
  const K = Math.min(60, Math.ceil(m + 8 * Math.sqrt(m + 1) + 8));
  const weights: number[] = [];
  {
    const p0pois = poissonPmf(0, m);
    let tot = 0;
    for (let k = 0; k <= K; k++) {
      // With a zero horizon there is no refresh to wait for: all weight on k=0.
      weights.push(
        m <= 0 ? (k === 0 ? 1 : 0) : k === 0 ? 1 - pAtLeastOne : (pAtLeastOne * poissonPmf(k, m)) / (1 - p0pois),
      );
      tot += weights[k];
    }
    for (let k = 0; k <= K; k++) weights[k] /= tot;
  }
  const sTrend = 0.1 * dx + 0.05;
  const sFloor = FLOOR_SIGMA * Math.sqrt(horizonDays);

  const rows: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < nT; i++) {
    const rLast = lastRates[i];
    const id = c.trophies[i].id;
    if (rLast >= 99.99) {
      // Everybody tracked holds this trophy and every newcomer earns it on
      // arrival: the rate stays at 100%.
      rows.push({ id, q: [99.9, 99.95, 99.99, 99.99, 99.99] });
      continue;
    }
    const rFrac = Math.max(0.0001, Math.min(0.9999, rLast / 100));
    const rTrend = invLogit(logit(rLast) + bShrunk[i] * dx) / 100; // trend-only rate, fraction
    const hTrend = rTrend * Nlast;
    const kappai = rLast >= 99 ? 1 : kappa;
    // Branch medians (logit) and widths for each refresh count k.
    const mu: number[] = [];
    const sd: number[] = [];
    for (let k = 0; k <= K; k++) {
      const Nk = Nlast * Math.exp(k * muLogG);
      const dN = Math.max(0, Nk - Nlast);
      const Hk = hTrend + kappai * rTrend * dN;
      const rk = Math.min(0.9999, Math.max(0.0001, Hk / Nk));
      mu.push(Math.log(rk / (1 - rk)));
      const sBinom = Math.min(0.5, 1 / Math.max(1, Hk));
      const v =
        sTrend * sTrend +
        k * ((1 - kappai) * sdLogG) * ((1 - kappai) * sdLogG) +
        sBinom +
        sFloor * sFloor;
      sd.push(Math.sqrt(Math.max(0.02, v)));
    }
    const cdf = (y: number): number => {
      let p = 0;
      for (let k = 0; k <= K; k++) p += weights[k] * normCdf((y - mu[k]) / sd[k]);
      return p;
    };
    const q: number[] = [];
    const lo = logit(0.01);
    const hi = logit(99.99);
    for (const tau of LEVELS) {
      let a = lo;
      let b = hi;
      for (let it = 0; it < 40; it++) {
        const mid = (a + b) / 2;
        if (cdf(mid) < tau) a = mid;
        else b = mid;
      }
      q.push(round4(invLogit((a + b) / 2)));
    }
    // Enforce non-decreasing after rounding.
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    rows.push({ id, q });
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const raw = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (raw.levels.length !== LEVELS.length || raw.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(raw.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (!raw.history || raw.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(raw);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}

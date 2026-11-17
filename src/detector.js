'use strict';

const STATUS = Object.freeze({
  OK: 'ok',
  SLOW_BURN: 'slow_burn',
  FAST_BURN: 'fast_burn',
  UNKNOWN: 'unknown',
});

const SEVERITY_RANK = Object.freeze({
  [STATUS.OK]: 0,
  [STATUS.SLOW_BURN]: 1,
  [STATUS.FAST_BURN]: 2,
});

const DEFAULT_WINDOWS = Object.freeze([
  { name: 'fast', severity: STATUS.FAST_BURN, longWindow: 3600, shortWindow: 300, threshold: 14.4 },
  { name: 'slow', severity: STATUS.SLOW_BURN, longWindow: 6 * 3600, shortWindow: 3600, threshold: 6 },
]);

const DEFAULT_BUDGET_PERIOD = 30 * 24 * 3600;

function normalizeSample(sample) {
  if (!sample || typeof sample !== 'object') {
    throw new TypeError('sample must be an object');
  }
  const { timestamp, success, total } = sample;
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError('sample.timestamp must be a non-negative finite number (unix seconds)');
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new TypeError('sample.total must be a non-negative finite number');
  }
  if (!Number.isFinite(success) || success < 0) {
    throw new TypeError('sample.success must be a non-negative finite number');
  }
  if (success > total) {
    throw new TypeError('sample.success must not exceed sample.total');
  }
  return { timestamp, success, total, id: sample.id };
}

class BurnRateDetector {
  constructor(options = {}) {
    const {
      sloTarget,
      windows = DEFAULT_WINDOWS,
      minSamples = 1,
      sliceInterval = 60,
      minCoverage = 0.5,
      budgetPeriod = DEFAULT_BUDGET_PERIOD,
    } = options;

    if (!Number.isFinite(sloTarget) || sloTarget <= 0 || sloTarget >= 1) {
      throw new TypeError('sloTarget must be a finite number in (0, 1), e.g. 0.999');
    }
    if (!Number.isFinite(minSamples) || minSamples < 0) {
      throw new TypeError('minSamples must be a non-negative finite number');
    }
    if (!Number.isFinite(sliceInterval) || sliceInterval <= 0) {
      throw new TypeError('sliceInterval must be a positive finite number of seconds');
    }
    if (!Number.isFinite(minCoverage) || minCoverage <= 0 || minCoverage > 1) {
      throw new TypeError('minCoverage must be in (0, 1]');
    }
    if (!Number.isFinite(budgetPeriod) || budgetPeriod <= 0) {
      throw new TypeError('budgetPeriod must be a positive finite number of seconds');
    }
    if (!Array.isArray(windows) || windows.length === 0) {
      throw new TypeError('windows must be a non-empty array');
    }

    this.sloTarget = sloTarget;
    this.errorBudget = 1 - sloTarget;
    this.minSamples = minSamples;
    this.sliceInterval = sliceInterval;
    this.minCoverage = minCoverage;
    this.budgetPeriod = budgetPeriod;

    this.windows = windows.map((w, i) => {
      const severity = w.severity || (i === 0 ? STATUS.FAST_BURN : STATUS.SLOW_BURN);
      if (!Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity) || severity === STATUS.OK) {
        throw new TypeError(`windows[${i}].severity must be "slow_burn" or "fast_burn"`);
      }
      for (const key of ['longWindow', 'shortWindow', 'threshold']) {
        if (!Number.isFinite(w[key]) || w[key] <= 0) {
          throw new TypeError(`windows[${i}].${key} must be a positive finite number`);
        }
      }
      if (w.shortWindow > w.longWindow) {
        throw new TypeError(`windows[${i}].shortWindow must not exceed longWindow`);
      }
      return {
        name: w.name || `window-${i}`,
        severity,
        longWindow: w.longWindow,
        shortWindow: w.shortWindow,
        threshold: w.threshold,
      };
    });

    const maxWindow = Math.max(...this.windows.map((w) => w.longWindow));
    this.retention = maxWindow + sliceInterval;

    this.samples = new Map();
    this.seenIds = new Set();
  }

  addSample(sample) {
    const s = normalizeSample(sample);
    if (s.id !== undefined) {
      if (this.seenIds.has(s.id)) return false;
      this.seenIds.add(s.id);
    }
    this.samples.set(s.timestamp, { timestamp: s.timestamp, success: s.success, total: s.total });
    return true;
  }

  addSamples(samples) {
    if (!Array.isArray(samples)) {
      throw new TypeError('samples must be an array');
    }
    let added = 0;
    for (const sample of samples) {
      if (this.addSample(sample)) added += 1;
    }
    return added;
  }

  prune(now) {
    const cutoff = now - this.retention;
    for (const ts of this.samples.keys()) {
      if (ts < cutoff) this.samples.delete(ts);
    }
  }

  windowStats(now, windowSeconds) {
    const from = now - windowSeconds;
    let success = 0;
    let total = 0;
    let slices = 0;
    for (const s of this.samples.values()) {
      if (s.timestamp > from && s.timestamp <= now) {
        success += s.success;
        total += s.total;
        slices += 1;
      }
    }
    const coverage = Math.min(1, (slices * this.sliceInterval) / windowSeconds);
    const evaluable = total >= this.minSamples && coverage >= this.minCoverage;
    const errors = total - success;
    const errorRate = total > 0 ? errors / total : null;
    const burnRate = errorRate === null ? null : errorRate / this.errorBudget;
    const budgetConsumed = burnRate === null ? null : burnRate * (windowSeconds / this.budgetPeriod);
    return { total, success, errors, slices, coverage, evaluable, errorRate, burnRate, budgetConsumed };
  }

  evaluate(now) {
    if (!Number.isFinite(now)) {
      throw new TypeError('now must be a finite number (unix seconds)');
    }
    this.prune(now);

    const evaluated = this.windows.map((w) => {
      const long = this.windowStats(now, w.longWindow);
      const short = this.windowStats(now, w.shortWindow);
      const evaluable = long.evaluable && short.evaluable;
      const firing =
        evaluable && short.burnRate >= w.threshold && long.burnRate >= w.threshold;
      return {
        name: w.name,
        severity: w.severity,
        threshold: w.threshold,
        evaluable,
        firing,
        short: {
          window: w.shortWindow,
          errorRate: short.errorRate,
          burnRate: short.burnRate,
          total: short.total,
          coverage: short.coverage,
        },
        long: {
          window: w.longWindow,
          errorRate: long.errorRate,
          burnRate: long.burnRate,
          total: long.total,
          coverage: long.coverage,
          budgetConsumed: long.budgetConsumed,
        },
      };
    });

    let status = STATUS.UNKNOWN;
    const firing = evaluated.filter((w) => w.firing);
    if (firing.length > 0) {
      status = firing.reduce((a, b) =>
        SEVERITY_RANK[a.severity] >= SEVERITY_RANK[b.severity] ? a : b
      ).severity;
    } else if (evaluated.some((w) => w.evaluable)) {
      status = STATUS.OK;
    }

    const budgetWindow = evaluated
      .filter((w) => w.evaluable && w.long.burnRate !== null)
      .sort((a, b) => b.long.window - a.long.window)[0];
    const budget = budgetWindow
      ? {
          period: this.budgetPeriod,
          errorBudget: this.errorBudget,
          burnRate: budgetWindow.long.burnRate,
          consumedFraction: budgetWindow.long.budgetConsumed,
          measuredWindow: budgetWindow.long.window,
        }
      : { period: this.budgetPeriod, errorBudget: this.errorBudget, burnRate: null, consumedFraction: null, measuredWindow: null };

    return { status, windows: evaluated, budget };
  }
}

module.exports = { BurnRateDetector, STATUS, DEFAULT_WINDOWS, DEFAULT_BUDGET_PERIOD };

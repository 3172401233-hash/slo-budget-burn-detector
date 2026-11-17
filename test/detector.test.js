'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BurnRateDetector, STATUS, aggregateServices } = require('../index');

const SLICE = 60;
const BASE = 1_700_000_000;

function makeDetector(overrides = {}) {
  return new BurnRateDetector({
    sloTarget: 0.99,
    minSamples: 10,
    sliceInterval: SLICE,
    minCoverage: 0.5,
    windows: [
      { name: 'fast', severity: STATUS.FAST_BURN, longWindow: 3600, shortWindow: 300, threshold: 14.4 },
      { name: 'slow', severity: STATUS.SLOW_BURN, longWindow: 6 * 3600, shortWindow: 3600, threshold: 6 },
    ],
    ...overrides,
  });
}

function slices(start, count, { success, total }) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ timestamp: start + (i + 1) * SLICE, success, total });
  }
  return out;
}

test('瞬时尖峰：短窗口超标但长窗口未确认，不告警', () => {
  const d = makeDetector();
  d.addSamples(slices(BASE, 360, { success: 100, total: 100 }));
  const spikeStart = BASE + 360 * SLICE;
  d.addSamples(slices(spikeStart, 5, { success: 50, total: 100 }));
  const now = spikeStart + 5 * SLICE;

  const result = d.evaluate(now);
  const fast = result.windows.find((w) => w.name === 'fast');
  assert.ok(fast.evaluable);
  assert.ok(fast.short.burnRate >= fast.threshold, '短窗口燃烧率应超过阈值');
  assert.ok(fast.long.burnRate < fast.threshold, '长窗口燃烧率应低于阈值');
  assert.equal(fast.firing, false);
  assert.equal(result.status, STATUS.OK);
});

test('持续故障：长短窗口同时确认，触发快速燃烧', () => {
  const d = makeDetector();
  d.addSamples(slices(BASE, 120, { success: 50, total: 100 }));
  const now = BASE + 120 * SLICE;

  const result = d.evaluate(now);
  const fast = result.windows.find((w) => w.name === 'fast');
  assert.ok(Math.abs(fast.short.burnRate - 50) < 1e-9);
  assert.ok(Math.abs(fast.long.burnRate - 50) < 1e-9);
  assert.equal(fast.firing, true);
  assert.equal(result.status, STATUS.FAST_BURN);
});

test('上游大面积中断：100% 错误，快速燃烧并消耗预算', () => {
  const d = makeDetector();
  d.addSamples(slices(BASE, 60, { success: 0, total: 100 }));
  const now = BASE + 60 * SLICE;

  const result = d.evaluate(now);
  assert.equal(result.status, STATUS.FAST_BURN);
  const fast = result.windows.find((w) => w.name === 'fast');
  assert.equal(fast.long.errorRate, 1);
  assert.ok(Math.abs(fast.long.burnRate - 100) < 1e-9);

  const expected = 100 * (3600 / (30 * 24 * 3600));
  assert.ok(Math.abs(result.budget.consumedFraction - expected) < 1e-9);
  assert.ok(result.budget.consumedFraction > 0.13 && result.budget.consumedFraction < 0.14);
});

test('零请求：不产生误报也不误报恢复，状态为未知', () => {
  const d = makeDetector();
  d.addSamples(slices(BASE, 120, { success: 0, total: 0 }));
  const result = d.evaluate(BASE + 120 * SLICE);
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.budget.burnRate, null);
});

test('缺失样本：无数据与低覆盖率均为未知', () => {
  const d = makeDetector();
  assert.equal(d.evaluate(BASE).status, STATUS.UNKNOWN);

  const sparse = makeDetector();
  sparse.addSamples(slices(BASE, 10, { success: 100, total: 100 }));
  assert.equal(sparse.evaluate(BASE + 3600).status, STATUS.UNKNOWN);
});

test('采样停止上报：告警不恢复为正常，转为未知', () => {
  const d = makeDetector();
  d.addSamples(slices(BASE, 60, { success: 0, total: 100 }));
  const outageEnd = BASE + 60 * SLICE;
  assert.equal(d.evaluate(outageEnd).status, STATUS.FAST_BURN);

  const silent = d.evaluate(outageEnd + 2 * 3600);
  assert.equal(silent.status, STATUS.UNKNOWN);
  assert.notEqual(silent.status, STATUS.OK);
});

test('样本量低于最小样本量：状态为未知', () => {
  const d = makeDetector({ minSamples: 100_000 });
  d.addSamples(slices(BASE, 120, { success: 50, total: 100 }));
  assert.equal(d.evaluate(BASE + 120 * SLICE).status, STATUS.UNKNOWN);
});

test('慢速燃烧：中等错误率仅触发慢速窗口', () => {
  const d = makeDetector();
  d.addSamples(slices(BASE, 360, { success: 90, total: 100 }));
  const result = d.evaluate(BASE + 360 * SLICE);
  const slow = result.windows.find((w) => w.name === 'slow');
  const fast = result.windows.find((w) => w.name === 'fast');
  assert.equal(slow.firing, true);
  assert.equal(fast.firing, false);
  assert.equal(result.status, STATUS.SLOW_BURN);
});

test('重复指标不重复计数：同时间戳覆盖、同 id 跳过', () => {
  const d = makeDetector();
  const sample = { timestamp: BASE + SLICE, success: 50, total: 100, id: 'm-1' };
  assert.equal(d.addSample(sample), true);
  assert.equal(d.addSample(sample), false);
  d.addSample({ timestamp: BASE + SLICE, success: 60, total: 100 });

  const stats = d.windowStats(BASE + SLICE, 300);
  assert.equal(stats.total, 100);
  assert.equal(stats.success, 60);
});

test('服务聚合：按时间片求和且服务内去重', () => {
  const byService = {
    'svc-a': [
      { timestamp: BASE + SLICE, success: 98, total: 100, id: 'a-1' },
      { timestamp: BASE + SLICE, success: 98, total: 100, id: 'a-1' },
      { timestamp: BASE + 2 * SLICE, success: 100, total: 100 },
    ],
    'svc-b': [
      { timestamp: BASE + SLICE, success: 100, total: 100 },
      { timestamp: BASE + 2 * SLICE, success: 96, total: 100 },
    ],
  };
  const merged = aggregateServices(byService);
  assert.deepEqual(merged, [
    { timestamp: BASE + SLICE, success: 198, total: 200 },
    { timestamp: BASE + 2 * SLICE, success: 196, total: 200 },
  ]);

  const d = makeDetector({ minSamples: 10 });
  d.addSamples(merged);
  const stats = d.windowStats(BASE + 2 * SLICE, 300);
  assert.equal(stats.total, 400);
  assert.equal(stats.errors, 6);
});

test('状态转换：正常 → 快速燃烧 → 停止上报转未知 → 恢复正常', () => {
  const d = makeDetector();
  d.addSamples(slices(BASE, 360, { success: 100, total: 100 }));
  const t1 = BASE + 360 * SLICE;
  assert.equal(d.evaluate(t1).status, STATUS.OK);

  d.addSamples(slices(t1, 60, { success: 0, total: 100 }));
  const t2 = t1 + 60 * SLICE;
  assert.equal(d.evaluate(t2).status, STATUS.FAST_BURN);

  const t3 = t2 + 2 * 3600;
  assert.equal(d.evaluate(t3).status, STATUS.UNKNOWN);

  d.addSamples(slices(t3, 360, { success: 100, total: 100 }));
  const t4 = t3 + 360 * SLICE;
  assert.equal(d.evaluate(t4).status, STATUS.OK);
});

test('预算消耗与瞬时燃烧率分开报告', () => {
  const d = makeDetector();
  d.addSamples(slices(BASE, 360, { success: 98, total: 100 }));
  const result = d.evaluate(BASE + 360 * SLICE);
  assert.ok(Math.abs(result.budget.burnRate - 2) < 1e-9);
  const expected = 2 * (6 * 3600) / (30 * 24 * 3600);
  assert.ok(Math.abs(result.budget.consumedFraction - expected) < 1e-9);
  assert.equal(result.budget.measuredWindow, 6 * 3600);
});

'use strict';

function aggregateServices(samplesByService) {
  if (!samplesByService || typeof samplesByService !== 'object') {
    throw new TypeError('samplesByService must be an object mapping service name to samples');
  }
  const merged = new Map();
  for (const [service, samples] of Object.entries(samplesByService)) {
    if (!Array.isArray(samples)) {
      throw new TypeError(`samples for service "${service}" must be an array`);
    }
    const seenIds = new Set();
    for (const sample of samples) {
      if (!sample || !Number.isFinite(sample.timestamp)) {
        throw new TypeError(`invalid sample for service "${service}"`);
      }
      if (sample.id !== undefined) {
        if (seenIds.has(sample.id)) continue;
        seenIds.add(sample.id);
      }
      const existing = merged.get(sample.timestamp) || { timestamp: sample.timestamp, success: 0, total: 0 };
      existing.success += sample.success;
      existing.total += sample.total;
      merged.set(sample.timestamp, existing);
    }
  }
  return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = { aggregateServices };

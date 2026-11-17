'use strict';

const { BurnRateDetector, STATUS, DEFAULT_WINDOWS, DEFAULT_BUDGET_PERIOD } = require('./src/detector');
const { aggregateServices } = require('./src/aggregate');

module.exports = {
  BurnRateDetector,
  STATUS,
  DEFAULT_WINDOWS,
  DEFAULT_BUDGET_PERIOD,
  aggregateServices,
};

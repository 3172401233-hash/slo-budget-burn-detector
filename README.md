# slo-budget-burn-detector

JavaScript SLO 错误预算燃烧检测库，处理多窗口、缺失样本和服务聚合。

## 安装与使用

```js
const { BurnRateDetector, aggregateServices } = require('./index');

const detector = new BurnRateDetector({
  sloTarget: 0.999,        // SLO 目标，错误预算 = 1 - sloTarget
  minSamples: 100,         // 窗口内最小请求数，不足则该窗口不可评估
  sliceInterval: 60,       // 时间片长度（秒）
  minCoverage: 0.5,        // 窗口内时间片最小覆盖率
  windows: [
    { name: 'fast', severity: 'fast_burn', longWindow: 3600,      shortWindow: 300,  threshold: 14.4 },
    { name: 'slow', severity: 'slow_burn', longWindow: 6 * 3600,  shortWindow: 3600, threshold: 6 },
  ],
});

detector.addSample({ timestamp: 1700000060, success: 998, total: 1000 });
const { status, windows, budget } = detector.evaluate(Date.now() / 1000);
// status: 'ok' | 'slow_burn' | 'fast_burn' | 'unknown'
```

多服务聚合：先按时间片合并再送入检测器。

```js
const merged = aggregateServices({ 'svc-a': samplesA, 'svc-b': samplesB });
detector.addSamples(merged);
```

## 公式

设时间片集合落在窗口 `W` 内，记 `S = Σ success`，`T = Σ total`：

- **错误率**：`errorRate(W) = (T - S) / T`（`T = 0` 时无定义，窗口不可评估）
- **错误预算**：`budget = 1 - sloTarget`
- **燃烧率**：`burnRate(W) = errorRate(W) / budget`
  - `burnRate = 1` 表示恰好按 30 天耗尽预算的速度出错
- **窗口预算消耗**（占整个预算周期的比例）：
  `consumed(W) = burnRate(W) × W / budgetPeriod`，`budgetPeriod` 默认 30 天
- **窗口可评估条件**（缺一不可）：
  - `T ≥ minSamples`（样本量足够，零请求不满足）
  - `覆盖率 = 实际时间片数 × sliceInterval / W ≥ minCoverage`（缺失样本过多则不可评估）

## 告警确认与状态

每组窗口由短窗口 + 长窗口构成，**短窗口必须结合长窗口确认**：

```
firing = burnRate(short) ≥ threshold AND burnRate(long) ≥ threshold
```

瞬时尖峰只推高短窗口，长窗口不确认，因此不会刷屏告警。状态优先级：

| 状态        | 含义                                       |
| ----------- | ------------------------------------------ |
| `fast_burn` | 至少一组 fast 窗口长短同时超标             |
| `slow_burn` | 无 fast 触发，至少一组 slow 窗口长短同时超标 |
| `ok`        | 至少一组窗口可评估且均未触发               |
| `unknown`   | 所有窗口均不可评估（无数据/零请求/样本不足/覆盖率不足） |

`unknown` 解决两类误报：

- **采样服务停止上报**：窗口内没有新数据，状态转为 `unknown` 而不是 `ok`，告警不会被误判为"恢复正常"。
- **零请求 / 冷启动**：错误率无定义，输出 `unknown` 而非正常的 `ok`。

瞬时燃烧率（每个窗口单独报告）与 30 天预算消耗（`budget.consumedFraction`，取最长可评估窗口）分开输出，避免把短时间错误率和长期预算使用率混在一起。

## 去重

- 相同 `timestamp` 的样本重复上报时后者覆盖前者，不重复计数。
- 携带 `id` 的样本按 `id` 去重，重复 `id` 直接忽略（`addSample` 返回 `false`）。
- `aggregateServices` 在每个服务内部按 `id` 去重后再按时间片求和。

## 默认窗口

参考 Google SRE 多窗口多燃烧率告警（SLO 99.9%、30 天预算）：

| 名称  | 长窗口 | 短窗口 | 阈值  | 含义                     |
| ----- | ------ | ------ | ----- | ------------------------ |
| fast  | 1h     | 5m     | 14.4  | 2% 预算/小时，需立即处理 |
| slow  | 6h     | 1h     | 6     | 持续消耗，需工单跟进     |

## 测试

```sh
node --test
```

覆盖：瞬时尖峰、持续故障、上游大面积中断、零请求、缺失样本、采样停止上报、最小样本量、服务聚合、重复指标去重、状态转换与预算消耗。

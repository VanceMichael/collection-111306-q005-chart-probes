import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  decimalPlaces,
  formatSummary,
  inferAxis,
  parseTooltip,
  rawArrayTokens,
  tipIsFresh,
  tooltipPrecision
} from '../src/observation.mjs';

const tip = (overrides = {}) => JSON.stringify({
  series: 's1',
  label: '出口温度',
  range: [0.5666666666666667, 0.7666666666666666],
  x: 100,
  value: 27,
  unit: '℃',
  revision: 3,
  view: 0,
  ...overrides
});

test('提示层原文保留页面显示的精度与区间', () => {
  const raw = '{"series":"s1","label":"a","range":[0.1000,0.2000],"x":10.50,"value":27.00,"unit":"℃","revision":2,"view":0}';
  const parsed = parseTooltip(raw);
  assert.equal(parsed.x, 10.5);
  assert.equal(parsed.xToken, '10.50');
  assert.equal(parsed.valueToken, '27.00');
  assert.deepEqual(parsed.range, [0.1, 0.2]);
  assert.deepEqual(tooltipPrecision(raw), { x: 2, value: 2, range: [4, 4] });
  assert.equal(decimalPlaces('1.5e-3'), 4);
});

test('同一区间只作为一条观测，不为每个鼠标位置造点', () => {
  const probes = [
    { n: 1, phase: '粗扫', seriesId: 's1', view: 0, fraction: 0.6, outcome: 'accepted', tip: parseTooltip(tip()) },
    { n: 2, phase: '缺口补测', seriesId: 's1', view: 0, fraction: 0.65, outcome: 'accepted', tip: parseTooltip(tip()) },
    { n: 3, phase: '缺口补测', seriesId: 's1', view: 0, fraction: 0.7, outcome: 'accepted', tip: parseTooltip(tip()) }
  ];
  const report = buildReport({ series: [{ id: 's1', label: '出口温度' }], probes, budget: { probeLimit: 10, interactionLimit: 2 } });
  const series = report.views[0].series[0];
  assert.equal(series.observations.length, 1);
  assert.deepEqual(series.observations[0].repeatProbes, [2, 3]);
  assert.equal(report.budget.probesUsed, 3);
  assert.equal(report.budget.remainingProbes, 7);
});

test('断点保持为无值观测并单独列为未知数值区间', () => {
  const probes = [{
    n: 1,
    phase: '粗扫',
    seriesId: 's1',
    view: 0,
    fraction: 0.65,
    outcome: 'accepted',
    tip: parseTooltip(tip({ value: null }))
  }];
  const report = buildReport({ series: [{ id: 's1', label: '出口温度' }], probes, budget: { probeLimit: 4, interactionLimit: 1 } });
  const series = report.views[0].series[0];
  assert.equal(series.observations[0].value, null);
  assert.equal(series.observations[0].valueKind, 'breakpoint');
  assert.equal(series.valueGaps.length, 1);
  assert.match(series.valueGaps[0].kind, /空值/);
  assert.ok(report.unknown.some(entry => entry.scope === 'value'));
});

test('未覆盖的横坐标区间不会被补点填充', () => {
  const probes = [
    { n: 1, phase: '粗扫', seriesId: 's1', view: 0, fraction: 0.02, outcome: 'accepted', tip: parseTooltip(tip({ range: [0, 0.1], x: 1, value: 20 })) },
    { n: 2, phase: '粗扫', seriesId: 's1', view: 0, fraction: 0.95, outcome: 'accepted', tip: parseTooltip(tip({ range: [0.9, 1], x: 1000, value: 31 })) }
  ];
  const report = buildReport({ series: [{ id: 's1', label: '出口温度' }], probes, budget: { probeLimit: 4, interactionLimit: 1 } });
  const series = report.views[0].series[0];
  assert.equal(series.observations.length, 2);
  assert.deepEqual(series.xGaps.map(gap => [gap.from, gap.to]), [[0.1, 0.9]]);
  assert.equal(series.observations.every(observation => observation.interpolated === false), true);
  assert.equal(report.observed.length, 2);
  assert.ok(report.unknown.some(entry => entry.scope === 'x'));
});

test('重名系列按身份分开，不按标签合并', () => {
  const probes = [
    { n: 1, phase: '粗扫', seriesId: 's1', view: 0, fraction: 0.3, outcome: 'accepted', tip: parseTooltip(tip({ series: 's1', value: 25 })) },
    { n: 2, phase: '粗扫', seriesId: 's2', view: 0, fraction: 0.3, outcome: 'accepted', tip: parseTooltip(tip({ series: 's2', value: 26 })) }
  ];
  const report = buildReport({
    series: [{ id: 's1', label: '出口温度' }, { id: 's2', label: '出口温度' }],
    probes,
    budget: { probeLimit: 4, interactionLimit: 2 }
  });
  assert.deepEqual(report.views[0].series.map(entry => entry.id), ['s1', 's2']);
  assert.deepEqual(report.views[0].series.map(entry => entry.observations[0].value), [25, 26]);
  assert.deepEqual(report.labelCollisions, [{ label: '出口温度', ids: ['s1', 's2'] }]);
  assert.equal(report.legend.every(entry => entry.duplicateLabel), true);
});

test('迟到提示按交互代次拒绝', () => {
  const fresh = parseTooltip(tip({ revision: 4 }));
  assert.equal(tipIsFresh(fresh, { revision: 4, view: 0 }).fresh, true);
  assert.equal(tipIsFresh(parseTooltip(tip({ revision: 3 })), { revision: 4, view: 0 }).fresh, false);
  assert.equal(tipIsFresh(parseTooltip(tip({ view: 1 })), { revision: 3, view: 0 }).fresh, false);
  assert.equal(tipIsFresh(parseTooltip(tip({ revision: undefined })), { revision: 3, view: 0 }).fresh, false);
});

test('迟到提示不会被写入任何系列', () => {
  const probes = [
    { n: 1, phase: '粗扫', seriesId: 's1', view: 0, fraction: 0.3, outcome: 'accepted', tip: parseTooltip(tip({ value: 25 })) },
    { n: 2, phase: '图例切换迟到提示校验', seriesId: 's1', view: null, fraction: 0.3, outcome: 'stale', reason: '交互代次不符（迟到提示）', tip: parseTooltip(tip({ revision: 2 })) }
  ];
  const report = buildReport({
    series: [{ id: 's1', label: '出口温度' }, { id: 's2', label: '出口温度' }],
    probes,
    budget: { probeLimit: 4, interactionLimit: 2 }
  });
  assert.equal(report.observed.length, 1);
  assert.equal(report.attempts[1].outcome, 'stale');
  assert.equal(report.attempts[1].observedRevision, 2);
});

test('横轴规律只从观测归纳，并区分对数与线性', () => {
  const logObservations = [0, 1000, 2000, 3000].map((x, index) => ({
    x,
    range: [index / 4, index / 4 + 0.2]
  })).filter(observation => observation.x > 0);
  const logAxis = inferAxis(logObservations.map(observation => ({
    x: observation.x,
    range: [0, 0]
  })));
  assert.equal(logAxis.kind, 'undetermined');
  const synthetic = (xs, centers) => xs.map((x, index) => ({ x, range: [centers[index] - 0.1, centers[index] + 0.1] }));
  const xs = [10, 100, 1000, 10000];
  const logCenters = xs.map(x => Math.log10(x) / 4);
  assert.equal(inferAxis(synthetic(xs, logCenters)).kind, 'logarithmic');
  const linearCenters = xs.map(x => x / 10000);
  assert.equal(inferAxis(synthetic(xs, linearCenters)).kind, 'linear');
  assert.match(inferAxis(synthetic(xs, logCenters)).basis, /不用于生成数据点/);
});

test('预算与阶段开销可被核对，未知区间有原因', () => {
  const probes = [
    { n: 1, phase: '粗扫', seriesId: 's1', view: 0, fraction: 0.02, outcome: 'accepted', tip: parseTooltip(tip({ range: [0, 0.1], x: 1, value: 20 })) },
    { n: 2, phase: '粗扫', seriesId: 's1', view: 0, fraction: 0.3, outcome: 'missing', reason: '等待提示层更新超时' },
    { n: 3, phase: '缺口补测', seriesId: 's1', view: 0, fraction: 0.5, outcome: 'accepted', repeated: true, tip: parseTooltip(tip()) }
  ];
  const report = buildReport({
    series: [{ id: 's1', label: '出口温度' }],
    probes,
    budget: {
      probeLimit: 3,
      interactionLimit: 2,
      interactionsUsed: 1,
      stopReason: '探测预算耗尽：未覆盖的区间保持未知'
    }
  });
  assert.equal(report.budget.exhausted, true);
  assert.equal(report.budget.remainingProbes, 0);
  assert.deepEqual(report.budget.phases.map(phase => [phase.phase, phase.probes, phase.accepted, phase.missing]),
    [['粗扫', 2, 1, 1], ['缺口补测', 1, 1, 0]]);
  assert.equal(report.budget.phases[1].duplicate, 1);
  assert.ok(report.unknown.length > 0);
  assert.match(formatSummary(report), /探测 3\/3/);
  assert.match(formatSummary(report), /仍未知/);
});

test('非对象的提示层内容被明确拒绝', () => {
  assert.equal(parseTooltip('null'), null);
  assert.equal(parseTooltip('[]'), null);
  assert.equal(parseTooltip(''), null);
  assert.equal(parseTooltip('{"series":"s1","range":[0,0]}').range, null);
  assert.deepEqual(rawArrayTokens('{"range": [0.1, 0.9]}', 'range'), ['0.1', '0.9']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startSource } from '../src/source.mjs';
import {
  CurveCollector,
  classifyTooltip,
  subtractIntervals,
  axisRange,
  axisHint,
  groupObservations,
} from '../src/collector.mjs';

const axis = { min: 1, max: 1000, scale: 'log' };

async function withPage(fn) {
  const source = await startSource();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(source.url);
    await page.waitForFunction(() => window.portalReady);
    return await fn(page);
  } finally {
    await browser.close();
    await source.close();
  }
}

test('提示层迟到判定按交互代次与视口代次分类', () => {
  const tip = { series: 's1', x: 10, value: 25, range: [0.2333, 0.4333], revision: 2, view: 0 };
  assert.equal(classifyTooltip(tip, { revision: 2, view: 0 }).ok, true);
  assert.match(classifyTooltip(tip, { revision: 3, view: 0 }).reason, /交互代次/);
  assert.match(classifyTooltip({ ...tip, view: 1 }, { revision: 2, view: 0 }).reason, /视口代次/);
  assert.match(classifyTooltip({ series: 's1' }, { revision: 2, view: 0 }).reason, /交互代次/);
  assert.match(classifyTooltip({ ...tip, range: null }, { revision: 2, view: 0 }).reason, /观测区间/);
  assert.match(classifyTooltip(null, { revision: 2, view: 0 }).reason, /不可解析/);
});

test('未知区间是已观测覆盖的补集', () => {
  assert.deepEqual(subtractIntervals([0, 1], [[0, 0.1], [0.2333, 0.4333]]), [[0.1, 0.2333], [0.4333, 1]]);
  assert.deepEqual(subtractIntervals([0, 1], [[-0.5, 2]]), []);
  assert.deepEqual(subtractIntervals([0, 1], []), [[0, 1]]);
});

test('非线性坐标按对数轴换算区间，不与线性混用', () => {
  const [lo, hi] = axisRange([1 / 3 - 0.1, 1 / 3 + 0.1], axis);
  assert.ok(Math.abs(lo - 10 ** 0.7) < 1e-6);
  assert.ok(Math.abs(hi - 10 ** 1.3) < 1e-6);
  const linear = axisRange([1 / 3 - 0.1, 1 / 3 + 0.1], { min: 1, max: 1000, scale: 'linear' });
  assert.ok(Math.abs(linear[0] - (1 + (1 / 3 - 0.1) * 999)) < 1e-6);
  assert.notEqual(lo, linear[0]);
  assert.equal(axisRange([0, 1], null), null);
});

test('横坐标取值形态提示区分等比与等差', () => {
  assert.match(axisHint([1000, 1, 100, 10, 10]).pattern, /对数/);
  assert.match(axisHint([1, 2, 3, 4]).pattern, /线性/);
  assert.match(axisHint([1, 2, 4, 8, 16, 32, 7]).pattern, /无明显/);
  assert.match(axisHint([5, 5]).pattern, /样本不足/);
});

test('相同提示归并为一组，断点保留空值而非插值', () => {
  const groups = groupObservations([
    { view: 0, fraction: 0.1875, x: 10, value: 25, unit: '℃', rangeFraction: [0.2333, 0.4333], rangeX: null, precisionFraction: 0.2 },
    { view: 0, fraction: 0.3125, x: 10, value: 25, unit: '℃', rangeFraction: [0.2333, 0.4333], rangeX: null, precisionFraction: 0.2 },
    { view: 0, fraction: 0.5625, x: 100, value: null, unit: '℃', rangeFraction: [0.5667, 0.7667], rangeX: null, precisionFraction: 0.2 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].fractions, [0.1875, 0.3125]);
  assert.equal(groups[1].breakpoint, true);
  assert.equal(groups[1].value, null);
});

test('采集器在断点、重名系列与非线性坐标图上产出有证据的观测与缺口，且可复跑', { timeout: 60000 }, async () => {
  const run = () => withPage(page => new CurveCollector(page, { budget: 40, axis }).collect());
  const first = await run();
  const second = await run();

  // 重名系列不按标签合并：两个图例标签相同，按提示层报告的系列身份分别记录
  assert.equal(first.series.length, 2);
  assert.deepEqual(first.series.map(s => s.id), ['s1', 's2']);
  for (const s of first.series) assert.deepEqual(s.labels, ['出口温度']);

  // 同一图复跑得到一致证据
  assert.deepEqual(first.series, second.series);
  assert.equal(first.budget.spent, second.budget.spent);

  const s1 = first.series[0];
  const view0 = s1.views.find(v => v.view === 0);
  // 实际观测值：断点是观测到的空值，不是缺口，也不插值
  assert.deepEqual(view0.groups.map(g => [g.x, g.value]), [[1, 20], [10, 25], [100, null], [1000, 31]]);
  assert.equal(view0.groups.find(g => g.x === 100).breakpoint, true);
  assert.ok(s1.observations.every(o => [1, 10, 100, 1000].includes(o.x)));
  // 单位与页面精度逐条记录
  assert.equal(s1.unit, '℃');
  assert.ok(s1.observations.every(o => o.unit === '℃' && typeof o.precisionFraction === 'number'));
  assert.ok(Math.abs(view0.groups[1].precisionFraction - 0.2) < 1e-6);
  // 横坐标区间：比例区间按对数轴换算，缺口保持未知
  const gap = view0.unknown[0];
  assert.deepEqual(gap.intervalFraction, [0.1, 0.233333]);
  assert.ok(Math.abs(gap.intervalX[0] - 10 ** 0.3) < 1e-3);
  assert.ok(Math.abs(gap.intervalX[1] - 10 ** 0.7) < 1e-3);
  assert.match(gap.reason, /精度/);
  assert.equal(view0.unknown.length, 3);
  // 缩放只验证一次且未细化，未无限缩放
  assert.ok(first.notes.some(n => n.includes('缩放未提供更细精度')));
  // 预算：总额受限、去向可查
  assert.ok(first.budget.spent <= first.budget.total);
  assert.equal(first.budget.byOp.legend + first.budget.byOp.probe + first.budget.byOp.zoom, first.budget.spent);
  assert.equal(first.budget.log.length, first.budget.spent);
  assert.equal(first.budget.byOp.zoom, 1);
  assert.equal(first.budget.remaining, first.budget.total - first.budget.spent);
  // 坐标形态提示来自观测证据
  assert.match(first.axisHint.pattern, /对数/);
  assert.equal(first.summary.complete, false);
  assert.ok(first.summary.unknownIntervals > 0);
});

test('图例切换中的迟到提示被丢弃而不混用', { timeout: 30000 }, async () => {
  await withPage(async page => {
    const collector = new CurveCollector(page, { budget: 20, axis });
    await collector.readLegend();
    await collector.selectSeries(0);
    await collector.hoverFraction(2 / 3);   // 该位置提示延迟约 180ms 才到
    await collector.selectSeries(1);        // 立即切换图例，s1 的提示随后才落地
    const stale = collector.discarded.find(d => d.tooltip.series === 's1');
    assert.ok(stale, '应丢弃 s1 迟到的提示');
    assert.match(stale.reason, /交互代次/);
    assert.equal(stale.tooltip.x, 100);
    // 迟到的 s1 断点空值不得记到任何系列，尤其不得记到刚选中的 s2
    const r = await collector.probeFraction(0.5625, 1);
    assert.equal(r.status, 'ok');
    assert.equal(r.observation.series, 's2');
    assert.equal(r.observation.value, 27);
    assert.equal(collector.seriesMap.has('s1'), false);
    const s2 = collector.seriesMap.get('s2');
    assert.ok(s2.observations.every(o => o.evidence.series === 's2'));
  });
});

test('预算耗尽时停止并解释缺口', { timeout: 30000 }, async () => {
  const result = await withPage(page => new CurveCollector(page, { budget: 5, axis }).collect());
  assert.ok(result.budget.spent <= 5);
  assert.equal(result.budget.byOp.zoom, 0);
  const s1 = result.series.find(s => s.id === 's1');
  assert.ok(s1.observations.length > 0);
  assert.ok(s1.observations.every(o => [1, 10].includes(o.x)), '预算内只观测到前两个分组，不补后面的点');
  assert.ok(s1.unknown.some(u => /预算耗尽/.test(u.reason)));
  const skipped = result.series.find(s => s.unprobed);
  assert.ok(skipped, '预算耗尽后未探测的图例项应保留为未知');
  assert.deepEqual(skipped.unknown[0].intervalFraction, [0, 1]);
  assert.match(skipped.unknown[0].reason, /预算耗尽/);
  assert.ok(result.notes.some(n => n.includes('预算')));
  assert.equal(result.summary.complete, false);
});

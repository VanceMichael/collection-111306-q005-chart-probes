import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startSource} from '../src/source.mjs';
import {collect} from '../src/collect.mjs';
import {buildReport} from '../src/observation.mjs';

async function withPortal(budget, run) {
  const source = await startSource();
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  try {
    await page.goto(source.url);
    await page.waitForFunction(() => window.portalReady);
    const result = await collect(page, {budget});
    const report = buildReport({
      series: result.series,
      probes: result.probes,
      budget: {...result.budget, phaseLog: result.phases},
      source: {kind: 'interactive-portal', url: source.url},
      generatedAt: new Date().toISOString()
    });
    report.races = result.races;
    return await run({report, result, page, source});
  } finally {
    await browser.close();
    await source.close();
  }
}

test('同一张含断点、重名系列和对数横轴的图可复跑并留下观测证据', {timeout: 20000}, async () => {
  await withPortal({}, async ({report, result, source}) => {
    // 采集来源只有可见交互，报告自身声明插值为零。
    assert.match(report.contract.readThrough, /图例/);
    assert.match(report.contract.interpolation, /无/);
    assert.deepEqual(report.legend.map(entry => entry.id), ['s1', 's2']);
    assert.equal(report.legend.every(entry => entry.duplicateLabel), true);
    assert.deepEqual(report.labelCollisions, [{label: '出口温度', ids: ['s1', 's2']}]);

    const view0 = report.views.find(view => view.view === 0);
    assert.ok(view0, '应观测到初始视图');
    const [s1, s2] = view0.series;
    assert.equal(s1.id, 's1');
    assert.equal(s2.id, 's2');

    // 重名系列没有被按标签合并，各自保留自己的观测值。
    assert.deepEqual(s1.observations.map(observation => observation.value), [20, 25, null, 31]);
    assert.deepEqual(s2.observations.map(observation => observation.value), [22, 26, 27, 30]);
    assert.equal(s1.units[0], '℃');
    assert.equal(s1.observations[0].unit, '℃');

    // 页面精度来自提示层原文 token，而不是重新格式化。
    for (const observation of [...s1.observations, ...s2.observations]) {
      assert.equal(observation.precision.x, 0, 'x 在页面显示为整数');
      assert.equal(observation.interpolated, false);
      assert.equal(observation.evidence.raw.includes('"range"'), true);
    }

    // 断点是真实空值，不是被跳过的点，也不被相邻值填补。
    const breakpoint = s1.observations.find(observation => observation.value === null);
    assert.equal(breakpoint.valueKind, 'breakpoint');
    assert.deepEqual(breakpoint.range, [0.5666666666666667, 0.7666666666666666]);
    assert.ok(s1.valueGaps.some(gap => gap.from === breakpoint.range[0] && gap.to === breakpoint.range[1]));
    assert.equal(s1.observations.length, 4);

    // 未覆盖区间明确为未知，不靠插值补齐。
    assert.equal(s1.xGaps.length, 3);
    assert.deepEqual(s1.xGaps.map(gap => [gap.from, gap.to]), [
      [0.1, 0.2333333333333333],
      [0.43333333333333335, 0.5666666666666667],
      [0.7666666666666666, 0.9]
    ]);
    assert.ok(report.unknown.filter(entry =>
      entry.scope === 'x' && entry.seriesId === 's1' && entry.view === 0).length === 3);

    // 横轴由观测归纳为对数，而不是假设。
    assert.equal(view0.axis.kind, 'logarithmic');
    assert.ok(view0.axis.logarithmicResidual < view0.axis.linearResidual);

    // 缩放后的视图单独记录，不并进视图 0。
    const view1 = report.views.find(view => view.view === 1);
    assert.ok(view1, '应观测到缩放后的视图');
    assert.equal(view1.series.every(entry => entry.xGaps.length > 0), true);

    // 迟到提示在切换与缩放两种交互下都被拒绝。
    assert.equal(result.races.legendSwitch.outcome, 'stale');
    assert.equal(result.races.legendSwitch.observedSeries, 's1');
    assert.equal(result.races.legendSwitch.observedRevision, result.races.legendSwitch.generationFloor);
    assert.equal(result.races.zoom.outcome, 'stale');
    assert.equal(result.races.zoom.arrivedAfterInteraction, true);
    assert.ok(report.attempts.every(attempt =>
      attempt.phase !== '图例切换迟到提示校验' || attempt.outcome !== 'accepted'));

    // 迟到提示没有混入任何系列的观测：每条观测的证据都必须指向一次被接受的探测。
    assert.equal(report.observed.every(observation => observation.evidence.revision !== null), true);
    for (const observation of report.observed) {
      const evidence = report.attempts.find(attempt => attempt.n === observation.evidence.probe);
      assert.ok(evidence, '观测必须带探测编号');
      assert.equal(evidence.outcome, 'accepted');
      assert.equal(evidence.range[0], observation.range[0]);
    }
    const staleAttempts = report.attempts.filter(attempt => attempt.outcome === 'stale');
    assert.ok(staleAttempts.length >= 2);
    assert.equal(staleAttempts.every(attempt => attempt.phase.includes('迟到')),
      true, '只有迟到校验阶段会被拒绝；其它阶段不应有迟到提示');

    // 观测数量等于被接受的不同 (系列, 视图, 区间) 数量，迟到提示没有贡献新点。
    const acceptedKeys = new Set(report.attempts
      .filter(attempt => attempt.outcome === 'accepted')
      .map(attempt => [attempt.seriesId, attempt.view,
        attempt.range.map(value => value.toFixed(12)).join('~')].join('|')));
    assert.equal(report.observed.length, acceptedKeys.size);

    // 页面观测与源端原始资料一致：测试用源端快照做外部核对，而非采集路径。
    const snapshot = await (await fetch(source.url + '/api/snapshot')).json();
    for (const series of snapshot.series) {
      for (const [x, value] of series.points) {
        const observed = report.observed.find(entry => entry.seriesId === series.id && entry.x === x);
        assert.ok(observed, `${series.id} 的 x=${x} 应被观测到`);
        assert.equal(observed.value, value);
      }
    }

    // 预算完整记录，所有已用探测都能在 attempts 中找到。
    assert.equal(report.budget.probesUsed, report.attempts.length);
    assert.equal(report.budget.probesUsed, result.probes.length);
    assert.ok(report.budget.remainingProbes >= 0);
    assert.ok(report.budget.phases.length >= 2);
    const accepted = report.attempts.filter(attempt => attempt.outcome === 'accepted').length;
    assert.equal(report.budget.phases.reduce((sum, phase) => sum + phase.accepted, 0), accepted);
    assert.equal(report.attempts[0].n, 1);

    // 交互预算也能逐条核对：每次图例切换或缩放都有记录。
    assert.equal(report.budget.interactionLog.length, report.budget.interactionsUsed);
    assert.deepEqual(report.budget.interactionLog.map(entry => entry.kind).filter(kind => kind === '缩放'), ['缩放']);

    // 每条尝试都带证据字段：鼠标位置、提示层原文、代次和时间关系。
    assert.equal(report.attempts.every(attempt =>
      attempt.fraction !== null && attempt.raw !== null && attempt.observedRevision !== null), true);
    assert.equal(report.attempts.filter(attempt => attempt.phase.includes('迟到'))
      .every(attempt => attempt.arrivedAfterInteraction === true), true);

    // 系列身份来自提示层报告值，图例项已被提示层确认。
    assert.deepEqual(result.series.filter(entry => entry.confirmedByTip).map(entry => entry.id), ['s1', 's2']);
    assert.equal(report.legend.every(entry => entry.confirmedByTip), true);
  });
});

test('重名系列的标签不参与归属，身份只看提示层', {timeout: 20000}, async () => {
  await withPortal({}, async ({report}) => {
    for (const observation of report.observed) {
      assert.equal(['s1', 's2'].includes(observation.seriesId), true);
      const evidence = report.attempts.find(attempt => attempt.n === observation.evidence.probe);
      assert.equal(evidence.observedSeries ?? evidence.seriesId, observation.seriesId);
    }
    // 两个同名系列拥有不同的观测值集合，说明没有被合并。
    const s1Values = report.observed.filter(entry => entry.seriesId === 's1').map(entry => entry.value);
    const s2Values = report.observed.filter(entry => entry.seriesId === 's2').map(entry => entry.value);
    assert.notDeepEqual(s1Values, s2Values);
    assert.ok(s1Values.includes(null));
    assert.equal(s2Values.includes(null), false);
  });
});

test('探测预算耗尽时停止并解释缺口', {timeout: 20000}, async () => {
  await withPortal({probeLimit: 6, interactionLimit: 3}, async ({report}) => {
    assert.equal(report.budget.probesUsed, 6);
    assert.equal(report.budget.exhausted, true);
    assert.match(report.budget.stopReason, /预算耗尽/);
    assert.ok(report.unknown.length > 0);
    assert.equal(report.views.every(view => view.series.some(entry => entry.xGaps.length > 0)), true);
    assert.equal(report.observed.every(observation => observation.interpolated === false), true);
  });
});

test('零预算不输出伪造的完整结果', {timeout: 20000}, async () => {
  await withPortal({probeLimit: 0, interactionLimit: 0}, async ({report}) => {
    assert.equal(report.observed.length, 0);
    assert.equal(report.budget.probesUsed, 0);
    assert.equal(report.budget.interactionsUsed, 0);
    assert.ok(report.unknown.length >= 2, '每个系列整段横轴都应列为未知');
    assert.equal(report.unknown.every(entry => entry.view === null && entry.scope === 'x'), true);
    assert.match(report.budget.stopReason, /预算耗尽/);
  });
});

test('缩放次数受限，不会为追求完整继续缩放', {timeout: 20000}, async () => {
  await withPortal({zoomLimit: 1}, async ({report}) => {
    assert.equal(report.budget.zoomsUsed, 1);
    const zooms = report.attempts.filter(attempt => attempt.phase === '缩放后确认');
    assert.ok(zooms.length > 0);
    assert.ok(report.views.length <= 2);
  });
});

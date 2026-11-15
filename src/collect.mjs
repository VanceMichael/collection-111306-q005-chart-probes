// 只用页面公开的交互读取曲线：点击可见图例、在图上移动鼠标、点击缩放按钮，
// 然后解析提示层。这里不读取任何页面数据接口。
import { parseTooltip, tipIsFresh } from './observation.mjs';

export const DEFAULT_BUDGET = Object.freeze({
  probeLimit: 32,
  interactionLimit: 8,
  zoomLimit: 1,
  refineRounds: 2,
  refinePerSeries: 3,
  coarseFractions: [0.02, 0.3, 0.65, 0.95],
  zoomFractions: [0.02, 0.95],
  tipTimeoutMs: 2500,
  lateWindowMs: 320
});

const EPSILON = 1e-9;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function uniqueRanges(observations) {
  const seen = new Map();
  for (const observation of observations) {
    if (!observation.range) continue;
    const key = observation.range.map(value => value.toFixed(12)).join('~');
    if (!seen.has(key)) seen.set(key, observation);
  }
  return [...seen.values()];
}

export function gapsFor(observations, span = [0, 1]) {
  const ranges = uniqueRanges(observations)
    .map(observation => [Math.max(span[0], observation.range[0]), Math.min(span[1], observation.range[1])])
    .filter(([from, to]) => to > from + EPSILON)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + EPSILON) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const gaps = [];
  let cursor = span[0];
  for (const [from, to] of merged) {
    if (from > cursor + EPSILON) gaps.push([cursor, from]);
    cursor = Math.max(cursor, to);
  }
  if (span[1] > cursor + EPSILON) gaps.push([cursor, span[1]]);
  return gaps;
}

export class ProbeSession {
  constructor(page, budget = {}) {
    this.page = page;
    this.configuration = { ...DEFAULT_BUDGET, ...budget };
    this.probes = [];
    this.probesUsed = 0;
    this.interactionsUsed = 0;
    this.zoomsUsed = 0;
    this.stopReason = null;
    this.box = null;
    this.legend = [];
    this.maxObservedRevision = null;
    this.lastFraction = null;
    this.seenObservations = new Set();
    // 系列身份从提示层报告值中发现（series id + label）；图例只用于点击。
    this.seriesSeen = new Map();
    // 每次交互都记账，让预算花在哪里可以逐条核对。
    this.interactionLog = [];
    // 代次：一次图例切换或缩放开启新代次。verified=false 时提示层还没有
    // 报告过新代次，只能用交互前观测到的最大代次作下界。
    this.generation = {
      verified: false,
      floor: null,
      revision: null,
      view: null,
      seriesId: null,
      legendIndex: null
    };
  }

  async attach() {
    await this.page.waitForFunction(() => window.portalReady === true);
    this.box = await this.page.locator('#plot').boundingBox();
    if (!this.box) throw new Error('图上没有可操作的绘图区');
    this.legend = await this.page.evaluate(() =>
      [...document.querySelectorAll('#legend button')].map((button, index) => ({
        index,
        // dataset 只是可见图例按钮上的标记；系列身份最终以提示层
        // 自己报告的 series 为准。
        declaredId: button.dataset.series ?? null,
        label: button.textContent
      })));
    await this.page.evaluate(() => {
      if (window.__tipObserverInstalled) return;
      const tip = document.querySelector('#tip');
      if (!tip) throw new Error('页面没有提示层');
      window.__tipLog = [];
      window.__tipSequence = 0;
      window.__tipObserverInstalled = true;
      new MutationObserver(() => {
        window.__tipSequence += 1;
        window.__tipLog.push({
          seq: window.__tipSequence,
          text: tip.textContent,
          at: performance.now()
        });
      }).observe(tip, { childList: true, characterData: true, subtree: true });
    });
    return this;
  }

  get remainingProbes() {
    return this.configuration.probeLimit - this.probesUsed;
  }

  get remainingInteractions() {
    return this.configuration.interactionLimit - this.interactionsUsed;
  }

  canProbe() {
    if (this.remainingProbes > 0) return true;
    this.stopReason ??= '探测预算耗尽：未覆盖的区间保持未知';
    return false;
  }

  canInteract() {
    if (this.remainingInteractions > 0) return true;
    this.stopReason ??= '交互预算耗尽：未覆盖的区间保持未知';
    return false;
  }

  coordinates(fraction) {
    const clamped = clamp(fraction, 0.005, 0.995);
    return {
      x: this.box.x + clamped * this.box.width,
      y: this.box.y + this.box.height / 2,
      fraction: clamped
    };
  }

  async beginProbe(fraction, phase) {
    if (!this.canProbe()) return null;
    let target = this.coordinates(fraction);
    if (this.lastFraction !== null && Math.abs(this.lastFraction - target.fraction) < 1e-6) {
      target = this.coordinates(target.fraction > 0.5 ? target.fraction - 0.0014 : target.fraction + 0.0014);
    }
    this.probesUsed += 1;
    const mark = await this.page.evaluate(() => window.__tipSequence);
    const startedAt = Date.now();
    await this.page.mouse.move(target.x, target.y);
    this.lastFraction = target.fraction;
    return {
      n: this.probesUsed,
      mark,
      startedAt,
      fraction,
      movedFraction: target.fraction,
      phase,
      legendIndex: this.generation.legendIndex
    };
  }

  async waitForUpdates(mark, { timeout = this.configuration.tipTimeoutMs, late = 0 } = {}) {
    try {
      await this.page.waitForFunction(
        value => window.__tipLog.some(entry => entry.seq > value),
        mark,
        { timeout, polling: 20 });
    } catch {
      return [];
    }
    if (late > 0) await this.page.waitForTimeout(late);
    return this.page.evaluate(value => window.__tipLog.filter(entry => entry.seq > value), mark);
  }

  verdict(tip, { seriesId }) {
    if (!tip) return { outcome: 'missing', reason: '提示层没有可解析的内容' };
    if (tip.series === null) {
      return { outcome: 'unusable', reason: '提示层没有报告系列身份，无法归属到任何系列' };
    }
    if (seriesId && tip.series !== seriesId) {
      return { outcome: 'stale', reason: '提示层系列与这次探测的图例选择不符（切换前后的迟到提示）' };
    }
    if (this.generation.seriesId && tip.series !== this.generation.seriesId) {
      return { outcome: 'stale', reason: '提示层系列与页面当前图例选择不符，不并入任何系列' };
    }
    if (tip.revision === null) {
      return { outcome: 'unusable', reason: '提示层没有报告交互代次，无法排除迟到提示' };
    }
    if (!this.generation.verified) {
      if (this.generation.floor !== null && tip.revision <= this.generation.floor) {
        return {
          outcome: 'stale',
          reason: '交互代次未超过交互前的最大代次（迟到提示）'
        };
      }
    } else {
      const fresh = tipIsFresh(tip, {
        revision: this.generation.revision,
        view: this.generation.view
      });
      if (!fresh.fresh) return { outcome: 'stale', reason: fresh.reason };
    }
    if (!tip.range) {
      return { outcome: 'unusable', reason: '提示层没有报告横坐标区间' };
    }
    return { outcome: 'accepted', reason: null };
  }

  acceptTip(tip) {
    if (!this.generation.verified) {
      this.generation.verified = true;
      this.generation.revision = tip.revision;
      this.generation.view = tip.view ?? null;
    } else if (this.generation.view === null) {
      this.generation.view = tip.view ?? null;
    }
  }

  record(handle, updates, { seriesId, phase, interactionAt = null }) {
    let chosen = null;
    let verdict = null;
    for (const update of updates) {
      const tip = parseTooltip(update.text);
      const candidate = this.verdict(tip, { seriesId });
      if (!chosen || (verdict.outcome !== 'accepted' && candidate.outcome === 'accepted')) {
        chosen = { update, tip };
        verdict = candidate;
      }
      if (candidate.outcome === 'accepted') break;
    }
    if (chosen?.tip?.revision !== null && chosen?.tip?.revision !== undefined &&
        Number.isInteger(chosen.tip.revision)) {
      this.maxObservedRevision = this.maxObservedRevision === null
        ? chosen.tip.revision
        : Math.max(this.maxObservedRevision, chosen.tip.revision);
    }
    if (!chosen) {
      verdict = { outcome: 'missing', reason: '等待提示层更新超时' };
    }
    const generation = this.generation;
    const record = {
      n: handle.n,
      // 预期身份来自这次点击的图例；观测身份只来自提示层。接受时以提示层为准。
      seriesId: seriesId ?? null,
      declaredSeriesId: seriesId ?? null,
      observedSeries: chosen?.tip?.series ?? null,
      legendIndex: handle.legendIndex ?? null,
      phase,
      fraction: handle.movedFraction,
      requestedFraction: handle.fraction,
      view: null,
      outcome: verdict.outcome,
      reason: verdict.reason,
      repeated: false,
      generationFloor: generation.verified ? generation.revision : generation.floor,
      generationFloorSource: generation.verified
        ? '本次交互已确认的代次'
        : generation.floor === null
          ? '采集开始时尚未观测到任何提示，无下界'
          : '交互前观测到的最大代次',
      waitMs: chosen ? Math.round(Date.now() - handle.startedAt) : null,
      tipAt: chosen?.update.at ?? null,
      interactionAt,
      arrivedAfterInteraction: chosen && interactionAt !== null ? chosen.update.at > interactionAt : null,
      tip: chosen?.tip ?? null,
      raw: chosen?.update.text ?? null,
      updateCount: updates.length
    };
    if (verdict.outcome === 'accepted') {
      this.acceptTip(chosen.tip);
      const view = this.generation.view;
      // 系列身份以提示层自己报告的 series 为准；图例按钮上的标记只是
      // 用来点击的入口，不能反过来覆盖观测到的身份。
      record.seriesId = chosen.tip.series;
      record.declaredSeriesId = seriesId ?? null;
      record.legendIndex = handle.legendIndex ?? this.generation.legendIndex ?? null;
      if (!this.seriesSeen.has(chosen.tip.series)) {
        this.seriesSeen.set(chosen.tip.series, {
          id: chosen.tip.series,
          label: chosen.tip.label,
          firstSeenBy: '提示层'
        });
      }
      const key = [chosen.tip.series, view, ...chosen.tip.range.map(value => value.toFixed(12))].join('|');
      record.repeated = this.seenObservations.has(key);
      this.seenObservations.add(key);
      record.view = view;
    }
    this.probes.push(record);
    return record;
  }

  async probe(fraction, { seriesId, phase }) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const handle = await this.beginProbe(attempt === 0 ? fraction : fraction + 0.0009, phase);
      if (!handle) return last;
      const updates = await this.waitForUpdates(handle.mark);
      last = this.record(handle, updates, { seriesId, phase });
      if (last.outcome === 'accepted') break;
    }
    return last;
  }

  async selectLegend(index) {
    const entry = this.legend[index];
    if (!entry) throw new Error('图例项不存在：' + index);
    if (!this.canInteract()) return { selected: false };
    this.interactionsUsed += 1;
    this.generation = {
      verified: false,
      floor: this.maxObservedRevision,
      revision: null,
      view: null,
      seriesId: entry.declaredId,
      legendIndex: index
    };
    await this.page.locator('#legend button').nth(index).click();
    this.interactionLog.push({ kind: '图例切换', legendIndex: index, label: entry.label, revisionFloor: this.generation.floor });
    return { selected: true, entry };
  }

  async zoom() {
    if (this.zoomsUsed >= this.configuration.zoomLimit) {
      this.stopReason ??= '缩放次数达到上限：不再为追求完整继续缩放';
      return { zoomed: false };
    }
    if (!this.canInteract()) return { zoomed: false };
    this.interactionsUsed += 1;
    this.zoomsUsed += 1;
    this.generation = {
      verified: false,
      floor: this.maxObservedRevision,
      revision: null,
      view: null,
      seriesId: this.generation.seriesId,
      legendIndex: this.generation.legendIndex
    };
    await this.page.locator('#zoom').click();
    this.interactionLog.push({ kind: '缩放', viewBefore: null, revisionFloor: this.generation.floor });
    return { zoomed: true };
  }

  acceptedFor(seriesId, view) {
    return this.probes.filter(probe => probe.outcome === 'accepted' &&
      probe.seriesId === seriesId && probe.view === view && probe.tip?.range);
  }

  observationsFor(seriesId, view) {
    return this.acceptedFor(seriesId, view)
      .map(probe => ({ range: probe.tip.range, x: probe.tip.x, value: probe.tip.value }));
  }

  distinctRangesFor(seriesId, view) {
    return uniqueRanges(this.observationsFor(seriesId, view));
  }

  gapsFor(seriesId, view) {
    return gapsFor(this.observationsFor(seriesId, view));
  }

  slowestAccepted(seriesId) {
    return this.probes
      .filter(probe => probe.outcome === 'accepted' && probe.seriesId === seriesId &&
        probe.tip?.range && probe.waitMs !== null)
      .sort((a, b) => b.waitMs - a.waitMs)[0] ?? null;
  }

  currentView() {
    return this.generation.view;
  }
}function midpoint(gap) {
  return (gap[0] + gap[1]) / 2;
}

function budgetSnapshot(session, extra = {}) {
  const { probeLimit, interactionLimit, zoomLimit } = session.configuration;
  return {
    probeLimit,
    interactionLimit,
    zoomLimit,
    probesUsed: session.probesUsed,
    interactionsUsed: session.interactionsUsed,
    zoomsUsed: session.zoomsUsed,
    remainingProbes: probeLimit - session.probesUsed,
    remainingInteractions: interactionLimit - session.interactionsUsed,
    interactionLog: session.interactionLog,
    stopReason: session.stopReason ?? '计划内的粗扫、缺口补测和一次缩放已完成；未覆盖区间保持未知',
    ...extra
  };
}

// 探测计划：每个可见图例项先粗扫四个已知位置，再在提示层从未覆盖的区间
// 中点补测，最多两轮；补测没有发现新观测就停止。之后做一次图例切换迟到
// 提示校验、一次缩放迟到提示校验和一次缩放后确认。所有步骤都受预算约束。
export async function collect(page, options = {}) {
  const session = new ProbeSession(page, options.budget ?? {});
  const phases = [];
  await session.attach();
  const { coarseFractions, zoomFractions, refineRounds, refinePerSeries } = session.configuration;
  const legend = session.legend;
  const races = {};

  if (legend.length === 0) {
    return {
      legend,
      probes: [],
      budget: budgetSnapshot(session, { stopReason: '页面没有可见图例，无法开始采集' }),
      races,
      phases
    };
  }

  for (const [index, entry] of legend.entries()) {
    // 没有探测预算时不再为新的系列消耗图例交互。
    if (!session.canProbe()) break;
    // 一次图例切换只发生在图例项真正改变时；上一段的迟到提示校验可能
    // 已经替这一段完成了切换，避免重复消耗交互预算。
    if (session.generation.legendIndex !== index) {
      if (!(await session.selectLegend(index)).selected) break;
    }
    for (const fraction of coarseFractions) {
      if (!session.canProbe()) break;
      await session.probe(fraction, { seriesId: entry.declaredId, phase: '粗扫' });
    }
    phases.push({ phase: '粗扫', legendIndex: index });

    for (let round = 0; round < refineRounds; round++) {
      if (!session.canProbe()) break;
      const view = session.currentView();
      const gaps = session.gapsFor(entry.declaredId, view)
        .filter(gap => gap[1] - gap[0] > 0.02)
        .slice(0, refinePerSeries);
      if (gaps.length === 0) break;
      let discovered = 0;
      for (const gap of gaps) {
        if (!session.canProbe()) break;
        // 只有出现新的提示层区间才算补测有效；落回已有区间说明该处被
        // 提示层量化为同一组值，补测也就没有意义。
        const before = session.distinctRangesFor(entry.declaredId, view).length;
        const record = await session.probe(midpoint(gap), {
          seriesId: entry.declaredId,
          phase: '缺口补测'
        });
        const after = session.distinctRangesFor(entry.declaredId, view).length;
        if (record?.outcome === 'accepted' && after > before) discovered += 1;
      }
      phases.push({ phase: '缺口补测', legendIndex: index, round, gapsTried: gaps.length, discovered });
      if (discovered === 0) {
        phases.push({
          phase: '缺口补测终止',
          legendIndex: index,
          round,
          reason: '补测没有再出现新的提示层区间，剩余空白是提示层自身未覆盖的区间'
        });
        break;
      }
    }

    // 图例切换迟到提示校验：在已知最慢的提示位置移动后立刻切换图例。
    // 仍在途中的提示会带着旧系列和旧代次到达，必须被拒绝。
    const next = legend[index + 1];
    if (next && session.remainingProbes >= 1 && session.remainingInteractions >= 1) {
      const slow = session.slowestAccepted(entry.declaredId);
      if (slow) {
        const handle = await session.beginProbe(
          (slow.tip.range[0] + slow.tip.range[1]) / 2,
          '图例切换迟到提示校验');
        const switched = await session.selectLegend(index + 1);
        if (handle && switched.selected) {
          const interactionAt = await page.evaluate(() => performance.now());
          const updates = await session.waitForUpdates(handle.mark, {
            late: session.configuration.lateWindowMs
          });
          const record = session.record(handle, updates, {
            seriesId: entry.declaredId,
            phase: '图例切换迟到提示校验',
            interactionAt
          });
          races.legendSwitch = {
            sourceSeries: slow.tip.series,
            nextDeclaredId: next.declaredId,
            fraction: record.fraction,
            sourceProbe: slow.n,
            outcome: record.outcome,
            reason: record.reason,
            generationFloor: record.generationFloor,
            observedSeries: record.tip?.series ?? null,
            observedRevision: record.tip?.revision ?? null,
            observedView: record.tip?.view ?? null,
            arrivedAfterInteraction: record.arrivedAfterInteraction
          };
          phases.push({ phase: '图例切换迟到提示校验', ...races.legendSwitch });
        } else if (handle) {
          // 交互没发生（预算在研究期间被判定不足）时，仍记下这次探测，
          // 避免已用探测数和逐条记录对不上；它不算迟到校验。
          const updates = await session.waitForUpdates(handle.mark);
          const record = session.record(handle, updates, {
            seriesId: entry.declaredId,
            phase: '未完成的迟到提示校验'
          });
          phases.push({
            phase: '未完成的迟到提示校验',
            kind: '图例切换',
            outcome: record.outcome,
            reason: '交互预算不足，未执行切换'
          });
        }
      }
    }
  }

  // 缩放本身也放在迟到提示校验里：先在最慢的提示区间移动，再点缩放，
  // 在途提示会带着旧代次/旧视图到达，必须被拒绝。
  const finalView = session.currentView();
  const finalIndex = session.generation.legendIndex;
  const finalEntry = legend[finalIndex];
  const slowest = finalEntry ? session.slowestAccepted(finalEntry.declaredId) : null;
  if (slowest && session.remainingProbes >= 1 && session.remainingInteractions >= 1 &&
      session.zoomsUsed < session.configuration.zoomLimit) {
    const handle = await session.beginProbe(
      (slowest.tip.range[0] + slowest.tip.range[1]) / 2,
      '缩放迟到提示校验');
    const zoomed = await session.zoom();
    if (handle && zoomed.zoomed) {
      const interactionAt = await page.evaluate(() => performance.now());
      const updates = await session.waitForUpdates(handle.mark, {
        late: session.configuration.lateWindowMs
      });
      const record = session.record(handle, updates, {
        seriesId: slowest.tip.series,
        phase: '缩放迟到提示校验',
        interactionAt
      });
      races.zoom = {
        sourceSeries: slowest.tip.series,
        sourceView: finalView,
        fraction: record.fraction,
        sourceProbe: slowest.n,
        outcome: record.outcome,
        reason: record.reason,
        generationFloor: record.generationFloor,
        observedRevision: record.tip?.revision ?? null,
        observedView: record.tip?.view ?? null,
        arrivedAfterInteraction: record.arrivedAfterInteraction
      };
      phases.push({ phase: '缩放迟到提示校验', ...races.zoom });
    } else if (handle) {
      const updates = await session.waitForUpdates(handle.mark);
      const record = session.record(handle, updates, {
        seriesId: slowest.tip.series,
        phase: '未完成的迟到提示校验'
      });
      phases.push({
        phase: '未完成的迟到提示校验',
        kind: '缩放',
        outcome: record.outcome,
        reason: '缩放预算不足，未执行缩放'
      });
    }
  }

  // 缩放后的视图单独采样；它不能和缩放前的观测混在一起。
  if (session.zoomsUsed > 0) {
    for (const [index, entry] of legend.entries()) {
      if (!session.canProbe()) break;
      if (session.generation.legendIndex !== index) {
        if (!(await session.selectLegend(index)).selected) break;
      }
      for (const fraction of zoomFractions) {
        if (!session.canProbe()) break;
        await session.probe(fraction, { seriesId: entry.declaredId, phase: '缩放后确认' });
      }
      phases.push({ phase: '缩放后确认', legendIndex: index });
    }
  }

  // 系列清单只来自提示层实际报告的身份；没被提示层确认的图例项不会被编造，
  // 但会作为“未确认来源”保留，让它的整段横轴出现在未知清单里。
  const series = [...session.seriesSeen.values()].map(entry => ({...entry, confirmedByTip: true}));
  const confirmed = new Set(series.map(entry => entry.id));
  for (const entry of legend) {
    if (entry.declaredId !== null && confirmed.has(entry.declaredId)) continue;
    series.push({
      id: entry.declaredId,
      label: entry.label,
      confirmedByTip: false,
      reason: entry.declaredId === null
        ? '图例按钮没有可用的系列标记，提示层也从未报告该系列'
        : '该图例项从未被提示层确认'
    });
  }
  return {
    legend,
    series,
    probes: session.probes,
    budget: budgetSnapshot(session, { phaseLog: phases }),
    races,
    phases
  };
}

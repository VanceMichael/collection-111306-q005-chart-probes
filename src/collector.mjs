import { axisValue } from './domain.mjs';

// 曲线观测采集器
// 只用页面正常的鼠标、图例与缩放操作读取提示层，把每次读数作为证据记录；
// 不调用页面未公开的数据接口，不插值补成没见过的点，不为追求完整无限缩放。

export const DEFAULTS = {
  budget: 40,           // 探测操作总预算：图例点击、鼠标探测、缩放点击各计 1 次
  samplesPerSeries: 8,  // 每个系列每个视口的横向采样点数
  settleMs: 300,        // 图例/缩放后等待迟到提示落定的时间，需大于页面最大提示延迟
  probeTimeoutMs: 2000, // 单次探测等待提示的上限
  maxZooms: 2,          // 缩放探索上限
  axis: null,           // 操作员从图面刻度读取的坐标轴 {min,max,scale:'linear'|'log'}，无则只记比例区间
  plotSelector: '#plot',
  tipSelector: '#tip',
  legendSelector: '#legend button',
  zoomSelector: '#zoom',
};

const round6 = value => Math.round(value * 1e6) / 1e6;

// 提示层迟到判定：交互代次（图例/缩放操作数）与视口代次必须与当前状态一致，
// 否则是上一状态遗留的迟到提示，不能当作当前系列/当前视口的读数。
export function classifyTooltip(tooltip, expected) {
  if (!tooltip || typeof tooltip !== 'object') return { ok: false, reason: '提示为空或不可解析' };
  if (!Number.isInteger(tooltip.revision)) return { ok: false, reason: '提示缺少交互代次' };
  if (tooltip.revision !== expected.revision) return { ok: false, reason: '迟到提示（交互代次不符）' };
  if (!Number.isInteger(tooltip.view)) return { ok: false, reason: '提示缺少视口代次' };
  if (tooltip.view !== expected.view) return { ok: false, reason: '迟到提示（视口代次不符）' };
  if (!Array.isArray(tooltip.range) || tooltip.range.length !== 2) return { ok: false, reason: '提示缺少观测区间' };
  return { ok: true };
}

// base 中未被任何已观测区间覆盖的部分，即仍未知的区间。
export function subtractIntervals(base, covered) {
  const sorted = covered
    .map(([lo, hi]) => [Math.max(base[0], lo), Math.min(base[1], hi)])
    .filter(([lo, hi]) => hi > lo)
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = base[0];
  for (const [lo, hi] of sorted) {
    if (lo > cursor) gaps.push([cursor, lo]);
    cursor = Math.max(cursor, hi);
  }
  if (cursor < base[1]) gaps.push([cursor, base[1]]);
  return gaps.filter(([lo, hi]) => hi - lo > 1e-9).map(([lo, hi]) => [round6(lo), round6(hi)]);
}

// 页面报告的横坐标比例区间换算为坐标值区间（线性或对数轴）；无坐标配置时只保留比例。
export function axisRange(rangeFraction, axis) {
  if (!axis) return null;
  const logarithmic = axis.scale === 'log';
  return [
    round6(axisValue(rangeFraction[0], axis.min, axis.max, logarithmic)),
    round6(axisValue(rangeFraction[1], axis.min, axis.max, logarithmic)),
  ];
}

// 观测到的横坐标取值形态提示（等比→对数轴特征，等差→线性轴特征），仅记录观测事实。
export function axisHint(xs) {
  const values = [...new Set(xs)].sort((a, b) => a - b);
  if (values.length < 3) return { values, pattern: '样本不足，无法判断坐标形态' };
  const diffs = values.slice(1).map((v, i) => v - values[i]);
  const arithmetic = diffs.every(d => Math.abs(d - diffs[0]) <= 1e-9 * Math.max(1, Math.abs(diffs[0])));
  const ratios = values.every(v => v > 0) ? values.slice(1).map((v, i) => v / values[i]) : null;
  const geometric = ratios ? ratios.every(r => Math.abs(r - ratios[0]) <= 1e-9 * ratios[0]) : false;
  if (geometric) return { values, pattern: '等比序列，符合对数轴特征' };
  if (arithmetic) return { values, pattern: '等差序列，符合线性轴特征' };
  return { values, pattern: '无明显等差或等比规律' };
}

// 相邻探测得到完全相同的提示（同 x、同值、同区间）时归并为一组并保留各自探测位置；
// 空值断点原样保留，不向未知区间插值。
export function groupObservations(observations) {
  const groups = [];
  for (const o of observations) {
    const last = groups[groups.length - 1];
    if (last && last.x === o.x
        && JSON.stringify(last.value) === JSON.stringify(o.value)
        && JSON.stringify(last.rangeFraction) === JSON.stringify(o.rangeFraction)) {
      last.fractions.push(o.fraction);
    } else {
      groups.push({
        view: o.view, x: o.x, value: o.value, unit: o.unit,
        rangeFraction: o.rangeFraction, rangeX: o.rangeX,
        precisionFraction: o.precisionFraction, fractions: [o.fraction],
        breakpoint: o.value === null,
      });
    }
  }
  return groups;
}

export class CurveCollector {
  constructor(page, options = {}) {
    this.page = page;
    this.opt = { ...DEFAULTS, ...options };
    this.actionCount = 0; // 已执行的图例/缩放操作数，对应提示层交互代次
    this.zoomCount = 0;   // 已执行的缩放次数，对应提示层视口代次
    this.spent = 0;
    this.opLog = [];
    this.discarded = [];
    this.failedProbes = [];
    this.notes = [];
    this.legend = [];
    this.seriesOrder = [];
    this.seriesMap = new Map();
    this.validatedTexts = new Set(); // 当前代次/视口中已确认为“本次探测新响应”的提示文本
    this.zoomRefined = null;         // null 未验证 / false 缩放未细化 / true 缩放有细化
  }

  get remaining() { return this.opt.budget - this.spent; }

  #spend(op, detail = {}) {
    if (this.spent >= this.opt.budget) return null;
    this.spent += 1;
    const entry = { seq: this.spent, op, ...detail };
    this.opLog.push(entry);
    return entry;
  }

  async #readTip() {
    const text = await this.page.locator(this.opt.tipSelector).textContent();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  #expect() { return { revision: this.actionCount, view: this.zoomCount }; }

  #discardOnce(seen, tooltip, verdict) {
    const key = JSON.stringify(tooltip);
    if (seen.has(key)) return;
    seen.add(key);
    this.discarded.push({ reason: verdict.reason, tooltip, expected: this.#expect() });
  }

  // 图例或缩放操作之后，等待并丢弃上一状态迟到的提示，不与新状态混用。
  async settle() {
    const deadline = Date.now() + this.opt.settleMs;
    const seen = new Set();
    while (Date.now() < deadline) {
      const tooltip = await this.#readTip();
      if (tooltip) {
        const verdict = classifyTooltip(tooltip, this.#expect());
        if (!verdict.ok) this.#discardOnce(seen, tooltip, verdict);
      }
      await this.page.waitForTimeout(25);
    }
  }

  async readLegend() {
    const labels = await this.page.locator(this.opt.legendSelector).allTextContents();
    this.legend = labels.map((label, ordinal) => ({ ordinal, label }));
    return this.legend;
  }

  async selectSeries(ordinal) {
    const entry = this.#spend('legend', { ordinal, label: this.legend[ordinal]?.label ?? null });
    if (!entry) return false;
    await this.page.locator(this.opt.legendSelector).nth(ordinal).click();
    this.actionCount += 1;
    this.validatedTexts.clear();
    await this.settle();
    entry.outcome = 'ok';
    return true;
  }

  // 只移动鼠标不等待读数：用于构造迟到提示场景，正常采集走 probeFraction。
  async hoverFraction(fraction) {
    const box = await this.page.locator(this.opt.plotSelector).boundingBox();
    await this.page.mouse.move(box.x + fraction * box.width, box.y + box.height / 2);
  }

  async zoom() {
    const entry = this.#spend('zoom', { toView: this.zoomCount + 1 });
    if (!entry) return false;
    await this.page.locator(this.opt.zoomSelector).click();
    this.actionCount += 1;
    this.zoomCount += 1;
    this.validatedTexts.clear();
    await this.settle();
    entry.outcome = 'ok';
    return true;
  }

  #seriesFor(tooltip, ordinal) {
    const id = tooltip.series ?? `#未命名${ordinal}`;
    if (!this.seriesMap.has(id)) {
      this.seriesMap.set(id, { id, labels: [], unit: tooltip.unit ?? null, ordinals: [], observations: [], views: [], unknown: [] });
      this.seriesOrder.push(id);
    }
    const record = this.seriesMap.get(id);
    if (tooltip.label && !record.labels.includes(tooltip.label)) record.labels.push(tooltip.label);
    if (!record.ordinals.includes(ordinal)) record.ordinals.push(ordinal);
    if (!record.unit && tooltip.unit) record.unit = tooltip.unit;
    return record;
  }

  // 单次探测：移动鼠标并等待属于当前代次/视口的提示。
  // 文本变化即为本次探测的响应；文本不变时，只有该提示此前已在本代次被验证为响应、
  // 且等待已超过页面最大提示延迟，才按“同一区间归并显示”接受，避免把上一位置的残留读数记到本位置。
  async probeFraction(fraction, ordinal) {
    const entry = this.#spend('probe', { ordinal, fraction: round6(fraction), view: this.zoomCount });
    if (!entry) return { status: 'budget' };
    const baseline = await this.#readTip();
    const baselineText = baseline ? JSON.stringify(baseline) : null;
    await this.hoverFraction(fraction);
    const movedAt = Date.now();
    const deadline = movedAt + this.opt.probeTimeoutMs;
    const seen = new Set();
    while (Date.now() < deadline) {
      const tooltip = await this.#readTip();
      if (tooltip) {
        const verdict = classifyTooltip(tooltip, this.#expect());
        if (!verdict.ok) {
          this.#discardOnce(seen, tooltip, verdict);
        } else {
          const text = JSON.stringify(tooltip);
          const fresh = text !== baselineText;
          if (fresh || (this.validatedTexts.has(text) && Date.now() - movedAt >= this.opt.settleMs)) {
            if (fresh) this.validatedTexts.add(text);
            const record = this.#seriesFor(tooltip, ordinal);
            const observation = {
              view: this.zoomCount,
              fraction: round6(fraction),
              series: record.id,
              x: tooltip.x,
              value: tooltip.value ?? null,
              unit: tooltip.unit ?? null,
              rangeFraction: tooltip.range,
              rangeX: axisRange(tooltip.range, this.opt.axis),
              precisionFraction: round6(tooltip.range[1] - tooltip.range[0]),
              revision: tooltip.revision,
              evidence: tooltip,
            };
            record.observations.push(observation);
            entry.outcome = fresh ? 'ok' : 'ok-同组重复';
            return { status: 'ok', observation };
          }
        }
      }
      await this.page.waitForTimeout(20);
    }
    entry.outcome = '提示等待超时';
    this.failedProbes.push({ ordinal, fraction: round6(fraction), view: this.zoomCount, reason: '提示等待超时' });
    return { status: 'timeout' };
  }

  gridFractions() {
    const n = this.opt.samplesPerSeries;
    return Array.from({ length: n }, (_, i) => (i + 0.5) / n);
  }

  #lastSeriesId(ordinal) {
    for (const [id, record] of this.seriesMap) {
      if (!record.unprobed && record.ordinals.includes(ordinal)) return id;
    }
    return null;
  }

  #markUnprobed(ordinal) {
    const id = `未探测#${ordinal}`;
    if (this.seriesMap.has(id)) return;
    const label = this.legend[ordinal]?.label ?? null;
    this.seriesMap.set(id, {
      id, labels: label ? [label] : [], unit: null, ordinals: [ordinal],
      observations: [], views: [], unprobed: true,
      unknown: [{ view: null, intervalFraction: [0, 1], intervalX: axisRange([0, 1], this.opt.axis), reason: '预算耗尽，未探测' }],
    });
    this.seriesOrder.push(id);
  }

  #signature(id, view) {
    const record = this.seriesMap.get(id);
    if (!record) return null;
    const set = new Set(record.observations.filter(o => o.view === view)
      .map(o => `${o.x}|${JSON.stringify(o.value)}|${o.precisionFraction}`));
    return JSON.stringify([...set].sort());
  }

  // 缩放探索：每次缩放后重测当前系列，若分组精度没有变化就停止；
  // 次数与预算双重上限，不为追求完整无限缩放。
  async #zoomPhase(ordinal, seriesId) {
    if (ordinal === null || !seriesId) return;
    while (this.zoomCount < this.opt.maxZooms) {
      if (this.remaining < 1 + this.opt.samplesPerSeries) {
        this.notes.push('预算不足以做缩放验证，停止缩放探索');
        return;
      }
      const before = this.#signature(seriesId, this.zoomCount);
      if (!(await this.zoom())) { this.notes.push('预算耗尽，停止缩放探索'); return; }
      for (const fraction of this.gridFractions()) {
        const r = await this.probeFraction(fraction, ordinal);
        if (r.status === 'budget') break;
      }
      const after = this.#signature(seriesId, this.zoomCount);
      if (before === after) {
        this.zoomRefined = false;
        this.notes.push(`视口 ${this.zoomCount} 的分组与上一视口一致：缩放未提供更细精度，停止缩放`);
        return;
      }
      this.zoomRefined = true;
      this.notes.push(`视口 ${this.zoomCount} 的分组发生变化，继续观察`);
    }
    this.notes.push(`已达缩放上限 ${this.opt.maxZooms} 次：不为追求完整无限缩放`);
  }

  async collect() {
    await this.readLegend();
    let lastOrdinal = null;
    let lastId = null;
    for (let ordinal = 0; ordinal < this.legend.length; ordinal++) {
      if (!(await this.selectSeries(ordinal))) { this.#markUnprobed(ordinal); continue; }
      lastOrdinal = ordinal;
      for (const fraction of this.gridFractions()) {
        const r = await this.probeFraction(fraction, ordinal);
        if (r.status === 'budget') {
          this.notes.push(`预算耗尽：图例第 ${ordinal} 项的横向探测中断，其余位置未探测`);
          break;
        }
      }
      lastId = this.#lastSeriesId(ordinal) ?? lastId;
    }
    await this.#zoomPhase(lastOrdinal, lastId);
    this.#finalize();
    return this.result();
  }

  #finalize() {
    const gapNote = this.zoomRefined === false
      ? '页面分组精度间隙（缩放后精度未变化）'
      : this.zoomRefined === true
        ? '页面分组精度间隙（已达缩放上限）'
        : '页面分组精度间隙（缩放未验证）';
    for (const record of this.seriesMap.values()) {
      if (record.unprobed) continue;
      const views = [...new Set(record.observations.map(o => o.view))].sort((a, b) => a - b);
      record.views = views.map(view => {
        const obs = record.observations.filter(o => o.view === view);
        const fractions = obs.map(o => o.fraction);
        const span = [Math.min(...fractions), Math.max(...fractions)];
        const groups = groupObservations(obs);
        const failed = this.failedProbes
          .filter(f => f.view === view && record.ordinals.includes(f.ordinal))
          .map(f => f.fraction);
        const unknown = subtractIntervals([0, 1], obs.map(o => o.rangeFraction)).map(([lo, hi]) => {
          const mid = (lo + hi) / 2;
          let reason;
          if (failed.some(f => f >= lo && f <= hi)) reason = '提示等待超时，未获得读数';
          else if (mid < span[0] || mid > span[1]) reason = '预算耗尽，未探测';
          else reason = gapNote;
          return { view, intervalFraction: [lo, hi], intervalX: axisRange([lo, hi], this.opt.axis), reason };
        });
        const breaks = groups.filter(g => g.breakpoint).length;
        this.notes.push(`系列 ${record.id} 视口 ${view}：提示层归并为 ${groups.length} 组${breaks ? `，含 ${breaks} 个断点` : ''}`);
        return { view, probedFractions: fractions, groups, unknown };
      });
      record.unknown = record.views.flatMap(v => v.unknown);
    }
  }

  result() {
    const byOp = { legend: 0, probe: 0, zoom: 0 };
    for (const entry of this.opLog) byOp[entry.op] = (byOp[entry.op] ?? 0) + 1;
    const series = this.seriesOrder.map(id => {
      const r = this.seriesMap.get(id);
      return {
        id,
        label: r.labels[0] ?? null,
        labels: r.labels,
        unit: r.unit,
        ordinals: r.ordinals,
        ...(r.unprobed ? { unprobed: true } : {}),
        observations: r.observations,
        views: r.views,
        unknown: r.unknown,
      };
    });
    const allX = series.flatMap(s => s.observations.map(o => o.x)).filter(v => typeof v === 'number');
    const unknownCount = series.reduce((n, s) => n + s.unknown.length, 0);
    const breakpoints = series.flatMap(s => s.views).flatMap(v => v.groups ?? []).filter(g => g.breakpoint).length;
    return {
      kind: 'chart-probes/collection',
      at: new Date().toISOString(),
      pageUrl: this.page.url(),
      options: {
        budget: this.opt.budget,
        samplesPerSeries: this.opt.samplesPerSeries,
        settleMs: this.opt.settleMs,
        probeTimeoutMs: this.opt.probeTimeoutMs,
        maxZooms: this.opt.maxZooms,
      },
      axis: this.opt.axis ?? null,
      axisHint: axisHint(allX),
      legend: this.legend,
      budget: { total: this.opt.budget, spent: this.spent, remaining: this.remaining, byOp, log: this.opLog },
      series,
      discarded: this.discarded,
      failedProbes: this.failedProbes,
      notes: this.notes,
      summary: {
        seriesCount: series.length,
        observations: series.reduce((n, s) => n + s.observations.length, 0),
        breakpoints,
        unknownIntervals: unknownCount,
        discardedLateTips: this.discarded.length,
        complete: unknownCount === 0 && this.failedProbes.length === 0,
      },
    };
  }
}

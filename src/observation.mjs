// 提示层观测的纯逻辑。这里只整理页面实际显示过的内容，从不插值，
// 也不把没有出现在提示层里的点补进结果。

const EPSILON = 1e-9;
const NUMBER_TOKEN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keyStart(text, key) {
  const expression = new RegExp('"' + escapeRegExp(key) + '"\\s*:\\s*');
  const match = expression.exec(text);
  return match ? match.index + match[0].length : -1;
}

// 取数字在提示层原文中的 token，而不是重新序列化后的数字。
// 页面显示的 trailing zero、超长小数等精度信息只能从原文得到。
export function rawNumberToken(text, key) {
  const start = keyStart(text, key);
  if (start < 0) return null;
  const match = NUMBER_TOKEN.exec(text.slice(start));
  return match ? match[0] : null;
}

export function rawArrayTokens(text, key) {
  let index = keyStart(text, key);
  if (index < 0 || text[index] !== '[') return null;
  index += 1;
  const tokens = [];
  while (index < text.length && text[index] !== ']') {
    index += /^\s*,?\s*/.exec(text.slice(index))[0].length;
    if (text[index] === ']') break;
    const match = NUMBER_TOKEN.exec(text.slice(index));
    if (!match) return null;
    tokens.push(match[0]);
    index += match[0].length;
  }
  return tokens;
}

export function decimalPlaces(token) {
  if (token === null || token === undefined) return null;
  const text = String(token).trim();
  if (text === '' || text === 'null') return null;
  const [mantissa, exponent] = text.split(/[eE]/);
  const dot = mantissa.indexOf('.');
  const fraction = dot < 0 ? 0 : mantissa.length - dot - 1;
  if (exponent === undefined) return fraction;
  const power = Number(exponent);
  if (!Number.isFinite(power)) return null;
  return Math.max(0, fraction - power);
}

// 提示层可能只显示最近一条系列。series 是身份，label 只是显示文本；
// 重名系列必须靠 series 区分，缺 id 时只能作为无法归属的观测保留。
export function parseTooltip(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const generation = data.generation && typeof data.generation === 'object' ? data.generation : {};
  const rangeTokens = rawArrayTokens(raw, 'range') ?? rawArrayTokens(raw, 'interval');
  const range = Array.isArray(rangeTokens)
    ? rangeTokens.filter(token => token !== 'null').map(Number).filter(Number.isFinite)
    : [];
  const valueToken = rawNumberToken(raw, 'value');
  const valuePresent = valueToken !== null || /"value"\s*:\s*null/.test(raw);
  const xToken = rawNumberToken(raw, 'x');
  const revision = data.revision ?? generation.revision ?? null;
  const view = data.view ?? generation.view ?? null;
  return {
    raw,
    series: typeof data.series === 'string' || typeof data.series === 'number' ? String(data.series) : null,
    label: typeof data.label === 'string' ? data.label : null,
    unit: typeof data.unit === 'string' ? data.unit : null,
    range: range.length === 2 && range[0] < range[1] ? range : null,
    xToken,
    x: xToken === null ? null : Number(xToken),
    valueToken,
    value: valueToken === null ? null : Number(valueToken),
    valuePresent,
    revision: Number.isInteger(revision) ? revision : null,
    view: Number.isInteger(view) ? view : null
  };
}

export function tooltipPrecision(raw) {
  const rangeTokens = rawArrayTokens(raw, 'range') ?? rawArrayTokens(raw, 'interval');
  return {
    x: decimalPlaces(rawNumberToken(raw, 'x')),
    value: decimalPlaces(rawNumberToken(raw, 'value')),
    range: Array.isArray(rangeTokens) ? rangeTokens.map(decimalPlaces) : null
  };
}

// 迟到提示的判定只看提示层自己报告的交互代次。交互代次由页面在每次
// 图例切换或缩放时前进；只有与本次交互一致才接受。
export function tipIsFresh(tip, { revision, view }) {
  if (!tip) return { fresh: false, reason: '提示无法解析' };
  if (tip.revision === null) return { fresh: false, reason: '提示未报告交互代次' };
  if (tip.revision !== revision) return { fresh: false, reason: '交互代次不符（迟到提示）' };
  if (view !== null && view !== undefined && tip.view !== null && tip.view !== view) {
    return { fresh: false, reason: '视图代次不符（迟到提示）' };
  }
  return { fresh: true };
}

function cover(intervals, from, to) {
  const ordered = intervals
    .map(([start, end]) => [Math.max(from, start), Math.min(to, end)])
    .filter(([start, end]) => end > start + EPSILON)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const interval of ordered) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1] + EPSILON) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const gaps = [];
  let cursor = from;
  for (const [start, end] of merged) {
    if (start > cursor + EPSILON) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (to > cursor + EPSILON) gaps.push([cursor, to]);
  return { merged, gaps };
}

// 用提示层自己报告的区间中心与 x 判断横轴规律。
// 这只能说明“观测到的 (区间中心, x) 更像哪种映射”，不能用来生成点。
export function inferAxis(observations) {
  const grouped = new Map();
  for (const observation of observations) {
    if (observation.x === null || !observation.range) continue;
    const center = (observation.range[0] + observation.range[1]) / 2;
    if (!grouped.has(observation.x)) grouped.set(observation.x, []);
    grouped.get(observation.x).push(center);
  }
  const points = [...grouped.entries()]
    .map(([x, centers]) => ({ x, center: centers.reduce((sum, value) => sum + value, 0) / centers.length }))
    .sort((a, b) => a.x - b.x);
  const base = {
    kind: 'undetermined',
    basis: '仅由提示层报告的 (区间中心, x) 归纳，不用于生成数据点。',
    points
  };
  if (points.length < 3) {
    return { ...base, reason: '不同的 x 少于三个，无法比较线性与对数映射。' };
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first.x > 0) || !(last.x > first.x)) {
    return { ...base, reason: 'x 不构成正数递增序列。' };
  }
  const linearAt = x => first.center + ((x - first.x) / (last.x - first.x)) * (last.center - first.center);
  const logarithmicAt = x => first.center +
    (Math.log(x / first.x) / Math.log(last.x / first.x)) * (last.center - first.center);
  const interior = points.slice(1, -1);
  const residual = predict => interior.reduce((sum, point) => sum + Math.abs(predict(point.x) - point.center), 0) / interior.length;
  const linearResidual = residual(linearAt);
  const logarithmicResidual = residual(logarithmicAt);
  let kind = 'undetermined';
  let reason = '两种映射的残差接近，观测不足以区分。';
  if (logarithmicResidual * 2 < linearResidual) {
    kind = 'logarithmic';
    reason = '对数映射的残差明显更小。';
  } else if (linearResidual * 2 < logarithmicResidual) {
    kind = 'linear';
    reason = '线性映射的残差明显更小。';
  }
  return {
    ...base,
    kind,
    reason,
    linearResidual,
    logarithmicResidual,
    endpoints: { x: [first.x, last.x], center: [first.center, last.center] },
    quantization: '提示层区间在视口两端被裁到 [0,1]，端点中心不会精确等于 0 或 1。'
  };
}

function observationKey(range) {
  if (!range) return null;
  return range.map(value => value.toFixed(12)).join('~');
}

function summarizeSeries(probes, series, view, span) {
  const accepted = probes.filter(probe =>
    probe.outcome === 'accepted' && probe.tip && probe.view === view &&
    (probe.seriesId ?? null) === (series.id ?? null));
  const buckets = new Map();
  for (const probe of accepted) {
    const key = observationKey(probe.tip.range);
    if (key === null) continue;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        range: [...probe.tip.range],
        x: probe.tip.x,
        value: probe.tip.value,
        valueKind: probe.tip.value === null ? 'breakpoint' : 'numeric',
        unit: probe.tip.unit,
        precision: tooltipPrecision(probe.tip.raw),
        evidence: {
          probe: probe.n,
          fraction: probe.fraction,
          revision: probe.tip.revision,
          view: probe.tip.view,
          raw: probe.tip.raw
        },
        repeats: [],
        conflicts: []
      });
    } else if (existing.valueKind === 'numeric' && probe.tip.value !== null && probe.tip.value !== existing.value) {
      existing.conflicts.push({
        value: probe.tip.value,
        unit: probe.tip.unit,
        probe: probe.n,
        raw: probe.tip.raw
      });
    } else {
      existing.repeats.push(probe.n);
    }
  }
  const observations = [...buckets.values()]
    .sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]);
  const { merged, gaps } = cover(observations.map(observation => observation.range), span[0], span[1]);
  const valueGaps = observations
    .filter(observation => observation.value === null)
    .map(observation => ({
      from: observation.range[0],
      to: observation.range[1],
      kind: observation.valueKind === 'breakpoint' ? '断点：页面在该区间报告空值' : '页面在该区间未报告数值',
      evidence: observation.evidence.probe
    }));
  const units = [...new Set(observations.map(observation => observation.unit).filter(value => value !== null))];
  return {
    id: series.id,
    label: series.label,
    xCoverage: merged,
    xGaps: gaps.map(([from, to]) => ({
      from,
      to,
      reason: '提示层从未覆盖该区间，不能按相邻点推断。'
    })),
    valueGaps,
    units,
    observations: observations.map(observation => ({
      x: observation.x,
      range: observation.range,
      value: observation.value,
      valueKind: observation.valueKind,
      unit: observation.unit,
      precision: observation.precision,
      evidence: observation.evidence,
      repeatProbes: observation.repeats,
      conflicts: observation.conflicts,
      interpolated: false
    })),
    probesAccepted: accepted.length,
    pointsObserved: observations.filter(observation => observation.value !== null).length,
    breakpointsObserved: observations.filter(observation => observation.value === null).length
  };
}

function collectUnknown(seriesReports, view) {
  const unknown = [];
  for (const entry of seriesReports) {
    for (const gap of entry.xGaps) {
      unknown.push({
        seriesId: entry.id,
        view,
        from: gap.from,
        to: gap.to,
        scope: 'x',
        reason: gap.reason
      });
    }
    for (const gap of entry.valueGaps) {
      unknown.push({
        seriesId: entry.id,
        view,
        from: gap.from,
        to: gap.to,
        scope: 'value',
        reason: gap.kind,
        evidence: gap.evidence
      });
    }
  }
  return unknown;
}

export function buildReport({
  series,
  probes,
  budget,
  span = [0, 1],
  source = null,
  generatedAt = null
}) {
  const views = [...new Set(probes
    .filter(probe => Number.isInteger(probe.view))
    .map(probe => probe.view))].sort((a, b) => a - b);
  const viewReports = views.map(view => {
    const seriesReports = series.map(entry => summarizeSeries(probes, entry, view, span));
    const axes = seriesReports.map(entry => inferAxis(entry.observations));
    const preferred = axes.find(axis => axis.kind !== 'undetermined') ?? axes[0];
    const coverage = cover(seriesReports.flatMap(entry => entry.xCoverage), span[0], span[1]);
    return {
      view,
      series: seriesReports,
      axis: {
        ...preferred,
        perSeries: seriesReports.map(entry => ({
          seriesId: entry.id,
          kind: inferAxis(entry.observations).kind
        }))
      },
      xCoverage: coverage.merged,
      xGaps: coverage.gaps.map(([from, to]) => ({
        from,
        to,
        reason: '所有系列在该区间都没有提示层覆盖。'
      }))
    };
  });

  const observed = [];
  const unknown = [];
  for (const viewReport of viewReports) {
    unknown.push(...collectUnknown(viewReport.series, viewReport.view));
    for (const entry of viewReport.series) {
      for (const observation of entry.observations) {
        observed.push({ seriesId: entry.id, view: viewReport.view, ...observation });
      }
    }
  }
  // 一次观测都没有时也不能输出“无未知”：每个系列整段横轴都是未知。
  if (viewReports.length === 0) {
    for (const entry of series) {
      unknown.push({
        seriesId: entry.id,
        view: null,
        from: span[0],
        to: span[1],
        scope: 'x',
        reason: entry.reason ?? '预算内没有取得任何提示层观测。'
      });
    }
  }

  const byLabel = new Map();
  for (const entry of series) {
    if (!byLabel.has(entry.label)) byLabel.set(entry.label, []);
    byLabel.get(entry.label).push(entry.id);
  }
  const labelCollisions = [...byLabel.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([label, ids]) => ({ label, ids }));

  const attempts = probes.map(probe => ({
    n: probe.n,
    phase: probe.phase,
    legendIndex: probe.legendIndex ?? null,
    seriesId: probe.seriesId ?? null,
    declaredSeriesId: probe.declaredSeriesId ?? null,
    observedSeries: probe.tip?.series ?? probe.observedSeries ?? null,
    view: probe.view ?? null,
    fraction: probe.fraction ?? null,
    requestedFraction: probe.requestedFraction ?? null,
    outcome: probe.outcome,
    repeated: probe.repeated === true,
    reason: probe.reason ?? null,
    generationFloor: probe.generationFloor ?? null,
    generationFloorSource: probe.generationFloorSource ?? null,
    waitMs: probe.waitMs ?? null,
    interactionAt: probe.interactionAt ?? null,
    tipAt: probe.tipAt ?? null,
    arrivedAfterInteraction: probe.arrivedAfterInteraction ?? null,
    updateCount: probe.updateCount ?? null,
    observedRevision: probe.tip?.revision ?? null,
    observedView: probe.tip?.view ?? null,
    range: probe.tip?.range ?? null,
    x: probe.tip?.x ?? null,
    value: probe.tip?.value ?? null,
    valueKind: probe.tip ? (probe.tip.value === null ? 'breakpoint' : 'numeric') : null,
    unit: probe.tip?.unit ?? null,
    precision: probe.tip ? tooltipPrecision(probe.tip.raw) : null,
    raw: probe.tip?.raw ?? probe.raw ?? null
  }));

  const phases = Object.values(probes.reduce((result, probe) => {
    const key = probe.phase ?? '未分组';
    if (!result[key]) result[key] = { phase: key, probes: 0, accepted: 0, duplicate: 0, stale: 0, missing: 0 };
    result[key].probes += 1;
    if (probe.outcome === 'accepted') {
      result[key].accepted += 1;
      if (probe.repeated) result[key].duplicate += 1;
    } else if (probe.outcome === 'stale') result[key].stale += 1;
    else result[key].missing += 1;
    return result;
  }, {}));

  const probeLimit = budget?.probeLimit ?? null;
  const interactionLimit = budget?.interactionLimit ?? null;
  const probesUsed = probes.length;
  const interactionsUsed = budget?.interactionsUsed ?? 0;
  const zoomsUsed = budget?.zoomsUsed ?? 0;
  const phaseLog = budget?.phaseLog ?? [];
  return {
    kind: 'chart-observation',
    generatedAt,
    source,
    contract: {
      readThrough: '页面可见图例、鼠标移动、缩放按钮和提示层',
      interpolation: '无：未观测到的横坐标区间只记为未知',
      seriesIdentity: '按提示层 series id 分组；label 不参与合并',
      precision: '小数点位数取自提示层原文 token',
      lateTips: '接受前核对本次探测预期的交互代次与视图代次'
    },
    legend: series.map(entry => ({
      id: entry.id,
      label: entry.label,
      duplicateLabel: labelCollisions.some(collision => collision.label === entry.label),
      confirmedByTip: entry.confirmedByTip !== false,
      note: entry.reason ?? null
    })),
    labelCollisions,
    views: viewReports,
    observed,
    unknown,
    attempts,
    budget: {
      probeLimit,
      interactionLimit,
      zoomLimit: budget?.zoomLimit ?? null,
      probesUsed,
      interactionsUsed,
      zoomsUsed,
      remainingProbes: probeLimit === null ? null : Math.max(0, probeLimit - probesUsed),
      remainingInteractions: interactionLimit === null ? null : Math.max(0, interactionLimit - interactionsUsed),
      phases,
      phaseLog,
      interactionLog: budget?.interactionLog ?? [],
      stopReason: budget?.stopReason ?? null,
      exhausted: probeLimit !== null && probesUsed >= probeLimit
    }
  };
}

export function formatSummary(report) {
  const lines = [];
  for (const view of report.views) {
    lines.push('视图 ' + view.view + '：');
    for (const entry of view.series) {
      const values = entry.observations.map(observation => {
        const valueText = observation.value === null
          ? '断点'
          : observation.x + '=' + observation.value + (observation.unit ?? '');
        const precisionText = observation.precision.value === null
          ? 'x ' + observation.precision.x + ' 位小数，无值'
          : 'x ' + observation.precision.x + ' 位/值 ' + observation.precision.value + ' 位小数';
        return '[' + observation.range[0] + ',' + observation.range[1] + ']→' +
          valueText + '（' + precisionText + '）';
      });
      lines.push('  ' + entry.id + '「' + entry.label + '」 ' + (values.join('；') || '无观测'));
      if (entry.xGaps.length) {
        lines.push('    未知横轴区间：' + entry.xGaps.map(gap => '[' + gap.from + ',' + gap.to + ']').join(' '));
      }
      if (entry.valueGaps.length) {
        lines.push('    无数值区间：' + entry.valueGaps.map(gap => '[' + gap.from + ',' + gap.to + ']').join(' '));
      }
    }
    lines.push('  横轴规律（仅由观测归纳）：' + view.axis.kind + '（' + view.axis.reason + '）');
  }
  const budget = report.budget;
  lines.push('预算：探测 ' + budget.probesUsed + '/' + budget.probeLimit +
    '，交互 ' + budget.interactionsUsed + '/' + budget.interactionLimit +
    '；停止原因：' + (budget.stopReason ?? '未注明'));
  for (const phase of budget.phases) {
    lines.push('  ' + phase.phase + '：' + phase.probes + ' 次（接受 ' + phase.accepted +
      '，重复 ' + phase.duplicate + '，迟到 ' + phase.stale + '，缺失 ' + phase.missing + '）');
  }
  if (report.labelCollisions.length) {
    lines.push('重名系列未合并：' + report.labelCollisions
      .map(collision => collision.label + '=' + collision.ids.join('/')).join('；'));
  }
  if (report.unknown.length) {
    lines.push('仍未知：' + report.unknown.length + ' 段（见 unknown）');
  }
  return lines.join('\n');
}

import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {startSource} from './source.mjs';
import {CaptureStore} from './store.mjs';
import {preview} from './domain.mjs';
import {collect} from './collect.mjs';
import {buildReport, formatSummary} from './observation.mjs';

// 演示入口同时保留原有资料预览和新增的提示层观测采集：
// 预览走原有领域函数；采集只走页面可见的图例、鼠标、缩放和提示层。
export async function demo({budget = {}} = {}) {
  const source = await startSource();
  let browser;
  try {
    // 原有预览调用保留，用来说明源端资料本身，而不是采集证据。
    const snapshot = await (await fetch(source.url + '/api/snapshot')).json();
    const legacyPreview = preview(snapshot);

    browser = await chromium.launch({headless: true});
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(source.url);
    await page.waitForFunction(() => window.portalReady);
    const result = await collect(page, {budget});
    await context.close();

    const report = buildReport({
      series: result.series,
      probes: result.probes,
      budget: {...result.budget, phaseLog: result.phases},
      source: {
        kind: 'interactive-portal',
        url: source.url,
        readThrough: ['图例按钮', '鼠标移动', '缩放按钮', '提示层文本']
      },
      generatedAt: new Date().toISOString()
    });
    report.races = result.races;

    const path = resolve(process.env.CAPTURE_PATH ?? 'var/captures.json');
    const receipt = await new CaptureStore(path).append({kind: 'chart-observation', report});
    return {source, path, receipt, report, legacyPreview};
  } finally {
    if (browser) await browser.close();
    await source.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const {path, receipt, report, source, legacyPreview} = await demo();
  console.log('资料源：' + source.url);
  console.log('原有预览（仅说明源端资料，不是采集证据）：' +
    legacyPreview.map(entry => entry.id + '「' + entry.label + '」' + entry.unit).join(' '));
  console.log(formatSummary(report));
  const races = Object.values(report.races);
  if (races.length) {
    console.log('迟到提示校验：' + races.map(race =>
      (race.sourceSeries ?? '-') + '→' + race.outcome + '（' + race.reason + '）').join('；'));
  }
  console.log('未观测到、未插值的区间共 ' + report.unknown.length + ' 段，详见报告的 unknown。');
  console.log('接收文件：' + path + '（第 ' + receipt.revision + ' 条记录）');
}

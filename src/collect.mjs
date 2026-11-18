import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { startSource } from './source.mjs';
import { CaptureStore } from './store.mjs';
import { CurveCollector } from './collector.mjs';

const budget = Number(process.env.COLLECT_BUDGET ?? 40);
if (!Number.isInteger(budget) || budget < 1) throw new Error('COLLECT_BUDGET 必须是正整数');
// 操作员从图面刻度读取的坐标轴配置（本模拟页未渲染刻度，按供方图面约定录入）；
// 不提供时采集器只记录页面报告的比例区间。
const axis = { min: 1, max: 1000, scale: 'log' };

const source = await startSource();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(source.url);
  await page.waitForFunction(() => window.portalReady);
  const collector = new CurveCollector(page, { budget, axis });
  const result = await collector.collect();
  await context.close();
  const path = resolve(process.env.CAPTURE_PATH ?? 'var/captures.json');
  const store = new CaptureStore(path);
  const receipt = await store.append(result);
  console.log(JSON.stringify({
    资料源: source.url,
    接收文件: path,
    已存记录: receipt.revision,
    预算: {
      总预算: result.budget.total,
      已花费: result.budget.spent,
      剩余: result.budget.remaining,
      去向: result.budget.byOp,
    },
    坐标形态: result.axisHint,
    系列: result.series.map(s => ({
      系列: s.id,
      标签: s.labels,
      单位: s.unit,
      观测分组: s.views.flatMap(v => v.groups.map(g => ({
        视口: g.view, 横坐标: g.x, 读数: g.value, 断点: g.breakpoint,
        比例区间: g.rangeFraction, 坐标区间: g.rangeX, 页面精度: g.precisionFraction,
      }))),
      未知区间: s.unknown,
    })),
    迟到提示丢弃: result.discarded.length,
    未确认: result.series.flatMap(s => s.unknown.map(u => ({ 系列: s.id, ...u }))),
    说明: result.notes,
    结论: result.summary.complete ? '全部区间已观测' : '存在未观测区间，见未知区间与说明；未插值补点',
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await source.close();
}

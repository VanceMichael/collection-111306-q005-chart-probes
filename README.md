# 交互曲线提示层的有界观测采集

工艺工程师每周要抄供应商网页上的几条测试曲线，对方只允许从交互图查看，不提供导出。本仓库保留原有资料预览工具和本地供方模拟服务，并新增一个只靠页面可见交互读取曲线的有界采集器。

## 当前能力

`npm run demo` 从实际本地资料源启动一次真实浏览器会话：

1. 保留原有领域预览，仅用于说明源端资料本身；
2. 用页面正常的图例按钮、鼠标移动、缩放按钮和提示层读取曲线；
3. 把带证据的观测、未知区间、预算开销和迟到提示校验写入 `var/captures.json` 并打印摘要。

采集器不调用页面没有公开的 `/api/snapshot` 或任何页面数据接口；浏览器内也不读取页面脚本变量。`src/source.mjs` 仍是独立模拟源，没有为采集器代劳。

`src/store.mjs` 提供带完整性校验的单进程顺序接收文件，不是跨进程事务数据库。

## 采集规则

- **只记录实际观测**：提示层把一段区间显示成同一组值时，这段区间只算一条观测；不会按鼠标位置插值或补点。未覆盖的横轴区间写入 `unknown`，并注明原因。
- **系列身份以提示层为准**：提示层报告的 `series` 是身份，`label` 只是显示文本。同名系列（如两个「出口温度」）按 id 分开，不按标签合并；`labelCollisions` 会列出重名。
- **单位与页面精度**：每条观测记录 `unit`，以及 `x`、`value`、`range` 在提示层原文里的小数位数。精度取自页面实际显示的 token，不是重新格式化后的数字。
- **断点保持未知**：提示层报告的 `value: null` 记为 `breakpoint`，对应的横轴区间同时进入 `unknown` 的 `value` 范围。
- **迟到提示隔离**：接受提示前核对提示层自报的交互代次和视图代次。图例切换与缩放时会先制造一条在途提示再切换，确认其被拒绝；迟到提示不会并入任何系列的观测。
- **有界探测**：`probeLimit`（提示探测次数）、`interactionLimit`（图例切换与缩放次数）、`zoomLimit`（缩放次数）共同限制采集。缺口补测只做两轮，且没有发现新提示区间就停止；预算耗尽或缩放上限到达时停止，并把未覆盖区间连同停止原因留下。
- **预算可核对**：`budget` 记录用量、剩余、按阶段计数、阶段事件日志和每次图例切换/缩放的交互日志；`attempts` 逐条记录鼠标位置、提示层原文、代次、到达时间与交互时间的关系。

横轴规律只根据提示层报告的 `(区间中心, x)` 归纳成 `linear` / `logarithmic` / `undetermined`，并附残差；它只用于解释观测，不用于生成数据点。

## 运行

容器内固定 Playwright 1.56.1 与匹配的 Chromium。浏览器只访问本进程启动的回环资料源，不需要访问外部门户。

```sh
npm ci
npx playwright install chromium
npm run build
npm test
npm run demo
```

推荐使用固定镜像构建，首次构建会安装锁文件中的依赖；运行时不需联网。

```sh
docker build -t plant-chart-probes .
docker run --rm --network none --ipc=host plant-chart-probes npm test
docker run --rm --network none --ipc=host plant-chart-probes npm run demo
```

开发时 `npm start` 打印本地源地址；设置 `PORT` 可指定监听端口，未设置时自动分配回环端口。`CAPTURE_PATH` 可改变接收文件路径。重复运行追加记录；删除 `var` 可从空接收状态开始。

## 模块

- `src/source.mjs`：该业务的本地资料源与演示控制，独立于采集行为。
- `src/domain.mjs`：现有原始资料预览和领域数据结构。
- `src/observation.mjs`：提示层文本解析、精度提取、观测去重、未知区间、横轴归纳与报告生成（纯逻辑，无浏览器）。
- `src/collect.mjs`：浏览器交互与探测计划，只使用图例、鼠标、缩放和提示层。
- `src/preview.mjs`：演示入口；保留原有预览调用，追加有界采集并写入接收文件。
- `src/store.mjs`：带完整性校验的顺序接收文件。
- `fixtures/source.json` 与 `fixtures/controls.json`：本地供方资料及可切换情形。
- `docs/source.md`：接口和来源约定。
- `test`：提示层解析、重名系列、断点、迟到提示、预算，以及真实浏览器端到端复跑测试。

## 业务核对

以下情况都可从 `var/captures.json` 独立检查，而不是只相信源端能够制造它们：

- 相同标签的不同系列：`labelCollisions` 与按 `series` 分开的观测。
- 断点区间保持未知：`valueGaps` 与 `unknown`。
- 非线性横轴：`views[].axis`。
- 视口切换后迟到提示：`races.legendSwitch` / `races.zoom` 与 `attempts` 中的 `stale` 记录。
- 预算耗尽能够停止且解释缺口：`budget.exhausted`、`budget.stopReason`、`unknown`。

## 已知边界

- 采集计划是固定的粗扫位置加中点补测，不是自适应最优探测；提示层量化造成的空白会保留为未知。
- 缩放只做一次，缩放后的视图单独记录。缩放后的横轴规律若不同，会在对应视图的 `axis` 里单独给出。
- 源端控制接口只用于测试中核对，不参与采集路径。

## 短时操作演示

从空 `var` 运行 `npm run demo`，展示本次真实读取、采集、接收和未知区间清单；再运行 `npm test` 查看提示层语义与端到端复跑。固定环境中的这两步应在 90 秒内完成。

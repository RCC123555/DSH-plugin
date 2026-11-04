# hardware-quote DSH 插件 · 开发契约（所有成员必须遵守）

包根目录：`D:\工作\DSH\Project\hardware-quote`（cwd 为 `D:\工作\DSH\Project`）。
本插件是 **DSH host bundle**：注册 1 个 skill（`hardware-quote`）+ 一组 `hwq_*` 工具，无 MCP、无外部 npm 依赖。
旧 Codex 版 2.4.1 源码已复制到 `hardware-quote/_legacy/`（`calculate.mjs` / `quote.mjs` / `1688-lookup.mjs` / `runtime.mjs` / `prepare_template.py` / `finalize_xlsx.py` / `test-*.mjs` / `SKILL.md.orig` / `references.orig/`），**业务公式必须逐条对齐旧实现**，除非本契约明确写了改动。

运行环境（已验证）：
- Node：`C:\Users\Lenovo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0，全局 `fetch`、`WebSocket`、`node:test` 可用；bash 里 `node` 不在 PATH，跑测试请用该绝对路径）
- Python：`C:\Users\Lenovo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（openpyxl 3.1.5 / Pillow 12.3.0 / XlsxWriter 3.2.9）
- Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`；Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- 无 LibreOffice：**不能**用 soffice 重算公式，公式缓存值方案见下。

## 目录与文件归属（严禁越界写别人的文件）

| 归属 | 文件 |
|---|---|
| Lead | `package.json`、`cordis.patch.yml`、`lib/index.mjs`、`CONTRACT.md`、安装/集成 |
| A 定价引擎 | `lib/pricing.mjs`、`lib/lookup.mjs`、`test/pricing.test.mjs`、`test/lookup.test.mjs` |
| B Excel | `lib/quote.mjs`、`python/build_workbook.py`、`test/quote.test.mjs` |
| C 1688 | `lib/cdp.mjs`、`lib/ali1688.mjs`、`test/ali1688.test.mjs`、`test/fixtures/` |
| D 文档 | `skill/SKILL.md`、`skill/references/*.md` |

## 模块接口（名字固定，Lead 的 `index.mjs` 与工具层按此调用）

### `lib/pricing.mjs`（A）
保持旧 `_legacy/calculate.mjs` 的全部导出与输出字段，版本号改为 `3.0.0`：
```js
export const VERSION = '3.0.0';
export const PROCESSING_RATE_PER_KG = 3;
export const DEFAULT_RATES = Object.freeze({metal:5,wood:5,coating:2.5,carton:4.2,tax:0.1,netMargin:0.085,managementToProfit:0.9});
export const FIXED_PACKAGING = ...;
export function quoteDate() {...}
export function dimensionsCm(d) {...}
export function cartonAreaM2(d) {...}
export function cartonPrice(d, rate) {...}
export function pricing(C, r, k, t) {...}
export function calculate(input) {...}   // 输出对象字段与旧版一致
```
`calculate(input)` 输出必须保留旧字段（`ready`/`blocking`/`warnings`/`weights`/`costs`/`totals`/`rows`/`accessoryRows` 等，以旧文件实际结构为准），并**新增**：
- `blockingIssues: [{code, message, severity:'weight'|'dimensions'|'packaging'|'input', draftAllowed:boolean}]`
- 只有 `code:'missing_price'` 一类缺价问题允许 `draftAllowed:true`（修旧版 P0：`--allow-draft` 不得放行重量矛盾/尺寸缺失/包装不完整）。`calculate()` 自身不接收 allowDraft；`ready` 表示"所有问题都可解决"，`draftOnly` 布尔表示"仅缺价阻塞"。

### `lib/lookup.mjs`（A）
逐条移植旧 `_legacy/1688-lookup.mjs` 的导出：`is1688`、`isOffer`、`classifyFailure`、`planLookups`、`validatePriceEvidence`、`priceFromEvidence`、`averagePriceEvidence`、`priceFromAverage`。行为与校验规则不得放宽（价格必须是正有限数、单位换算系数 >0、样本必须带真实 URL/日期/供应商、均价样本数 <2 必须提示单样本、改价或订单量变化后样本失效等）。可新增 `evidenceSchema`（JSON Schema 草稿）供工具层做参数校验。

### `lib/quote.mjs`（B）
```js
export async function buildQuote(input, options) // → { output, planPath, sheets:[{name,lastRow,lastColumn}], checks:{...}, metadata:{...} }
// options: { outputDir, workDir, pythonPath?, imagePath? }
export async function previewSlices? // 可选
```
流程：`calculate(input)` → 生成 workbook plan JSON（写到 workDir）→ 用 `pythonPath`（默认上面的绝对路径，可用 `DSH_HWQ_PYTHON` 覆盖）执行 `python/build_workbook.py --plan <plan.json>` → 返回产物路径。
`plan` 结构自定，但 `build_workbook.py` 必须能从任意 cwd 用 `python build_workbook.py --plan X` 跑通（脚本内部用 `Path(__file__).parent` 定位资源）。
Excel 输出要求（旧版行为，必须保留）：两工作表「报价BOM」「报价底稿」；BOM 沿用 `skill/assets/对外报价BOM表.xlsx` 的原样式、至少 2 条配件行、按配件条数扩行、加未税报价行；BOM 用公式引用底稿单元格；嵌入产品第一张图（若有）；底稿 A:I 列含公共参数、逐条 1688 证据（详情 URL 可点击原生超链接）、均价记录、估算依据、以及**新增**"脚本复算（只读校验）"区块列出 JS 计算的成本/利润/未税/含税/净利率静态值（用于无 LibreOffice 环境核对公式）；打印设置：BOM A4 纵向、fitToWidth=1 fitToHeight=1，底稿 A3 横向、fitToWidth=1 fitToHeight=0（不承诺严格两张纸）；`calcPr fullCalcOnLoad=1`。
`checks` 至少返回：`formulaErrors`（openpyxl 读回时扫描到 `#REF!` 等）、`rowMap`、`weights`、`totals`、`links`、`imageEmbedded`。

### `lib/cdp.mjs` + `lib/ali1688.mjs`（C）
```js
// cdp.mjs —— 零依赖 CDP 客户端（Node 24 全局 WebSocket）
export async function ensureBrowser(options)   // → {port, wsUrl, launched, userDataDir}
export async function openTarget(port, url)    // → {targetId}
export async function evaluate(port, targetId, expression) // → value
export async function navigate(port, targetId, url)
export async function screenshot(port, targetId, filePath)
export async function closeBrowser(port)
// ali1688.mjs —— 业务层
export async function loginStatus(options)      // → {loggedIn:boolean, memberName?:string, evidence:string, port}
export async function searchOffers({query, imagePath, limit=5, options}) // → {method:'keyword'|'image', keyword, searchedAt, candidates:[{url,title,priceText,unitText,moqText,company,soldText}], rawCount, notes}
export async function openOffer(url, options)   // → {url, title, company, unit, offers:[{skuId, props, priceText, price, unit, moqText}], capturedAt, domNotes}
export async function collectEvidence(input...) // 组装旧版 evidence（见 _legacy/references.orig/1688-browser-workflow.md）
```
C 的浏览器策略（性能/稳定性优先）：
1. 用 `chrome.exe --remote-debugging-port=<port> --user-data-dir=<插件状态目录>\chrome-profile` 启动**持久**配置（状态目录默认 `path.join(os.homedir(), '.dsh', 'hardware-quote')`，可用 `HWQ_STATE_DIR` 覆盖），登录一次后长期复用；端口从状态目录 `browser.json` 读取，失效则重启。
2. 优先在页面上下文用 `fetch()` 直连 1688 搜索/详情页（同源 cookie 自动带上），正则/JSON 解析；失败再退回 DOM 文本解析。以图搜款（imagePath → 上传）作为第二路径，不作为唯一路径。
3. 登录：`loginStatus` 检测登录态（首页/我的阿里页面特征 + 已知 cookie 域）；未登录时**绝不**读/存账号密码，返回需要用户在窗口内扫码或登录的提示；提供 `openLoginPage()` 打开登录页。
4. 反爬/验证码：检测到滑块/验证码时返回 `blocked:'captcha'` 并保存截图路径，由上层提示用户手动完成，不得绕过。
5. 禁止：发询价/下单/发消息、导出 cookie 或凭据、伪造 URL 或价格。所有真实抓取必须带 `capturedAt`（ISO 时间）与 `evidence` 描述。

## 工具注册（Lead 在 `lib/index.mjs`）
`hwq_calculate`、`hwq_quote`、`hwq_1688_login`、`hwq_1688_search`、`hwq_1688_offer`、`hwq_1688_average`。参数用 JSON Schema；返回值同时给模型可读文本摘要 + 结构化数据。所有工具都必须：参数校验失败时返回可修正的错误；不静默编造数据。

## 通用工程约束
- ESM，`import` 只用 `node:*` 内置模块；不要 import 任何 npm 包；不要读 asar。
- 面向 Windows 路径（含中文与大写盘符）；不得假设 POSIX。
- 时间戳用真实 `new Date().toISOString()`；禁用固定/编造日期。
- 每个模块自带测试，用 `node:test` + `node:assert/strict`，跑法：`& "C:\...\node.exe" --test test/xxx.test.mjs`（bash 里用双引号绝对路径）。测试失败必须修到全绿再报告。
- 严禁为通过测试而放宽业务规则或写假数据；遇到旧实现自相矛盾处，报告给 Lead 而不是自行取舍。

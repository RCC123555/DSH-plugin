# 五金产品报价 · DSH 插件（hardware-quote 3.0.1）

把 Codex 版 `hardware-quote` 2.4.1 重做成 DeepSeek Harness 插件：**1 个技能 + 6 个 `hwq_*` 工具**，保留原有全部报价规则，并重做 1688 自动登录/搜索/证据这条最薄弱的能力。

- 技能名：`hardware-quote`
- 包名：`hardware-quote-dsh-plugin`（bundle 入口 `lib/index.mjs`，`inject: ["tools"]`）
- 依赖：宿主 Node（v24+）、DSH 运行时自带 Python（openpyxl + Pillow）；**不需要** LibreOffice、不需要 MCP、不需要第三方 npm 包

## 3.0.1 修了什么（相对 3.0.0）

- **P0：1688 中文关键词搜索乱码已修。** 旧实现用 `encodeURIComponent` 生成 UTF-8 百分号编码，而 `s.1688.com/selloffer/offer_search.htm` 是老端点，按 **GBK** 解码 `keywords`，于是页面标题和搜索框变成「鍐呭叚瑙掓硶鍏伴潰铻轰笣」这类乱码、搜索结果也跟着错。现在 `lib/ali1688.mjs` 用内置 `TextDecoder('gbk')` 反向建表做 GBK 百分号编码（仍零依赖），真机对比两种编码已确认一个正常一个必乱。
- `hwq_1688_search` 在 `sameSpecOnly` 过滤到 0 条时给出 `nearMisses`（最多 3 条未通过标题级初筛的近似候选 + 未通过原因），只能进详情页核对，不得当作已匹配证据。
- **单配件产品可导出**：模板保留的 2 条配件行里多余那行整行留空（不再报「第2条配件行为空」），并新增回归用例。
- 版本号 3.0.1，新增真实证据示例 `examples/sample-real-evidence.json`（配件价来自真机抓的 1688 详情页）。

## 安装

已在本机 desktop profile 安装（`plugin_manager install_bundle` → `hardware-quote-dsh-plugin 3.0.1`）。重装/更新：

```
plugin_manager({action:"install_bundle", target:"D:\\工作\\DSH\\Project\\hardware-quote"})
```

`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` → 插入 id `hardware-quote`、specifier `hardware-quote-dsh-plugin`。

### 从 GitHub 安装（第二台机器 / 换机）

仓库：<https://github.com/RCC123555/DSH-plugin>（public，插件放在仓库根目录，本插件在分支 `五金报价`）。DSH 桌面端「设置 → 插件 → 安装」里直接粘贴 spec：

```
github:RCC123555/DSH-plugin#五金报价
```

想锁版本、避免两台机器随上游漂移，就钉 tag（推荐，tag 名带插件前缀）：

```
github:RCC123555/DSH-plugin#五金报价-v3.0.1
```

装好后在 profile 里登记为 `hardware-quote-dsh-plugin`，`cordis.patch.yml` 自动插入 id `hardware-quote`。

- 走代理的机器要给 pnpm/git 同样的网络配置：`https_proxy`/`http_proxy`，并给 git 关掉吊销检查（`http.schannelCheckRevoke=false`），否则会报 `schannel: ... CRYPT_E_NO_REVOCATION_CHECK`。
- **不随仓库同步**：1688 登录态（`~/.dsh/hardware-quote/chrome-profile`，每台机器各自扫码一次）、`output/` 报价产物、`_scratch/` 试验目录。
- 本机继续用 `link:D:/工作/DSH/Project/hardware-quote` 开发；改完 `git push`，另一台重装 `github:...#<新 commit>` 即同步。

## 多插件约定（一个仓库、多个分支）

一个仓库放多个插件：**每个插件一个分支，分支名 = 插件名**；不建子目录、不做 monorepo，每个分支的根目录就是那个插件的包根。

- 本插件在分支 `五金报价`：`github:RCC123555/DSH-plugin#五金报价`（不写 `#分支` 就装仓库默认分支）
- 中文分支名已实测可被 pnpm/git 正常解析（`pnpm add github:RCC123555/DSH-plugin#五金报价` → `hardware-quote-dsh-plugin 3.0.1`）；若某台机器或工具对非 ASCII ref 不友好，把分支改成英文名（如 `hardware-quote`）即可，仓库内文件不用动。
- 新增插件（干净起点，不带别人的文件）：

```
git checkout --orphan "新插件名"
git add -A && git commit -m "feat: 新插件名 初始提交"
git push -u origin "新插件名"
```

- tag 带插件前缀，避免跨分支撞名：`五金报价-v3.0.1`、`新插件名-v1.0.0`
- 好处：每个分支都满足「仓库根即包根」，`github:` spec 不需要 `#path:/子目录`，桌面端插件管理器能直接装。

## 怎么用

直接跟 DSH 对话给信息即可（技能会自动被选中，或说“用 hardware-quote 报价”）：

> 报价：这是产品图（附图片），外形尺寸 120×60×75 cm，组装净重 10 kg，订单 500 件，每箱 1 件，箱规 124×63×22 cm

流程固定 5 步：**识图拆件 → 查价取证 → 核算 → 导出两页 Excel → 用 checks 复核**。细节见 `skill/SKILL.md` 与 `skill/references/`。

只给毛重也可以：先扣包材与非组装附带件得组装净重，再扣单独计价的必需配件得主料本体重量；**禁止**用固定毛净比。

## 六个工具

| 工具 | 作用 |
| --- | --- |
| `hwq_calculate` | 纯计算：重量拆分、成本、加工/喷涂/包装、利润与税金，返回 `ready`/`draftOnly`/`blockingIssues` |
| `hwq_quote` | 生成「报价BOM + 报价底稿」两工作表 Excel（模板扩行、未税报价行、嵌入产品图、逐家 1688 证据、脚本复算区块） |
| `hwq_1688_login` | `status`/`open`/`flush`：查登录态、开登录页（用户扫码）、把登录态强制落盘到持久 Chrome profile |
| `hwq_1688_search` | 关键词或以图搜款，返回真实候选（URL/标题/价格文本/单位/MOQ/供应商）与 `blocked`/截图 |
| `hwq_1688_offer` | 打开详情页抽 SKU、阶梯价、起订量，标出选中规格 |
| `hwq_1688_average` | 同规格、同单位、同口径的 3–5 条证据归一取算术均价，逐条报告被排除原因 |

## 1688 能力（本次重做的重点）

- **自带持久 Chrome**：默认端口 19222、独立 profile（`~/.dsh/ego-browser/...` 同级的插件 state 目录），零依赖 CDP 客户端，不接管用户其它浏览器。
- **登录**：`open` 打开登录页由用户扫码；`status` 用 cookie 信号 + 页面信号双证据判断（不读 cookie 值）；`flush` 优雅关闭并按同一 profile 重启以强制落盘，重启后仍登录。
- **搜索**：`s.1688.com` 关键词搜索（中文按 GBK 编码进 URL，UTF-8 会整页乱码）；先解析 HTML，JS 壳页面回退可见 DOM 卡片（实测 60 个真实卡片）；以图搜款走 `s.1688.com/youyuan/index.htm` 上传本地图片。
- **详情**：优先读 `window.context.result.data`，回退可见 DOM；返回 SKU 列表、价格文本、MOQ、阶梯。
- **规格匹配是硬门槛**：螺纹规格（M6）、长度（×15）、头型必须与目标一致才允许 `specMatched:true`；“套装/配螺母/大全”不得当单颗价。
- **证据合同**：`url/supplier/title/selectedSpec/quoteUnit/targetUnit/observedText/queriedAt/evidenceKind/searchMethod/keywords|inputImage/specMatched/currency/priceKind/originalPrice/targetUnitsPerQuoteUnit`，由 `lib/lookup.mjs` 的 `validatePriceEvidence` 复核；无有效价一律 `unitPrice:null` + `sourceType:pending`，**禁止编造 URL/日期/价格**。

## 验证（可复跑）

```
NODE="C:/Users/Lenovo/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
"$NODE" --test "hardware-quote/test/*.test.mjs"   # 121 例：116 pass / 0 fail / 5 skip（live 需 HWQ_LIVE=1）
# 单独跑：pricing 59 + lookup 24 + quote 7 + single-accessory 1 + ali1688 24 离线（另 5 例 live）
```

工具级冒烟（已实测通过）：

- `hwq_calculate(inputPath: hardware-quote/examples/sample-input.json)` → READY，C=142.1041、含税 Q=190.0827、净利率 8.5%
- `hwq_quote(...)` → `2026-11-04_DEMO-ONLY_报价_v01.xlsx`，BOM 40×9、底稿 79×9、`formulaErrors=[]`、4 条内部超链接
- `hwq_quote(..., imagePath: work/demo-product.png)` → `imageEmbedded=true`
- `hwq_1688_login(action:"status")` → 已登录（`__cn_logon__` 标记 + 页面头像）
- `hwq_1688_search(keywords:"内六角法兰面螺丝 M6*15")` → 60 个真实卡片（GBK 编码，标题为正常中文）
- 真实证据全链路：`node work/build-real-demo.mjs` → 用真机抓的详情页证据（铁艺餐桌脚 ¥5.80/个、起订≥4个）算出 C=215.0319、含税 287.6331、净利率 8.5%，导出 `2026-11-04_DEMO-REAL-EVIDENCE_报价_v01.xlsx`（BOM 40×9、底稿 79×9、`formulaErrors=[]`、图片已嵌入）

## 如实说明的限制

1. **没有 LibreOffice/Excel 重算引擎**：导出校验靠 python 读回 + 自研求值器 + `fullCalcOnLoad=1`；不得声称“已用 Excel 验证公式”。
2. **打印页数未渲染验证**：BOM A4 纵向 `fitToWidth=1/fitToHeight=1`、底稿 A3 横向 `fitToWidth=1/fitToHeight=0` 已写入，但底稿 79 行预计不止 1 页——只保证两个工作表，不保证严格两张纸。
3. **1688 页面结构易变**：解析层对 JS 壳/改版有回退，但搜索页单位与 MOQ 常缺失，必须进详情页确认；反爬/验证码交用户手动完成。
4. **以图搜款**走平台上传面板，端到端稳定性弱于关键词搜索，建议关键物料仍用关键词复核。
5. 单产品单箱模型（每箱件数用于摊纸箱费），未接旧包的 6 份补充模板。
6. 插件内 Chrome 与宿主 ego 浏览器是两套独立实例；两者不要同时操作同一个 1688 账号的敏感操作。

## 目录

```
hardware-quote/
  lib/index.mjs        插件入口：注册 hardware-quote 技能 + 6 个工具
  lib/pricing.mjs      定价引擎（旧 calculate.mjs 全量移植 + blockingIssues 分类）
  lib/lookup.mjs       证据校验与均价（旧 1688-lookup.mjs 移植）
  lib/quote.mjs        两页 Excel 导出编排（template 扩行 → python → 读回复核）
  lib/cdp.mjs          零依赖 CDP 客户端（持久 Chrome、导航、求值、截图、cookie 元数据）
  lib/ali1688.mjs      1688 业务层（登录态、搜索、以图搜款、详情、证据映射）
  python/build_workbook.py  openpyxl 生成工作簿 + 读回求值校验
  skill/SKILL.md       技能正文（注册进 DSH skills 服务）
  skill/references/    报价规则/输入契约/1688 流程/定价依据/发布说明
  skill/assets/对外报价BOM表.xlsx  唯一在用模板（SHA256 已核对）
  examples/            演示输入：sample-input.json（合成）、sample-real-evidence.json（真实 1688 配件价）
  test/                node:test 用例与真实抓取 fixture
  _legacy/             旧 2.4.1 源文件（对照用，不参与运行）
```

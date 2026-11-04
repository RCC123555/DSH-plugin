# 3.2.0

## 多产品合并交付（一个工作簿、每款一张分表）

- 新增 `hwq_quote_batch`：`items` 逐款给 `input|inputPath`、分表简称 `name`、`imagePath`、`allowDraft`、`note`，另可给 `outputDir/workDir/label/pythonPath`；输出**一个**工作簿：`00_汇总`（23 列跨款对比：SKU/名称/尺寸/外箱/净重/毛重/铁木主料/成本拆分/C/P/M/U/T/Q/备注风险）、`00_口径说明`、`01_产品…`（每款一张分表，上半「报价BOM」、下半「报价底稿」）。某款未就绪整体失败；全部仅缺价时逐款 `allowDraft:true` 出草稿并在文件名标「待核价」。
- 新增 `lib/batch.mjs`（`buildBatch`/`buildSummary`/`summaryRows`/`SUMMARY_HEADERS`/`reserveOutput`）、`python/merge_quotes.py`（分表合并 + 公式改写）、`python/verify_merge.py`（逐格值/公式/合并区/链接/图片静态校验）。`lib/quote.mjs` 导出 `resolvePython` 供复用。
- 合并实现要点：BOM 与底稿两块各复制 12 列（必须含 BOM `L41/L42`，底稿 `H11` 引用 `'报价BOM'!L42` 净利率）；底稿整体下移到 `frontRows+4`（`GAP=4`），本表引用按区块加行偏移、跨表引用改写为同表引用；**字符串字面量必须用捕获组拆分**（非捕获组会把 `=IF(H16>=2,"…","…")` 的两个文本参数吃掉，公式退化成 `=IF(H62>=2,,)`）；样式/合并区/行高/超链接(location 同步改写)/图片(anchor 行偏移)随源表复制，列宽取两表逐列最大；网格线关、无冻结。
- 交付命名 `<日期>_<label>[_待核价]_报价_vNN.xlsx`（vNN 自动避让）；多产品同单必须交付合并件，不得拆成多个文件。
- 真机验证：星商宠物笼 5 款合并件 7 个 sheet，Excel COM 重算后与 5 份单款逐格比对（A..L、BOM 与底稿两区块）mismatch=0、错误串 0、每分表图片 1 张、超链接 25/18/13/21/14；`00_汇总` Q 合计 836.46 与分表一致。

# 3.1.0

## 后台查价与窗口策略

- **默认后台查价，不抢前台。** 插件 Chrome 启动即放到屏外并最小化，新标签改用浏览器级 `Target.createTarget{background:true}`（原先 `/json/new` 会激活标签并把窗口拉回前台），查价过程不再 `Page.bringToFront`。搜索、详情抽取与报价写入在窗口最小化/后台状态下照常完成。
- **只在用户空闲时打扰。** 检测到登录墙/验证码时，用 Windows `GetLastInputInfo` 读取空闲时长；只有 idle ≥ `HWQ_SURFACE_IDLE_MS`（默认 120000ms）才把窗口置前并截图。PowerShell 不可用/超时时视为「空闲未知」，一律不弹窗（不打扰优先）。
- 新增 `hwq_1688_login action:"show"|"hide"`：手动调出/收回后台窗口（`show` 优先挑登录页、其次搜索页——验证码常挂在搜索页）；用户显式 `action:"open"` 总是置前。
- 模式与阈值可用 `HWQ_WINDOW=auto|background|visible`（默认 `auto`）、`HWQ_SURFACE_IDLE_MS` 环境变量覆写；复用已存在的浏览器时不改变其窗口状态。
- **修复：验证码被误报成「没搜到商品」。** 1688 滑块验证常以 iframe（`x5secdata`/`punish`/`captcha`/`_____tmd_____`）挂在搜索页，此时 `body.innerText` 为空；现在把该 iframe 作为信号，`detectBlock` 归为 `blocked:"captcha"` 并保存截图，详情页同样处理。
- 新增 `test/cdp-window.test.mjs`（7 例）覆盖启动参数、模式解析、阈值与空闲判定，`ali1688.test.mjs` 增加「后台建标签不改变窗口状态」live 断言；离线套件 128 例（123 pass / 0 fail / 5 skip），live 31 例全通过（窗口最小化状态下跑通搜索与详情抽取）。

# 3.0.0

DSH 宿主重写：技能经 `ctx.skills.register({content})` 注入模型上下文（无 YAML frontmatter、无 Codex 依赖），报价能力由 `hwq_calculate`、`hwq_quote`、`hwq_1688_login`、`hwq_1688_search`、`hwq_1688_offer`、`hwq_1688_average` 六个工具提供；Excel 由内置 Python/openpyxl 生成，1688 由插件自带持久 Chrome + 零依赖 CDP 客户端执行。业务公式逐条对齐旧版 2.4.1。

## 3.0.1 变更（DSH 版迭代）

- **修复 P0：1688 中文关键词搜索乱码。** 旧实现用 `encodeURIComponent`（UTF-8 %XX）拼 `s.1688.com/selloffer/offer_search.htm?keywords=`，而该 legacy 端点按 GBK 解码 keywords，导致结果页标题与搜索框出现「鍐呭叚瑙掓硶鍏伴潰铻轰笣」乱码、搜索结果错乱。现改为 `encodeGbkComponent()`（用内置 `TextDecoder('gbk')` 反向建表生成 GBK 百分号编码，仍零依赖）；真机对比同一关键词两种编码，GBK 编码标题正常、UTF-8 编码必乱码。
- **修复：只有 1 条配件的产品无法导出。** 模板固定留 2 条配件行，旧校验要求两行都有名称，单配件产品必失败；现保留行整行留空（且禁止半填），并加回归用例。
- 新增 `sameSpecOnly` 无命中时的 `nearMisses` 回退：给出最多 3 条未通过标题级初筛的近似候选，并明确标注只能进详情页核对、不得当作已匹配证据。

## 修复

- **P0 allowDraft 越权**：旧版 `--allow-draft` 会放行全部 blocking，导致重量矛盾、尺寸缺失、包装不完整也能出确定报价。3.0.0 只有 `code:"missing_price"` 的缺价问题 `draftAllowed:true`；`draftOnly` 仅表示“仅缺价阻塞”，其他问题必须先解决。
- **P0 两页承诺**：旧文档承诺“恰好两页”，部分内容下打印会溢出。3.0.0 改为“保证两个工作表（报价BOM、报价底稿），不承诺严格两页”；BOM A4 纵向 `fitToHeight=1`，底稿 A3 横向 `fitToHeight=0`。
- **P1 查价真实性**：旧版依赖宿主浏览器工具，验收停在首页/登录状态，完整搜索与 SKU 读取未完成。3.0.0 由插件自带 CDP 真机执行搜索/详情抽取，落真实 `capturedAt`、最终详情 URL、可见文本等证据；工具故障与站点登录/验证码分开记录。
- **P1 中文转义**：旧版部分输出与文档使用 `\uXXXX` 转义，中文不可读。3.0.0 统一 UTF-8 中文，工具返回值不再输出 `\u` 转义。
- **P1 集成测试**：补“输入→核算→导出→回读 checks”链路集成测试，覆盖缺价草稿、重量冲突、EPS 覆盖不足、均价证据失效等分支。

## 保留限制（诚实标注）

- **没有 LibreOffice**：不重算、不刷新 Excel 公式缓存，不渲染预览；核对靠 `hwq_quote` 的 `checks` 与底稿“脚本复算（只读校验）”静态值，不得声称已用 Excel 实际重算。
- 不保证严格两页；分页以实际文件为准。
- **P2 单箱单产品限制**：保留旧版限制——仍只支持单箱单产品：多件装箱须给每箱件数；多箱产品的各箱尺寸与费用分摊需人工拆分，不做多箱合计。
- 1688 页面结构、风控与登录方式会变；验证码/登录由用户在该浏览器窗口完成，工具不绕过。以图搜款依赖页面当前上传能力，只有上传成功不算图片搜索成功。
- 均价需人工核对同规格与税运口径；不足 2 条标单样本，不凑均价；采购量变化会使样本失效。
- 多产品一次交付用一个工作簿（`hwq_quote_batch`，每款一张分表 + `00_汇总`）；单产品用 `hwq_quote`。合并件与单款件需分别用 Excel 重算后才能比对公式缓存值，插件本身不重算。

## 2.4.1 及以前

- 2.4.1：均价底稿改为逐家样本行与独立链接，Excel 均价公式随样本更新，采购量使 MOQ/档位失效时提示待核；加工合计仍 3 元/kg。图片搜索端到端未验收。
- 2.4.0：同规格算术平均、单位归一、商品 SKU 去重、排除记录与核算器复算。
- 2.3.0：缺价任务规划、浏览器证据校验、报价单位与 MOQ/档位转换；加工合计成本改为本体金属重量×3 元/kg。
- 已移除：Codex / Artifact Tool 依赖、`scripts/` 命令行（calculate / quote / 1688-lookup / prepare_template / finalize_xlsx）、设备配置与 `--allow-draft` 参数、PNG 预览分片、`cleanupCommand`。这些能力由 `hwq_*` 工具内置替代。

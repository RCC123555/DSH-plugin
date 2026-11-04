# 输入及执行接口

报价行为以[报价规则](quotation-rules.md)为准。本文件记录报价 JSON 结构、`hwq_*` 工具调用与字段说明。每次一个产品；数字用数值类型，不写“12kg”；尺寸显式带 `cm`/`mm`/`m`，重量 kg。以下只是接口示例，不是供应商报价，日期、估算和查询记录须换成实际信息。

## 报价 JSON

```json
{
  "product": {
    "name": "产品名称", "sku": "SKU", "date": "2026-10-04", "material": "mixed",
    "netWeightKg": 12, "netWeightBasis": "assembled", "grossWeightKg": 16.8,
    "dimensions": {"length":120,"width":60,"height":75,"unit":"cm"},
    "cartonDimensions": {"length":129,"width":65,"height":18,"unit":"cm"},
    "imagePath": "product.png"
  },
  "order": {"quantity":500,"unitsPerCarton":1},
  "processing": {"needsCoating":true},
  "woodPieces": [{"length":120,"width":60,"unit":"cm","quantity":1,"notes":"根据图片估板面尺寸"}],
  "accessories": [
    {"name":"内六角法兰面螺丝","spec":"M6×15MM","quantity":8,"templateKey":"m6-flange-screw","weightKgPerUnit":0.004,"weightSourceType":"estimate","weightBasis":"接口示例暂按4g/个；实际须按匹配规格核实"},
    {"name":"螺母","spec":"M6","quantity":8,"templateKey":"m6-nut","weightKgPerUnit":0.002,"weightSourceType":"estimate","weightBasis":"接口示例暂按2g/个；实际须按匹配规格核实"}
  ],
  "packaging": {
    "requireTopBottomEps": true, "topBottomClearanceCm": 3,
    "protection": [{"name":"EPS上下垫片","material":"EPS","spec":"15kg/m³，1.5cm厚","quantity":2,"pricing":"volume",
      "dimensions":{"length":126,"width":62,"height":1.5,"unit":"cm"},"densityKgM3":15,
      "templateKey":"eps-15-volume","notes":"演示原表参考价；实际优先联网核价"}],
    "notes":"上下各一整片；外箱最大面129×65cm，长宽各留3cm冗余"
  },
  "assumptions": ["图片未确定的参数在此说明"]
}
```

## 产品、重量与包装字段

| 字段 | 接口及兼容解释 |
| --- | --- |
| `product.material` | `metal`、`wood`、`mixed`。 |
| `product.metalWeightKg`、`woodWeightKg` | 明确主料分重 kg，优先于估算。 |
| `woodPieces[]` | `length/width/unit/quantity/notes`；可填 `thickness`（同 unit）、`densityKgM3`，默认 18mm、650kg/m³、数量 1。使用条件见报价规则。 |
| `product.netWeightKg/netWeightBasis` | 组装净重 kg 标 `assembled`；旧本体净重显式 `body` 后转换，缺标记阻止确定报价。 |
| `product.grossWeightKg` | 毛重 kg，拆分口径见报价规则。 |
| 配件 `includedInNetWeight` | 布尔，默认 true；非组装附带件 false。 |
| 配件 `weightKgPerUnit/weightSourceType/weightBasis` | kg/个；来源 `user/web/estimate`，后两者须有依据。 |
| `weightEstimates.accessoriesKg/accessoriesBasis` | 必需组装配件合计 kg 及依据。 |
| `weightEstimates.extrasKg/extrasBasis` | 非组装附带件合计 kg 及依据。 |
| `weightEstimates.packagingKg/packagingBasis` | 全部包材合计 kg 及依据，仅毛重时必需。 |
| `order.quantity/unitsPerCarton` | 采购产品数/每箱件数，默认 500/1，正整数。 |
| `processing.hasBoardProcessing` | 兼容旧输入的可选字段，不再决定人工费；开料、弯形、焊接、打磨合计成本统一按本体金属 kg×3 元/kg。 |
| `processing.needsCoating` | 本体是否喷涂，显式布尔。 |
| `packaging.protection[]` | `quantity` 为每件用量；`pricing=piece/volume/area/length` 分别按个/片/套、m³、m²、m；后三项提供三维 `dimensions`，未计价的维度填实际厚度/宽度，不填 0。可填 `densityKgM3`、`weightKgPerUnit`。 |
| `packaging.requireTopBottomEps/topBottomClearanceCm` | 默认 true/3cm，覆盖要求见报价规则。 |
| `packaging.epsExceptionBasis` | 用户明确免用或替代 EPS 时，`requireTopBottomEps=false` 并填依据。 |
| `product.date/imagePath` | 日期 YYYY-MM-DD，省略时按 Asia/Shanghai 当天；历史报价填固定日期。`imagePath` 为嵌入 BOM 的第一张产品图，绝对路径或相对输入 JSON 目录；也可用 `hwq_quote` 的 `imagePath` 传入。 |
| `rates` | 可覆盖 `metal/wood/coating/carton/tax/netMargin/managementToProfit`，默认 5/5/2.5/4.2/0.1/0.085/0.9。 |

合计重量字段置于顶层 `weightEstimates` 对象内；每个 kg 字段配对应 `Basis`。`weights` 输出 `net`（组装）、`body`（主料）、`metal`、`wood`、`accessories`（组装配件）、`extras`（非组装附带件）、`packaging`，另含 `netEstimated`、`netOrigin`、`netWeightBasis`；推导、校核及 BOM 变动规则见报价规则。

## 查价条目字段

配件及保护包材共用以下字段；1688 优先、留空及来源行为见报价规则。

| 字段 | 含义 |
| --- | --- |
| `unitPrice` | 转换后单价：配件元/个、包材按 `pricing` 单位。缺价省略或 null 且 `sourceType=pending`；明确用户 0 有效，不能填空字符串。 |
| `sourceType` | `user/web/template/estimate/pending`；普通显式单价必须声明来源。 |
| `provider/url/queriedAt/quoteUnit` | web 必填：供应商/平台、具体物料 http(s) 链接、实际日期 YYYY-MM-DD、原报价单位。 |
| `minOrderQty/priceTierMinQty/priceTierMaxQty` | 起订量/档位下限/上限，与核算价格同单位；未公布省略。 |
| `notes` | 规格、单位转换、估数量、价格说明；pending 记录实际搜索日期、关键词/图片方式及失败/受限原因。 |
| `estimateApproved` | 用户确认暂估单价才 true。 |
| `templateKey` | `m6-flange-screw` / `m6-nut` / `eps-15-volume`；准确匹配且未给价时填默认价，显式 pending 禁止回填。 |

缺价格式示例，须以实际日期及查找过程替换：

```json
{"name":"调节脚","spec":"M8，底盘直径30mm","quantity":4,"unitPrice":null,"sourceType":"pending","weightKgPerUnit":0.03,"weightSourceType":"estimate","weightBasis":"按实际规格估重并记依据","notes":"实际日期：1688文字搜索调节脚 M8 30mm；未取得匹配规格及采购档位有效价，留空待核。"}
```

## 1688 价格证据（13 项）

`hwq_1688_offer` / `hwq_1688_average` 返回并写入 `priceEvidence`；核算时强校验，不全则单价降为 pending。旧版 1688 记录须重新核对、补齐证据，不自动伪造。

| # | 字段 | 要求 |
| --- | --- | --- |
| 1 | `url` | 实际打开的 1688 商品详情 https 链接（`detail.1688.com/offer/数字.html`），不能用搜索列表页。 |
| 2 | `supplier` | 供应商名称。 |
| 3 | `title` | 商品标题。 |
| 4 | `queriedAt` | 当前查询日期 YYYY-MM-DD。 |
| 5 | `searchMethod` | `keyword` 或 `image`。 |
| 6 | `keywords` / `inputImage` | 实际关键词，或实际用于以图搜款的图片说明/临时路径；不把计划写成已搜索。 |
| 7 | `evidenceKind` | `visible_dom` 或 `screenshot`；不读 Cookie 或站点内部状态。 |
| 8 | `observedText` | 页面可见的规格、价格、单位、档位文字。 |
| 9 | `selectedSpec` / `specMatched` | 页面已选规格文本；实际核对匹配才 true，不能只凭外观相似。 |
| 10 | `originalPrice/currency/priceKind` | 原始数字单价、`CNY`、`regular`；不用首单价、样品价、券后价、混合区间最低价。 |
| 11 | `quoteUnit/targetUnit/targetUnitsPerQuoteUnit` | 原报价单位、BOM 单位、1 原报价单位含多少目标单位。如 3.2 元/100 个，目标元/个，系数 100；BOM 按副计的滑轨，1 副系数 1。 |
| 12 | `minOrderQty` | 原报价单位下的 MOQ；未公布就省略，不写 0、不补造。生成字段会乘换算系数，与核算采购需求同单位。 |
| 13 | `tierMinQty/tierMaxQty` | 原报价单位下的价格档位上下限；未公布省略。 |

示例：500 件产品每件 4 个配件，采购需求 2000 个；`originalPrice=3.2, quoteUnit=100个, targetUnit=个, targetUnitsPerQuoteUnit=100` 换算为 0.032 元/个。这仅说明算法，不是供应商报价。BOM 按副/套计时显式设置行的 `unit`，保证与 `targetUnit` 一致；体积、面积、长度包材分别用 m³、m²、m。

## 工具

### hwq_calculate

传入完整报价 JSON（`input` 对象或 `inputPath` 文件路径），返回：

- `ready`：无阻塞为 true；有阻塞时 `totals=null`，不给确定总价。
- `blockingIssues: [{code,message,severity,draftAllowed}]`；`severity` 为 `weight/dimensions/packaging/input`。只有 `code:"missing_price"` 的缺价问题 `draftAllowed:true`。
- `draftOnly`：布尔，表示“仅缺价阻塞”，可导出待核价草稿；重量矛盾、尺寸缺失、包装不完整时不得草稿。
- `weights`、`costs`、`totals`、`directCost`、`issues`、`assumptions`、`epsCoverage`；字段口径见报价规则与价格依据。

### hwq_quote

传入同一份报价 JSON，可加 `outputDir`（默认当前目录 `output/`）、`workDir`、`imagePath`；缺价草稿须显式传 `allowDraft:true`（仅 `missing_price` 阻塞可用）。流程为核算 → 生成工作簿计划 → 内置 Python 生成两工作表 Excel，返回 `output`（产物路径）、`sheets`（两工作表及行列范围）与 `checks`：

- `formulaErrors`：回读扫描到的 `#REF!` 等公式错误，应为空。
- `rowMap`：BOM 行号映射；`weights`、`totals`：导出时实际使用的重量与合计，应与 `hwq_calculate` 一致。
- `links`：底稿中写入的详情链接；`imageEmbedded`：产品图是否嵌入。
- 底稿含“脚本复算（只读校验）”区块，列出 JS 计算的成本/利润/未税/含税/净利率静态值。**没有 LibreOffice**，不得声称已用 Excel 实际重算，只能以 `checks` 与该区块核对。

### hwq_quote_batch

一次为多个产品出**一个** Excel：每个产品一张分表（顺序 `01_产品…`），前面自动加 `00_汇总`（23 列跨款对比表：SKU/名称/尺寸/外箱/净重/毛重/铁木主料重量/成本拆分/C/P/M/U/T/Q/备注风险）与 `00_口径说明`。每张分表上半是「报价BOM」、下半是「报价底稿」，跨表公式已改写为本表引用，打印区/列宽/合并区/图片/超链接随源表复制。

传入 `items: [{input|inputPath, name?, imagePath?, allowDraft?, note?}]`（数组顺序即分表顺序），可加 `outputDir`、`workDir`、`label`（批次名，进文件名与汇总标题）、`pythonPath`。流程为逐款 `buildQuote` → 汇总 → `python/merge_quotes.py` 合并 → `python/verify_merge.py` 静态校验 → 命名 `<日期>_<label>[_待核价]_报价_vNN.xlsx` 落盘（vNN 自动避让同批已有文件）。返回 `output`、`sheets[{sheet,sku,frontRows,bottomRows,bottomStart,checks}]`、`summary`、`verification`（逐分表值/公式/合并区/链接/图片比对）、`checks`（逐款 formulaErrors/links/imageEmbedded）。

任一款未就绪即整体失败（缺价必须显式给该款 `allowDraft:true`）；只出草稿时文件名带「待核价」。**多产品同单报价必须用它**，不要逐款生成多个文件；单产品仍用 `hwq_quote`。

### hwq_1688_login

`action: "status" | "open" | "show" | "hide" | "flush"`：查登录态、打开登录页、把窗口调到前台、收回后台、把登录态强制落盘到持久 Chrome profile（`flush` 会优雅关闭并按同一 profile 重启插件 Chrome，登录态保留，返回 `flushed.ok` 与原因；不读取也不导出 Cookie 值）。扫码/验证码由用户完成，工具不代填凭据。插件 Chrome 默认后台最小化、查价不抢前台；只有登录墙/验证码且检测到用户已离开 ≥ `HWQ_SURFACE_IDLE_MS`（默认 120000ms）时才自动置前，窗口模式用 `HWQ_WINDOW=auto|background|visible` 指定（默认 `auto`）。`open`/`show` 总是置前，`hide` 收回后台。

### hwq_1688_search

关键词搜索（`keywords`）或以图搜款（`imagePath`），`limit` 默认 5，二者只能二选一。返回 `method`（`keyword`/`image`）、实际 `keyword`、`searchedAt`、候选 `candidates[{url,title,priceText,unitText,moqText,company,soldText,matchHint}]`，以及 `rawCount`、`note`、`blocked`、`screenshot`。搜索候选价不是详情成交价，须再用 `hwq_1688_offer` 打开。

### hwq_1688_offer

传入详情 `url`，返回标题、供应商、单位、SKU 列表 `offers[{skuId,props,priceText,price,unit,moqText}]`、`capturedAt` 与 `domNotes`；据此核对所选规格与普通批发价，组装 `priceEvidence`。

### hwq_1688_average

传入同规格 `samples`（每条完整 `priceEvidence`，且须带相同 `comparisonKey`、`priceBasis`）、`comparisonKey`、`targetUnit`、`priceBasis` 与 `demand:{quantity,unit}`（quantity=每件用量×订单量），做单位归一、商品+SKU 去重、算术平均，返回 `samples/excluded/sampleCount/mean/min/max` 与排除原因。样本不足 2 条标为单样本；采购量使样本 MOQ/档位失效时须重新查价。

## 输出与复核

`hwq_calculate` 的 `costs` 含 `main/accessories/processing/coating/protection/carton/fixedPackaging`；`totals` 含 `profit/management/beforeTax/tax/afterTax/netMargin`。工具只做算术与导出，不判断图片内容、不替代查价证据。参数校验失败时按错误提示修正 JSON，不绕过校验；不得为通过校验编造数值。

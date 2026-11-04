# 输入及执行接口

报价行为以[报价规则](quotation-rules.md)为准，本文件记录JSON及命令。每次一个产品；数字用数值类型，不写“12kg”。尺寸显式为`cm`、`mm`或`m`，重量kg。以下仅为接口例子，不是供应商报价，日期、估算和搜索记录均须换成实际信息。

```json
{
  "product": {
    "name": "产品名称", "sku": "SKU", "date": "2026-10-04", "material": "mixed",
    "netWeightKg": 12, "netWeightBasis": "assembled", "grossWeightKg": 16.8,
    "dimensions": {"length":120,"width":60,"height":75,"unit":"cm"},
    "cartonDimensions": {"length":129,"width":65,"height":18,"unit":"cm"},
    "images": ["/absolute/path/product.png"]
  },
  "order": {"quantity":500,"unitsPerCarton":1},
  "processing": {"hasBoardProcessing":true,"needsCoating":true},
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
    "notes":"上下各一整片；外箱最大面129×65cm，长宽各留3cm合计冗余"
  },
  "assumptions": ["图片未确定的参数在此说明"]
}
```

## 产品、重量与包装字段

| 字段 | 接口及兼容解释 |
| --- | --- |
| `product.material` | `metal`、`wood`、`mixed`。 |
| `product.metalWeightKg`、`woodWeightKg` | 明确主料分重kg，优先于估算。 |
| `woodPieces[]` | `length/width/unit/quantity/notes`；可填`thickness`（同unit）、`densityKgM3`，默认18mm、650kg/m³、数量1。使用条件见报价规则。 |
| `product.netWeightKg/netWeightBasis` | 组装净重kg标`assembled`；旧本体净重显式`body`后转换，缺标记阻止确定报价。 |
| `product.grossWeightKg` | 毛重kg，拆分口径见报价规则。 |
| 配件`includedInNetWeight` | 布尔，默认true；非组装附带件false。 |
| 配件`weightKgPerUnit/weightSourceType/weightBasis` | kg/个；来源`user/web/estimate`，后两者须有依据。 |
| `weightEstimates.accessoriesKg/accessoriesBasis` | 必需组装配件合计kg及依据。 |
| `weightEstimates.extrasKg/extrasBasis` | 非组装附带件合计kg及依据。 |
| `weightEstimates.packagingKg/packagingBasis` | 全部包材合计kg及依据，仅毛重时必需。 |
| `order.quantity/unitsPerCarton` | 采购产品数/每箱件数，默认500/1，正整数。 |
| `processing.hasBoardProcessing` | 兼容旧输入的可选字段，不再决定人工费；开料、弯形、焊接、打磨合计成本统一为本体金属重量kg×3元/kg。 |
| `processing.needsCoating` | 本体是否喷涂，显式布尔。 |
| `packaging.protection[]` | `quantity`为每件用量；`pricing=piece/volume/area/length`分别按个/片/套、m³、m²、m；后三项提供三维`dimensions`，未计价的维度填实际厚度/宽度，不填0。可填`densityKgM3`、`weightKgPerUnit`。 |
| `packaging.requireTopBottomEps/topBottomClearanceCm` | 默认true/3cm，覆盖要求见报价规则。 |
| `packaging.epsExceptionBasis` | 用户明确免用或替代EPS时，requireTopBottomEps=false并填依据。 |
| `product.date/images` | 日期YYYY-MM-DD，省略时按Asia/Shanghai当天；历史报价填固定日期。图片绝对路径或相对输入JSON目录。 |
| `rates` | 可覆盖`metal/wood/coating/carton/tax/netMargin/managementToProfit`，默认5/5/2.5/4.2/0.1/0.085/0.9。 |

合计重量字段置于顶层`weightEstimates`对象内；每个Kg字段配对应Basis。`weights`输出`net`（组装）、`body`（主料）、`metal`、`wood`、`accessories`（组装配件）、`extras`（非组装附带件）、`packaging`；推导、校核及BOM变动规则见报价规则。

## 查价条目字段

配件及保护包材共用以下字段；1688优先、留空及来源行为见报价规则。

| 字段 | 含义 |
| --- | --- |
| `unitPrice` | 转换后单价：配件元/个、包材按pricing单位。缺价省略或null且sourceType=pending；明确用户0有效，不能填空字符串。 |
| `sourceType` | `user/web/template/estimate/pending`；普通显式单价必须声明来源。 |
| `provider/url/queriedAt/quoteUnit` | web必填：供应商/平台、具体物料http(s)链接、实际日期YYYY-MM-DD、原报价单位。 |
| `minOrderQty/priceTierMinQty/priceTierMaxQty` | 起订量/档位下限/上限，与核算价格同单位；未公布省略。 |
| `notes` | 规格、单位转换、估数量、价格说明；pending记录实际搜索日期、关键词/图片方式及失败/受限原因。 |
| `estimateApproved` | 用户确认暂估单价才true。 |
| `templateKey` | `m6-flange-screw/m6-nut/eps-15-volume`；准确匹配且未给价时填默认价，显式pending禁止回填。 |

缺价格式示例，须以实际日期及查找过程替换：

```json
{"name":"调节脚","spec":"M8，底盘直径30mm","quantity":4,"unitPrice":null,"sourceType":"pending","weightKgPerUnit":0.03,"weightSourceType":"estimate","weightBasis":"按实际规格估重并记依据","notes":"实际日期：1688文字搜索调节脚 M8 30mm；未取得匹配规格及采购档位有效价，留空待核。"}
```

## 1688浏览器证据接口（2.3.0）

先完整读取[1688本机浏览器查价](1688-browser-workflow.md)。`node scripts/1688-lookup.mjs plan input.json` 生成尚未执行的任务清单；脚本不会打开网页，实际操作使用宿主提供的浏览器/电脑工具。

`node scripts/1688-lookup.mjs validate evidence.json <目标计价单位采购需求>` 校验从真实详情页读取的证据，输出可合并到配件/包材行的 `unitPrice/sourceType/provider/url/queriedAt/quoteUnit/notes/priceEvidence` 与换算后的MOQ/档位。校验通过不是访问真实性证明。

`priceEvidence`字段：

| 字段 | 含义 |
| --- | --- |
| `url/supplier/title/queriedAt` | 实际打开的https商品详情链接、供应商、标题、当前查询日期；不能用搜索列表页。 |
| `searchMethod/keywords/inputImage` | keyword或image；分别记录实际关键词或实际用于以图搜款的图片说明/临时路径，不把计划写成已搜索。 |
| `evidenceKind/observedText` | visible_dom或screenshot，及可见文字/截图中读到的规格、价格、单位、档位；不读取Cookie或站点内部状态。 |
| `selectedSpec/specMatched` | 页面已选规格文本，实际核对匹配才true；不能只凭外观相似。 |
| `originalPrice/currency/priceKind` | 原始数字单价、CNY、regular；不使用首单价、样品价、券后价、混合区间最低价。 |
| `quoteUnit/targetUnit/targetUnitsPerQuoteUnit` | 原报价单位、BOM单位、1原报价单位包含多少目标单位。如3.2元/100个，目标元/个，系数100；BOM按副计的滑轨，1副系数1。 |
| `minOrderQty/tierMinQty/tierMaxQty` | 原报价单位下的MOQ/档位；未公布就省略，不写0、不补造。生成字段会乘换算系数，与核算采购需求同单位。 |

例如500件产品每件4个配件，目标采购量2000个；`originalPrice=3.2,quoteUnit=100个,targetUnit=个,targetUnitsPerQuoteUnit=100`转换为0.032元/个。这仅说明算法，不是供应商报价。若配件BOM按副/套计，显式设置行的`unit`，保证与`priceEvidence.targetUnit`一致；体积、面积、长度包材分别用m³、m²、m。

`calculate`对来源链接为1688的web单价强制校验证据、日期、单价及MOQ/档位换算；未核对的单价变为pending，不能形成确定总价。旧1688记录需重新核对/补证据，不自动伪造。用户给价、模板准确规格价和其他平台明确来源保持原逻辑。

工具故障至少记录channel、status、message、实际已执行的keywords/inputImage及可确认的URL；`classifyFailure`仅分类诊断，不能据报错推测站点登录状态。登录/验证码等仅根据真实页面记录。任务未执行写not_started，不虚构逐项搜索。记录写入行notes，供报价底稿查看。

## 参数与运行

用`load_workspace_dependencies`实际返回的Node、Python、node_modules路径。先检查，再导出：

```text
<Node> scripts/calculate.mjs <input.json>
<Node> scripts/quote.mjs <input.json> --python <Python> --node-modules <提供的node_modules> --output-dir <本机报价单目录>
```

若环境禁止Node创建子进程（EPERM），先创建临时目录，分两步执行（扩行数取配件条目数）：

```text
<Python> scripts/prepare_template.py assets/对外报价BOM表.xlsx <临时目录/expanded.xlsx> --accessories <配件条目数>
<Node> scripts/quote.mjs <input.json> --prepared-template <临时目录/expanded.xlsx> --node-modules <提供的node_modules> --output-dir <本机报价单目录>
```

两种方式格式相同，图片尺寸从文件读取，不另启程序。报告`finalized=false`时单独执行`nativeFinalizeCommand`所列`finalize_xlsx.py`命令，只补原生超链接及打印范围，不改金额、公式、样式或图片；完成后交付。

`calculate`返回`ready/issues/weights/costs/totals`等；blocking时totals=null，默认停止。仅缺有效单价时agent自动加`--allow-draft`，留空、NA和其他检查规则见报价规则。

首次配置设备目录：

```text
<Node> scripts/quote.mjs --configure --output-dir <本机报价单目录>
```

配置写当前工作目录`.hardware-quote-device.json`；`--profile`指定配置文件。`--work-dir`指定临时根目录（默认系统临时目录），每轮自动新建独立`hardware-quote-随机值`子目录，以报告`workDir`为准。`--preview-dir`可指定外部预览目录，默认随本轮临时目录。

默认不写重复的`calculation.json`，自产扩行模板导入后即删除；需要诊断留存时加`--diagnostics`。CLI报告不返回内存中的workbook；程序调用仍默认返回，需要批量释放内存时设`returnWorkbook:false`。批量建议逐件独立进程，交付结果仍每产品一份两表Excel。

每张预览最多96行，大底稿以`_01.png/_02.png`等分片；完整路径列表在`previewFiles`，**须查看全部分片**后交付，不能只检查首片。

确认预览和`finalized=true`后，执行报告`cleanupCommand`，等价于：

```text
<Node> scripts/quote.mjs --cleanup <报告workDir>
```

清理器仅删除本轮独立临时目录，拒绝未finalized、归属不符、最终文件位于目录内部或已丢失、目录链接等情况；保留外部preview-dir、输入、设备配置及历史报价。SDK检查边文件不交付。若EPERM下独立finalizer已完成而marker未更新，cleanupCommand仍为null；保留恢复资料，或按报价规则只清明确属于本轮的中间文件，不强制绕过清理限制。

## 复核

`<Node> scripts/test-calculate.mjs`检查重量口径、公式、缺价和采购档位。导出器另比较Excel合计与独立计算、检查公式错误并渲染两表；交付前仍须实际查看所有预览分片。





1688查价遇到多个结果时，按 references/1688-browser-workflow.md 的同规格多结果规则执行：核查首批3—5个相关候选，全部有效同规格报价归一后取算术平均，保存每条证据和排除原因；使用1688-lookup.mjs average生成均价记录，不以单一供应商证据冒充均价。开料、弯形、焊接、打磨合计成本仍为本体金属重量×3元/kg。

/**
 * 五金产品报价 (hardware-quote) for DeepSeek Harness.
 *
 * Host bundle that installs
 *   1. the `hardware-quote` agent skill (bundled, resolved from `skill/`), and
 *   2. the `hwq_*` tool family:
 *        hwq_calculate      pricing engine (no I/O)
 *        hwq_quote          two-sheet Excel quote export (openpyxl)
 *        hwq_1688_login     1688 login state of the plugin's persistent Chrome
 *        hwq_1688_search    keyword / image search on 1688
 *        hwq_1688_offer     offer-detail SKU + price extraction
 *        hwq_1688_average   normalized arithmetic-mean evidence record
 *
 * Every tool is thin: argument validation + module call + model-readable text.
 * Business rules live in `lib/pricing.mjs` / `lib/lookup.mjs`; browser work in
 * `lib/cdp.mjs` / `lib/ali1688.mjs`; workbook authoring in `python/build_workbook.py`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { calculate, VERSION } from './pricing.mjs'
import { buildQuote } from './quote.mjs'
import { averagePriceEvidence, validatePriceEvidence } from './lookup.mjs'
import * as ali from './ali1688.mjs'

export const name = 'hardware-quote-dsh-plugin'
export const inject = ['tools']

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const skillDir = path.join(pkgRoot, 'skill')

export const SKILL_NAME = 'hardware-quote'
const SKILL_DESCRIPTION =
  '五金/铁木产品报价：根据产品图片、尺寸、组装净重或毛重识别配件与主料，查 1688 证据价并按约定规则生成保留 BOM 模板的两页 Excel 报价与底稿。用于产品核价、批量报价与复核已有报价。'

const RENDER_LIMIT = 24000

function readSkillMarkdown() {
  const file = path.join(skillDir, 'SKILL.md')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return `# 五金产品报价\n\n技能正文缺失（${file}: ${error?.message ?? error}）。请重新安装插件。\n`
  }
  // A leading YAML frontmatter is not part of the DSH skill body.
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}

function text(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return body.length > RENDER_LIMIT ? body.slice(0, RENDER_LIMIT) + '\n…（输出过长，已截断；完整结构见工具返回值）' : body
}

const renderObject = (args, value) => [{ type: 'text', text: text(value) }]

function fail(message) {
  const error = new Error(message)
  error.isArgumentError = true
  return error
}

function requireObject(args) {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) throw fail('参数必须是 JSON 对象。')
  return args
}

/** Resolve `{input}` / `{inputPath}` into a validated product input object. */
function resolveInput(args) {
  const hasInline = args.input != null && typeof args.input === 'object'
  const hasPath = typeof args.inputPath === 'string' && args.inputPath.trim() !== ''
  if (hasInline && hasPath) throw fail('请只提供 input 或 inputPath 之一。')
  if (!hasInline && !hasPath) throw fail('缺少产品输入：请提供 input（对象）或 inputPath（产品 JSON 文件路径）。')
  if (hasInline) return { input: args.input, inputPath: undefined }
  const inputPath = path.resolve(args.inputPath)
  let raw
  try {
    raw = fs.readFileSync(inputPath, 'utf8')
  } catch (error) {
    throw fail(`读取产品输入失败：${inputPath}（${error?.message ?? error}）`)
  }
  try {
    return { input: JSON.parse(raw), inputPath }
  } catch (error) {
    throw fail(`产品输入不是合法 JSON：${inputPath}（${error?.message ?? error}）`)
  }
}

const money = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : String(value ?? '—'))

function calculateSummary(result) {
  const weights = result.weights ?? {}
  const costs = result.costs ?? {}
  const totals = result.totals ?? null
  const packaging =
    [costs.protection, costs.carton, costs.fixedPackaging].every((value) => typeof value === 'number')
      ? costs.protection + costs.carton + costs.fixedPackaging
      : null
  const lines = [
    `产品：${result.product?.name ?? '（未命名）'}${result.product?.date ? `｜日期 ${result.product.date}` : ''}  版本：${result.version ?? VERSION}`,
    `状态：${result.ready === true ? 'READY（可出正式报价）' : result.draftOnly === true ? 'DRAFT-ONLY（仅缺价阻塞，可导草稿）' : 'BLOCKED（存在非缺价阻塞，不能出报价）'}`,
    `重量：组装净重 ${money(weights.net)} kg｜主料 ${money(weights.body)} kg｜金属 ${money(weights.metal)} kg｜木 ${money(weights.wood)} kg｜配件 ${money(weights.accessories)} kg${weights.gross != null ? `｜毛重 ${money(weights.gross)} kg` : ''}`,
    `成本：主料 ${money(costs.main)}｜采购配件 ${money(costs.accessories)}｜加工(3元/kg) ${money(costs.processing)}｜喷涂 ${money(costs.coating)}｜保护包材 ${money(costs.protection)}｜纸箱 ${money(costs.carton)}｜固定包装 ${money(costs.fixedPackaging)}｜包装小计 ${money(packaging)}｜每件成本 C=${money(result.directCost)}`,
    totals
      ? `报价：利润 P=${money(totals.profit)}｜管理分摊 M=${money(totals.management)}｜未税 U=${money(totals.beforeTax)}｜税 T=${money(totals.tax)}｜含税 Q=${money(totals.afterTax)}｜净利率 ${typeof totals.netMargin === 'number' ? (totals.netMargin * 100).toFixed(3) + '%' : '—'}`
      : '报价：未形成（存在阻塞项，totals 为空）',
    `采购量 ${result.order?.quantity ?? '—'} 件｜每箱 ${result.order?.unitsPerCarton ?? '—'} 件`,
  ]
  const blocking = Array.isArray(result.blockingIssues) ? result.blockingIssues : []
  if (blocking.length) {
    lines.push('', '问题清单：')
    for (const issue of blocking) {
      lines.push(`- [${issue.severity ?? 'input'}${issue.draftAllowed ? '·可草稿' : '·阻塞'}] ${issue.code ?? ''} ${issue.message ?? ''}`)
    }
  }
  const pending = [
    ...(Array.isArray(result.accessories) ? result.accessories : []),
    ...(Array.isArray(result.protection) ? result.protection : []),
  ].filter((row) => row?.sourceType === 'pending' || row?.unitPrice == null)
  if (pending.length) {
    lines.push('', `待核价 ${pending.length} 项：` + pending.map((row) => row.name ?? row.spec ?? '?').join('、'))
  }
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────── tools

const calculateTool = {
  name: 'hwq_calculate',
  description:
    '按五金报价规则计算一个产品的重量拆分、成本、加工费、包装费、利润、未税与含税报价（纯计算，不写文件）。输入为产品 JSON：product/order/processing/accessories/woodPieces/weightEstimates/packaging/rates/assumptions。返回 ready、draftOnly、blockingIssues（只有缺价类允许草稿）、weights、costs、totals 与逐行明细。报价规则细节见 hardware-quote 技能的 references/quotation-rules.md。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      input: { type: 'object', description: '产品输入对象（与 inputPath 二选一）。' },
      inputPath: { type: 'string', description: '产品输入 JSON 文件路径（与 input 二选一）。' },
    },
  },
  output: {
    schema: { type: 'object', description: '计算结果对象（含 summary 文本）。' },
    render: (args, value) => [{ type: 'text', text: value?.summary ?? text(value) }],
  },
  async execute(args) {
    const { input } = resolveInput(requireObject(args))
    const result = calculate(input)
    return { ...result, summary: calculateSummary(result) }
  },
}

const quoteTool = {
  name: 'hwq_quote',
  description:
    '生成两工作表 Excel 报价（工作表「报价BOM」沿用对外报价BOM表模板并扩行、加未税报价行；「报价底稿」含公共参数、逐条 1688 证据与均价记录、估算依据、脚本复算校验值）。输入为产品 JSON；缺价时可传 allowDraft=true 导出草稿（金额写 #N/A），重量矛盾/尺寸缺失/包装不完整仍会拒绝导出。返回输出文件路径、工作表范围与 checks（公式错误、行号映射、重量、合计、超链接、图片）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      input: { type: 'object', description: '产品输入对象（与 inputPath 二选一）。' },
      inputPath: { type: 'string', description: '产品输入 JSON 文件路径（与 input 二选一）。' },
      outputDir: { type: 'string', description: '输出目录；默认当前工作目录下的 output/。' },
      workDir: { type: 'string', description: '中间文件目录；默认在系统临时目录下新建独立目录。' },
      imagePath: { type: 'string', description: '产品图片路径（嵌入 BOM 图片区）；缺省时尝试使用 input.product.imagePath。' },
      allowDraft: { type: 'boolean', description: '仅缺价阻塞时允许导出草稿；默认 false。' },
    },
  },
  output: {
    schema: { type: 'object', description: '导出结果（output/sheets/checks/summary）。' },
    render: (args, value) => [{ type: 'text', text: value?.summary ?? text(value) }],
  },
  async execute(args) {
    const params = requireObject(args)
    const { input, inputPath } = resolveInput(params)
    const allowDraft = params.allowDraft === true
    const calc = calculate(input)
    if (calc.ready !== true) {
      const blocking = Array.isArray(calc.blockingIssues) ? calc.blockingIssues : []
      const nonDraft = blocking.filter((issue) => issue.draftAllowed !== true)
      if (calc.draftOnly !== true || !allowDraft || nonDraft.length > 0) {
        const why = nonDraft.length
          ? nonDraft.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')
          : '- 仅缺价阻塞，但未传 allowDraft=true'
        throw fail(`报价未就绪，拒绝导出：\n${why}\n\n先用 hwq_calculate 查看 blockingIssues；缺价请补 1688 证据价，缺少输入请向用户确认。`)
      }
    }
    const res = await buildQuote(
      { ...input, allowDraft },
      {
        outputDir: typeof params.outputDir === 'string' ? path.resolve(params.outputDir) : path.resolve(process.cwd(), 'output'),
        workDir: typeof params.workDir === 'string' ? path.resolve(params.workDir) : undefined,
        imagePath:
          typeof params.imagePath === 'string'
            ? path.resolve(params.imagePath)
            : typeof input?.product?.imagePath === 'string'
              ? path.resolve(path.dirname(inputPath ?? process.cwd()), input.product.imagePath)
              : undefined,
      },
    )
    const checks = res?.checks ?? {}
    const summary = [
      `已导出：${res.output}`,
      `工作表：${(res.sheets ?? []).map((sheet) => `${sheet.name}(${sheet.lastRow}×${sheet.lastColumn ?? 'I'})`).join('、')}`,
      `公式错误：${Array.isArray(checks.formulaErrors) && checks.formulaErrors.length ? checks.formulaErrors.join('; ') : '无'}`,
      `图片：${checks.imageEmbedded ? '已嵌入' : '未嵌入'}｜超链接：${Array.isArray(checks.links) ? checks.links.length : 0} 条`,
      `重量：组装净重 ${money(checks.weights?.net)} kg｜主料 ${money(checks.weights?.body)} kg｜金属 ${money(checks.weights?.metal)} kg`,
      `金额：成本 C=${money(checks.totals?.cost)}｜利润 P=${money(checks.totals?.profit)}｜未税 U=${money(checks.totals?.untaxed)}｜含税 Q=${money(checks.totals?.taxed)}`,
      '',
      '核对要求：底稿「脚本复算（只读校验）」区块是脚本静态值；本机没有 LibreOffice/Excel 重算引擎，不要声称已用 Excel 验证公式结果。',
    ].join('\n')
    return { ...res, summary }
  },
}

const loginTool = {
  name: 'hwq_1688_login',
  description:
    '检查/打开插件自带持久 Chrome 的 1688 登录态。action=status 返回是否已登录及证据；action=open 打开 1688 登录页（扫码由用户完成，绝不读取或保存账号密码）；action=flush 把登录 cookie 强制落盘（会优雅关闭并按同一 profile 重启插件 Chrome，登录态保留，不会读取或导出 cookie 值）。登录态保存在本机 profile，重启后仍有效。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['status', 'open', 'flush'], description: '要执行的动作。' },
    },
  },
  output: {
    schema: { type: 'object', description: '登录态结果。' },
    render: (args, value) => [
      {
        type: 'text',
        text:
          value?.summary ??
          `1688 登录态：${value?.loggedIn ? '已登录' : '未登录'}${value?.memberName ? `（${value.memberName}）` : ''}`,
      },
    ],
  },
  async execute(args) {
    const { action } = requireObject(args)
    if (action === 'status') {
      const result = await ali.loginStatus()
      const summary = result.loggedIn
        ? `1688 已登录${result.memberName ? `（${result.memberName}）` : ''}。证据：${result.evidence}｜采集时间 ${result.capturedAt}`
        : `1688 未登录。请在插件 Chrome 窗口内扫码登录（或调用 hwq_1688_login action=open 打开登录页）后重试。证据：${result.evidence}`
      return { ...result, summary }
    }
    if (action === 'open') {
      const result = await ali.openLoginPage()
      return { ...result, summary: `已打开 1688 登录页：${result.url}\n请在该窗口扫码登录；完成后调用 action=status 复核。登录态会持久化在本机 profile。` }
    }
    const flushed = typeof ali.flushLogin === 'function'
      ? await ali.flushLogin()
      : { ok: false, reason: '当前 ali1688 版本未提供 flushLogin。' }
    const state = await ali.loginStatus()
    const lines = [
      flushed.ok === true
        ? '已把 1688 登录 cookie 落盘到插件持久 profile（优雅关闭并重启 Chrome，登录态保留）。'
        : `未能落盘：${flushed.reason ?? '未知原因'}。登录会话仍在当前 Chrome profile 中，正常关闭窗口时 Chrome 会自动落盘；本工具不读取也不导出 cookie 值。`,
      `落盘后登录态：${state.loggedIn ? `已登录${state.memberName ? `（${state.memberName}）` : ''}` : '未登录'}`,
      `证据：${state.evidence}`,
    ]
    return { ...state, flushed, summary: lines.join('\n') }
  },
}

const searchTool = {
  name: 'hwq_1688_search',
  description:
    '在 1688 搜索零部件/材料候选（插件自带 Chrome，自动复用登录态）。支持 keywords 关键词搜索与 imagePath 以图搜款。返回候选列表，每项含真实详情 URL、标题、价格文本、单位、MOQ、供应商，以及 capturedAt 与 evidence（说明获取方式与可见 DOM 片段）。只返回真实抓取结果，找不到就返回空列表与原因，不编造。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      keywords: { type: 'string', description: '关键词，如「内六角法兰面螺丝 M6*15」。' },
      imagePath: { type: 'string', description: '以图搜款的本地图片路径。' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: '候选数量上限，默认 5。' },
      sameSpecOnly: { type: 'boolean', description: '仅保留规格（尺寸/材质/单位）明显匹配的候选；默认 false 时全部返回并标注 matchHint。' },
    },
  },
  output: {
    schema: { type: 'object', description: '搜索结果（candidates[]）。' },
    render: (args, value) => [{ type: 'text', text: value?.summary ?? text(value) }],
  },
  async execute(args) {
    const params = requireObject(args)
    const keywords = typeof params.keywords === 'string' ? params.keywords.trim() : ''
    const imagePath = typeof params.imagePath === 'string' ? path.resolve(params.imagePath) : ''
    if (!keywords && !imagePath) throw fail('请提供 keywords 或 imagePath 之一。')
    if (keywords && imagePath) throw fail('keywords 与 imagePath 只能二选一。')
    const result = await ali.searchOffers({
      keywords: keywords || undefined,
      imagePath: imagePath || undefined,
      limit: Number.isInteger(params.limit) ? params.limit : 5,
      sameSpecOnly: params.sameSpecOnly === true,
    })
    const lines = [
      `搜索方式：${result.method}｜关键词：${result.keyword ?? '（以图搜款）'}｜时间：${result.searchedAt}`,
      `返回候选 ${result.candidates?.length ?? 0} 个（原始结果 ${result.rawCount ?? '?'}）${result.blocked ? `｜受阻：${result.blocked}` : ''}`,
    ]
    if (result.note) lines.push(`说明：${result.note}`)
    for (const [index, item] of (result.candidates ?? []).entries()) {
      lines.push(
        `${index + 1}. ${item.title ?? '（无标题）'}`,
        `   URL：${item.url}`,
        `   价格：${item.priceText ?? '—'}｜单位：${item.unitText ?? '—'}｜MOQ：${item.moqText ?? '—'}｜供应商：${item.company ?? '—'}`,
        item.matchHint ? `   规格判断：${item.matchHint}` : '',
      )
    }
    for (const [index, item] of (result.nearMisses ?? []).entries()) {
      lines.push(
        `近似候选 ${index + 1}（未通过标题级规格初筛，必须进 hwq_1688_offer 核对，不得当作已匹配证据）：${item.title ?? '（无标题）'}`,
        `   URL：${item.url}`,
        `   价格：${item.priceText ?? '—'}｜供应商：${item.company ?? '—'}｜未通过原因：${item.specMatchReason ?? '—'}`,
      )
    }
    if (result.screenshot) lines.push('', `截图：${result.screenshot}`)
    return { ...result, summary: lines.filter(Boolean).join('\n') }
  },
}

const offerTool = {
  name: 'hwq_1688_offer',
  description:
    '打开一个 1688 商品详情页并抽取证据：标题、供应商、单位、规格 SKU 列表（属性、价格文本、数值价、MOQ/阶梯）。用于把搜索候选变成可录入的采购证据。返回 capturedAt、domNotes 与实际看到的规格；页面要求登录/验证码时返回 blocked 与截图，不绕过。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'detail.1688.com/offer/<id>.html 形式的详情页 URL。' },
      skuHint: { type: 'string', description: '目标规格提示（如「M6*15」），用于标注 selectedSku。' },
    },
  },
  output: {
    schema: { type: 'object', description: '详情证据。' },
    render: (args, value) => [{ type: 'text', text: value?.summary ?? text(value) }],
  },
  async execute(args) {
    const params = requireObject(args)
    const url = typeof params.url === 'string' ? params.url.trim() : ''
    if (!url) throw fail('缺少 url。')
    const result = await ali.openOffer(url, { skuHint: typeof params.skuHint === 'string' ? params.skuHint : undefined })
    const lines = [
      `详情：${result.url}`,
      `标题：${result.title ?? '—'}｜供应商：${result.company ?? '—'}｜单位：${result.unit ?? '—'}`,
      `采集时间：${result.capturedAt}${result.blocked ? `｜受阻：${result.blocked}` : ''}`,
      `可见 SKU ${result.offers?.length ?? 0} 个：`,
    ]
    for (const sku of result.offers ?? []) {
      lines.push(`- ${sku.skuId ?? '?'} ${sku.props ?? ''}｜${sku.priceText ?? '—'}｜数值 ${sku.price ?? '—'}｜MOQ ${sku.moqText ?? '—'}${sku.selected ? ' ← 目标规格' : ''}`)
    }
    if (result.domNotes) lines.push('', `DOM 观察：${result.domNotes}`)
    if (result.screenshot) lines.push(`截图：${result.screenshot}`)
    return { ...result, summary: lines.join('\n') }
  },
}

const EVIDENCE_FIELDS =
  'url（detail.1688.com/offer/<id>.html 真实详情链接）、supplier、title、selectedSpec、quoteUnit（原价单位）、targetUnit、observedText（页面实际可见文字）、queriedAt（YYYY-MM-DD 真实查询日）、evidenceKind（visible_dom|screenshot）、searchMethod（keyword|image）、keywords 或 inputImage、specMatched（必须为 true）、currency（CNY）、priceKind（regular，不得用起订价/样品价/券后价）、originalPrice（该档位普通单价，数字）、targetUnitsPerQuoteUnit（1 quoteUnit 含多少个 targetUnit）、minOrderQty/tierMinQty/tierMaxQty（可选，原单位数量档位）'

const averageTool = {
  name: 'hwq_1688_average',
  description:
    `把多条同规格 1688 证据归一后取算术平均，生成均价记录（method=arithmetic_mean，含 comparisonKey/targetUnit/priceBasis/demand/samples/excluded/sampleCount/mean/min/max）。只有同规格、同目标单位、同税运口径且逐条通过证据校验的样本才计入；按详情路径+已选规格去重。样本字段：${EVIDENCE_FIELDS}。不足 2 条有效样本时明示单样本。改价、改订单量或改口径都会让旧样本失效，必须重新采集。`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['samples', 'demand', 'comparisonKey', 'targetUnit', 'priceBasis'],
    properties: {
      samples: { type: 'array', description: `证据样本数组，字段要求：${EVIDENCE_FIELDS}`, items: { type: 'object' } },
      demand: {
        type: 'object',
        description: '采购需求（按目标计价单位）：quantity = 每件用量 × 订单量；perUnit/orderQuantity 可选，用于复核。',
        additionalProperties: false,
        required: ['quantity', 'unit'],
        properties: {
          quantity: { type: 'number', description: '采购总需求量（目标计价单位）。' },
          unit: { type: 'string', description: '需求单位，必须与 targetUnit 一致。' },
          perUnit: { type: 'number', description: '每件产品用量（可选，用于复核）。' },
          orderQuantity: { type: 'number', description: '订单件数（可选，用于复核）。' },
        },
      },
      comparisonKey: { type: 'string', description: '规格比较键，如「M6×15 不锈钢 内六角法兰面」。' },
      targetUnit: { type: 'string', description: '目标计价单位，如「个」。' },
      priceBasis: { type: 'string', description: '价格口径，如「含税不含运出厂价」。' },
    },
  },
  output: {
    schema: { type: 'object', description: '均价记录（含 summary 文本）。' },
    render: (args, value) => [{ type: 'text', text: value?.summary ?? text(value) }],
  },
  async execute(args) {
    const params = requireObject(args)
    if (!Array.isArray(params.samples) || params.samples.length === 0) throw fail('samples 必须是非空数组。')
    const demand = params.demand
    if (demand == null || typeof demand !== 'object') throw fail('demand 必须是 {quantity, unit}。')
    const quantity = demand.quantity
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      throw fail('demand.quantity 必须是正数（目标计价单位下的采购总量 = 每件用量 × 订单量）。')
    }
    for (const key of ['comparisonKey', 'targetUnit', 'priceBasis']) {
      if (typeof params[key] !== 'string' || params[key].trim() === '') {
        throw fail(`缺少必填参数 ${key}：均价必须明确对比规格、目标计价单位与税运口径。`)
      }
    }
    if (typeof demand.unit === 'string' && demand.unit !== params.targetUnit) {
      throw fail(`demand.unit（${demand.unit}）与 targetUnit（${params.targetUnit}）不一致，请先统一计价单位。`)
    }
    const perUnit = Number(demand.perUnit)
    const orderQuantity = Number(demand.orderQuantity)
    if (Number.isFinite(perUnit) && Number.isFinite(orderQuantity) && Math.abs(perUnit * orderQuantity - quantity) > 1e-9) {
      throw fail(`demand.quantity（${quantity}）与 perUnit×orderQuantity（${perUnit}×${orderQuantity}=${perUnit * orderQuantity}）不一致。`)
    }
    const issuesByIndex = params.samples.map((sample, index) => ({
      index,
      url: sample?.url,
      issues: validatePriceEvidence(sample, quantity),
    }))
    let record
    try {
      record = averagePriceEvidence(params.samples, quantity, {
        comparisonKey: params.comparisonKey,
        targetUnit: params.targetUnit,
        priceBasis: params.priceBasis,
      })
    } catch (error) {
      const failing = issuesByIndex.filter((item) => item.issues.length > 0)
      const detail = failing.length
        ? '\n' + failing.map((item) => `- 第 ${item.index + 1} 条 ${item.url ?? '（无 url）'}: ${item.issues.join('；')}`).join('\n')
        : ''
      throw fail(`无法生成均价：${error?.message ?? error}${detail}`)
    }
    const excluded = (record.excluded ?? []).map((item) => ({
      url: item?.sample?.url,
      selectedSpec: item?.sample?.selectedSpec,
      reasons: item?.reasons ?? [],
    }))
    const lines = [
      `规格：${record.comparisonKey}｜目标单位：${record.targetUnit}｜口径：${record.priceBasis}`,
      `有效样本 ${record.sampleCount} 条｜均价 ${money(record.mean)} 元/${record.targetUnit}｜区间 ${money(record.min)} – ${money(record.max)}`,
      record.sampleCount < 2 ? '注意：不足 2 条有效样本，只能按单样本处理，并在底稿注明「单样本」而不是均价。' : '',
      excluded.length
        ? `被排除 ${excluded.length} 条：\n` + excluded.map((item) => `- ${item.url ?? '（无 url）'}${item.selectedSpec ? ` ${item.selectedSpec}` : ''}: ${item.reasons.join('；')}`).join('\n')
        : '',
    ].filter(Boolean)
    return { ...record, excluded, summary: lines.join('\n') }
  },
}

const TOOLS = [calculateTool, quoteTool, loginTool, searchTool, offerTool, averageTool]

// ────────────────────────────────────────────────────────────── plugin

function registerSkill(ctx) {
  const skills = ctx.get('skills')
  if (skills == null || typeof skills.register !== 'function') {
    console.warn(`[${name}] skills service 不可用，hardware-quote 技能未注册（工具仍可用）`)
    return () => {}
  }
  return skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    content: readSkillMarkdown(),
    source: 'bundled',
    resourceBase: { kind: 'directory', path: skillDir },
  })
}

export function apply(ctx) {
  const disposers = []
  disposers.push(registerSkill(ctx))

  const tools = ctx.get('tools')
  if (tools == null || typeof tools.register !== 'function') {
    console.warn(`[${name}] tools service 不可用，hwq_* 工具未注册`)
  } else {
    for (const tool of TOOLS) disposers.push(tools.register(tool))
  }

  ctx.effect(() => () => {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        console.warn(`[${name}] dispose failed: ${error?.message ?? error}`)
      }
    }
    disposers.length = 0
  })
}

export { TOOLS }
export default { name, inject, apply }

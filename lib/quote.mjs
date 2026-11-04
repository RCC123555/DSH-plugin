/**
 * hardware-quote · 成员 B：Excel 报价导出
 *
 * buildQuote(input, options)
 *   1. 调 ./pricing.mjs 的 calculate(input) 做独立核算（成员 A 的实现，接口固定）；
 *   2. 按旧版逐行布局规则生成 plan JSON（行号由 layoutFor(配件条数) 决定）；
 *   3. 调 python/build_workbook.py 用 openpyxl 写出「报价BOM」+「报价底稿」两工作表；
 *   4. 读回 python 的静态校验报告，组装 checks 并核对金额/净利率容差，返回结果。
 *
 * 本机没有 LibreOffice/Excel 重算引擎：公式照写（引用底稿），底稿另有
 * 「脚本复算（只读校验）」区块保存 JS 侧静态值，据此比对；工作簿设置
 * calcPr fullCalcOnLoad=1，由 Excel 打开时自行重算。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {calculate, VERSION, PROCESSING_RATE_PER_KG} from './pricing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');
export const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'skill', 'assets', '对外报价BOM表.xlsx');
export const BUILDER_PATH = path.join(PLUGIN_ROOT, 'python', 'build_workbook.py');

/** 已知 DSH 运行时自带的 Python 位置（优先按 dsh-runtimes 目录自动发现）。 */
const DEFAULT_PYTHON =
  'C:\\Users\\Lenovo\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

/** 扫描 ~/.dsh/dsh-runtimes 下的 python.exe，避免把某一台机器的绝对路径写死当成唯一来源。 */
function discoverRuntimePython() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  const roots = [];
  const runtimesDir = path.join(home, '.dsh', 'dsh-runtimes');
  roots.push(runtimesDir);
  if (process.env.DSH_RUNTIME_DIR) roots.push(process.env.DSH_RUNTIME_DIR);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    // 稳定顺序：先 primary-runtime，再其余按名字排序
    entries.sort((a, b) => (a.includes('primary') ? -1 : 0) - (b.includes('primary') ? -1 : 0) || a.localeCompare(b));
    for (const entry of entries) {
      const candidate = path.join(root, entry, 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export const SHEET_FRONT = '报价BOM';
export const SHEET_BOTTOM = '报价底稿';

/**
 * BOM 行号规则（照搬旧版 quote.mjs）：
 * - 配件行固定从第 14 行开始，至少 2 行 → extra = max(2, count) - 2；
 * - 第 16 行及以后整体下移 extra 行（配件小计/加工费/包装/成本/…）；
 * - 原第 37 行的税金、38 行含税、39 行页脚再额外下移 1 行（插入「未税报价」行）。
 * 报价BOM 的行号与旧版一一对应，底稿引用这些行号。
 */
export function layoutFor(count = 0) {
  const extra = Math.max(2, count) - 2;
  const row = (n) => n + (n >= 16 ? extra : 0) + (n >= 37 ? 1 : 0);
  return {
    extra,
    count,
    accessoryStart: 14,
    accessoryEnd: 15 + extra,
    accessorySubtotal: row(16),
    processingStart: row(18),
    processingSubtotal: row(24),
    coating: row(23),
    packagingStart: row(25),
    packagingSubtotal: row(33),
    protection: row(29),
    carton: row(31),
    cost: row(34),
    management: row(35),
    profit: row(36),
    beforeTax: 37 + extra,
    tax: row(37),
    afterTax: row(38),
    footer: row(39),
  };
}

function stripFunctions(layout) {
  const clean = {};
  for (const [key, value] of Object.entries(layout)) {
    if (typeof value !== 'function') clean[key] = value;
  }
  return clean;
}

export function resolvePython(pythonPath) {
  const discovered = discoverRuntimePython();
  const candidates = [pythonPath, process.env.HWQ_PYTHON, process.env.DSH_PYTHON, discovered, DEFAULT_PYTHON]
    .filter((value) => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }
  if (pythonPath) return pythonPath; // 交给系统解析，失败时报错更明确
  return process.platform === 'win32' ? 'python' : 'python3';
}

function sanitizeLabel(value) {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || '未命名产品').slice(0, 80);
}

/** wx 独占创建 → 返回本次唯一可用的输出路径，旧版从 v01 递增。 */
function reserveOutput(outputDir, date, label, draft) {
  fs.mkdirSync(outputDir, {recursive: true});
  let lastError = null;
  for (let index = 1; index <= 999; index += 1) {
    const suffix = draft ? '_待核价' : '';
    const name = `${date}_${label}${suffix}_报价_v${String(index).padStart(2, '0')}.xlsx`;
    const target = path.join(outputDir, name);
    try {
      const handle = fs.openSync(target, 'wx');
      fs.closeSync(handle);
      return target;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      lastError = error;
    }
  }
  throw new Error(`输出目录里已有 999 个同名版本，请清理后重试：${outputDir}${lastError ? '' : ''}`);
}

function runPython(pythonPath, scriptPath, args, cwd) {
  const env = {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'};
  return new Promise((resolve) => {
    execFile(
      pythonPath,
      [scriptPath, ...args],
      {cwd, env, windowsHide: true, timeout: 300_000, maxBuffer: 32 * 1024 * 1024},
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({code, error, stdout, stderr, timedOut: Boolean(error && error.killed)});
      },
    );
  });
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function uniqueWorkDir(prefix = 'hardware-quote-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function issueLines(issues) {
  return issues
    .map((issue) => `- [${issue.severity ?? 'blocking'}] ${issue.message ?? issue.code ?? '未说明原因'}`)
    .join('\n');
}

function deleteQuietly(file) {
  try {
    fs.rmSync(file, {force: true});
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function assertFinite(value, message) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message);
  return value;
}

/**
 * 导出报价工作簿。
 * @param {object} input 产品输入（Lead 已追加 allowDraft）
 * @param {{outputDir?:string, workDir?:string, imagePath?:string, pythonPath?:string}} [options]
 * @returns {Promise<{output:string, planPath:string, sheets:Array<{name:string,lastRow:number,lastColumn:number}>,
 *   checks:object, metadata:object}>}
 */
export async function buildQuote(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('buildQuote(input, options)：input 必须是产品输入对象。');
  }
  const startedAt = Date.now();
  const calc = calculate(input);

  // ── 1. 导出前置拦截：重量/尺寸/包装类 blocking 一律拒绝；只有纯缺价允许草稿。
  if (calc.ready !== true) {
    const blocking = Array.isArray(calc.blockingIssues) ? calc.blockingIssues : [];
    const nonDraft = blocking.filter((issue) => issue.draftAllowed !== true);
    const draftAllowed =
      calc.draftOnly === true &&
      input.allowDraft === true &&
      blocking.length > 0 &&
      nonDraft.length === 0;
    if (!draftAllowed) {
      const why = nonDraft.length > 0 ? nonDraft : blocking;
      const hint =
        calc.draftOnly === true && input.allowDraft !== true
          ? '\n- 仅缺价阻塞；如需草稿请显式传 allowDraft=true（草稿金额单元格写 #N/A）。'
          : '';
      throw new Error(
        `报价未就绪，拒绝导出：\n${why.length ? issueLines(why) : '- 未返回具体阻塞原因'}${hint}`,
      );
    }
  }
  const draft = calc.ready !== true;
  const totals = draft ? null : calc.totals;
  if (!draft && (!totals || typeof totals !== 'object')) {
    throw new Error('报价未就绪，拒绝导出：calculate() 返回 ready=true 但没有 totals。');
  }

  // ── 2. 布局与静态复算值
  const accessories = Array.isArray(calc.accessories) ? calc.accessories : [];
  const layout = stripFunctions(layoutFor(accessories.length));
  const recalc = totals
    ? {
        cost: assertFinite(calc.directCost, 'calculate() 返回的每件成本不是有限数字。'),
        profit: assertFinite(totals.profit, 'calculate() 返回的利润不是有限数字。'),
        management: assertFinite(totals.management, 'calculate() 返回的管理费不是有限数字。'),
        untaxed: assertFinite(totals.beforeTax, 'calculate() 返回的未税报价不是有限数字。'),
        tax: assertFinite(totals.tax, 'calculate() 返回的税金不是有限数字。'),
        taxed: assertFinite(totals.afterTax, 'calculate() 返回的含税报价不是有限数字。'),
        netMargin: assertFinite(totals.netMargin, 'calculate() 返回的净利率不是有限数字。'),
      }
    : null;

  // ── 3. 输出路径与工作目录
  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.resolve(process.cwd(), 'output');
  const workDir = options.workDir ? path.resolve(options.workDir) : uniqueWorkDir();
  fs.mkdirSync(workDir, {recursive: true});
  const product = calc.product ?? {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(product.date ?? ''))
    ? String(product.date)
    : new Date().toISOString().slice(0, 10);
  const label = sanitizeLabel(product.sku || product.name);
  const imagePath =
    typeof options.imagePath === 'string' && options.imagePath
      ? path.resolve(options.imagePath)
      : undefined;
  if (imagePath && !fs.existsSync(imagePath)) {
    throw new Error(`图片文件不存在：${imagePath}`);
  }
  const output = reserveOutput(outputDir, date, label, draft);
  const planPath = path.join(workDir, 'plan.json');
  const reportPath = path.join(workDir, 'report.json');
  const expandedPath = path.join(workDir, 'expanded-template.xlsx');

  const plan = {
    meta: {
      generator: 'hardware-quote',
      pluginVersion: VERSION,
      processingRatePerKg: PROCESSING_RATE_PER_KG,
      createdAt: new Date().toISOString(),
      draft,
    },
    input,
    calc,
    layout,
    recalc,
    options: {
      output,
      workDir,
      expandedPath,
      templatePath: TEMPLATE_PATH,
      imagePath: imagePath ?? null,
      imageBox: {width: 220, height: 137},
    },
  };
  fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');

  // ── 4. 调 Python 写工作簿并读回校验
  const pythonPath = resolvePython(options.pythonPath);
  if (!fs.existsSync(BUILDER_PATH)) {
    deleteQuietly(output);
    throw new Error(`缺少 Python 构建脚本：${BUILDER_PATH}`);
  }
  const run = await runPython(
    pythonPath,
    BUILDER_PATH,
    ['--plan', planPath, '--out', output, '--report', reportPath],
    workDir,
  );
  const report = readJsonIfExists(reportPath);
  if (run.code !== 0) {
    deleteQuietly(output);
    const detail =
      report?.error ||
      (run.stderr || run.stdout || '').trim() ||
      (run.timedOut ? 'Python 构建超时（300s）。' : `Python 退出码 ${run.code}`);
    const validation =
      run.code === 2 && report
        ? [
            ...(report.formulaErrors ?? []),
            ...(report.structuralErrors ?? []),
            ...(report.naCells?.length && !draft ? ['就绪报价出现 #N/A：' + report.naCells.join('、')] : []),
          ]
        : [];
    throw new Error(
      `生成报价工作簿失败：${detail}${validation.length ? `\n${validation.join('\n')}` : ''}`,
    );
  }
  if (!report) {
    deleteQuietly(output);
    throw new Error(`Python 构建未产出校验报告：${reportPath}`);
  }
  if (report.ok !== true) {
    deleteQuietly(output);
    const detail = [...(report.formulaErrors ?? []), ...(report.structuralErrors ?? [])];
    throw new Error(`工作簿校验失败：\n${detail.join('\n') || '未知原因'}`);
  }

  const bottomLayout = report.bottomLayout ?? {};
  const sheets = [
    {
      name: SHEET_FRONT,
      lastRow: layout.footer,
      lastColumn: 9,
    },
    {
      name: SHEET_BOTTOM,
      lastRow: bottomLayout.lastRow ?? report.sheets?.[1]?.lastRow ?? null,
      lastColumn: 9,
    },
  ];

  // ── 5. checks：公式错误、行号映射、重量、合计、超链接、图片
  const formulaErrors = Array.isArray(report.formulaErrors) ? report.formulaErrors : [];
  if (formulaErrors.length > 0) {
    deleteQuietly(output);
    throw new Error(`读回工作簿发现公式错误：\n${formulaErrors.join('\n')}`);
  }
  if (!draft && Array.isArray(report.naCells) && report.naCells.length > 0) {
    deleteQuietly(output);
    throw new Error(`就绪报价出现 #N/A（仅缺价草稿允许）：${report.naCells.join('、')}`);
  }

  const evaluated = report.values ?? {};
  const afterTaxRef = `${SHEET_FRONT}!G${layout.afterTax}`;
  const marginRef = `${SHEET_FRONT}!L${layout.afterTax}`;
  if (totals) {
    const excelAfterTax = evaluated[afterTaxRef];
    if (typeof excelAfterTax !== 'number') {
      deleteQuietly(output);
      throw new Error(`读回校验失败：${afterTaxRef} 没有得到数值（实际 ${JSON.stringify(excelAfterTax ?? null)}）。`);
    }
    if (Math.abs(excelAfterTax - totals.afterTax) > 1e-6) {
      deleteQuietly(output);
      throw new Error(
        `Excel与独立核算结果不一致。含税报价：工作簿 ${excelAfterTax} vs 核算 ${totals.afterTax}`,
      );
    }
    const excelMargin = evaluated[marginRef];
    if (typeof excelMargin !== 'number') {
      deleteQuietly(output);
      throw new Error(`读回校验失败：${marginRef} 没有得到数值（实际 ${JSON.stringify(excelMargin ?? null)}）。`);
    }
    if (Math.abs(excelMargin - totals.netMargin) > 1e-9) {
      deleteQuietly(output);
      throw new Error(
        `Excel与独立核算结果不一致。实际净利率：工作簿 ${excelMargin} vs 核算 ${totals.netMargin}`,
      );
    }
  }

  const weights = calc.weights ?? {};
  const checks = {
    formulaErrors,
    naCells: Array.isArray(report.naCells) ? report.naCells : [],
    structuralErrors: Array.isArray(report.structuralErrors) ? report.structuralErrors : [],
    rowMap: {
      extra: layout.extra,
      accessoryStart: layout.accessoryStart,
      accessoryEnd: layout.accessoryEnd,
      accessorySubtotal: layout.accessorySubtotal,
      processingStart: layout.processingStart,
      processingSubtotal: layout.processingSubtotal,
      coating: layout.coating,
      packagingStart: layout.packagingStart,
      packagingSubtotal: layout.packagingSubtotal,
      protection: layout.protection,
      carton: layout.carton,
      cost: layout.cost,
      management: layout.management,
      profit: layout.profit,
      beforeTax: layout.beforeTax,
      tax: layout.tax,
      afterTax: layout.afterTax,
      footer: layout.footer,
      bottom: {
        lastRow: bottomLayout.lastRow ?? null,
        parametersStart: bottomLayout.parametersStart ?? null,
        parametersEnd: bottomLayout.parametersEnd ?? null,
        protectionStart: bottomLayout.protectionStart ?? null,
        protectionTotalRow: bottomLayout.protectionTotalRow ?? null,
        cartonAreaRow: bottomLayout.cartonAreaRow ?? null,
        cartonCostRow: bottomLayout.cartonCostRow ?? null,
        woodStart: bottomLayout.woodStart ?? null,
        weightStart: bottomLayout.weightStart ?? null,
        sourceStart: bottomLayout.sourceStart ?? null,
        recalcStart: bottomLayout.recalcStart ?? null,
        recalcEnd: bottomLayout.recalcEnd ?? null,
      },
    },
    weights: {
      net: weights.net ?? null,
      body: weights.body ?? null,
      metal: weights.metal ?? null,
      wood: weights.wood ?? null,
      accessories: weights.accessories ?? null,
      extras: weights.extras ?? null,
      gross: weights.gross ?? null,
      packaging: weights.packaging ?? null,
      netOrigin: weights.netOrigin ?? null,
      netWeightBasis: weights.netWeightBasis ?? null,
    },
    totals: {
      cost: calc.directCost ?? null,
      profit: totals?.profit ?? null,
      untaxed: totals?.beforeTax ?? null,
      taxed: totals?.afterTax ?? null,
      tax: totals?.tax ?? null,
      management: totals?.management ?? null,
      netMargin: totals?.netMargin ?? null,
    },
    links: Array.isArray(report.links) ? report.links : [],
    imageEmbedded: report.imageEmbedded === true,
    imageCount: report.imageCount ?? 0,
    evaluated,
  };

  const stat = (() => {
    try {
      return fs.statSync(output);
    } catch {
      return null;
    }
  })();
  const metadata = {
    generator: 'hardware-quote',
    version: VERSION,
    createdAt: plan.meta.createdAt,
    elapsedMs: Date.now() - startedAt,
    draft,
    ready: !draft,
    python: pythonPath,
    workDir,
    planPath,
    reportPath,
    expandedTemplate: expandedPath,
    templatePath: TEMPLATE_PATH,
    outputBytes: stat?.size ?? null,
    output,
    imagePath: imagePath ?? null,
    imageBox: plan.options.imageBox,
    accessories: accessories.length,
    protectionItems: Array.isArray(calc.protection) ? calc.protection.length : 0,
    formulaErrors: formulaErrors.length,
    evaluatedCells: Object.keys(evaluated).length,
    issueCount: Array.isArray(calc.issues) ? calc.issues.length : 0,
    blockingIssues: (calc.blockingIssues ?? []).map((issue) => ({
      code: issue.code ?? null,
      severity: issue.severity ?? null,
      draftAllowed: issue.draftAllowed === true,
      message: issue.message ?? null,
    })),
    recalc,
  };

  return {output, planPath, sheets, checks, metadata};
}

export default buildQuote;

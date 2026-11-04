/**
 * hardware-quote · 多产品合并导出（hwq_quote_batch）
 *
 * 一个订单里有多款产品时，逐款各自出一份两表工作簿无法交付：
 * 客户/工厂需要「一个 Excel、每款一张分表」。本模块：
 *   1. 逐款调 buildQuote() 生成单款两表工作簿（落在临时目录，不外发）；
 *   2. 按「00_汇总 + 00_口径说明 + NN_产品简称」结构调 python/merge_quotes.py
 *      合并成一个工作簿（每款分表上半报价BOM、下半报价底稿，公式改本表引用）；
 *   3. 调 python/verify_merge.py 做静态校验（值、公式、合并区域、超链接、图片）；
 *   4. 只有全部产品都就绪（或全部仅缺价草稿）才落盘到 outputDir。
 *
 * 汇总表默认列与历史交付一致（序号…备注/风险），数据全部取自各款 calculate()。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildQuote, PLUGIN_ROOT, resolvePython} from './quote.mjs';
import {VERSION} from './pricing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MERGER_PATH = path.join(PLUGIN_ROOT, 'python', 'merge_quotes.py');
export const VERIFIER_PATH = path.join(PLUGIN_ROOT, 'python', 'verify_merge.py');

export const SUMMARY_HEADERS = Object.freeze([
  '序号', 'SKU', '产品名称', '产品尺寸cm', '外箱尺寸cm', '净重kg', '毛重kg',
  '铁主料kg', '木主料kg', '主料成本', '配件成本', '加工费', '喷涂费',
  '保护包材', '纸箱', '固定包装', '每件成本C', '利润P', '管理费M',
  '未税U', '税金T(10%)', '含税报价Q', '备注/风险',
]);

export const SUMMARY_WIDTHS = Object.freeze([
  5, 13, 30, 14, 14, 8, 8, 10, 10, 10, 10, 10, 10, 10, 9, 10, 11, 10, 10, 10, 11, 12, 40,
]);

const SUMMARY_NOTES = Object.freeze([
  '1. 单价口径：铁、木主料均 5 元/kg；加工（开料+弯形+焊接+打磨）=本体金属kg×3元/kg；喷涂=本体金属kg×2.5元/kg。',
  '2. 纸箱=(长+2×高+2)×(2×宽+3×高+2)/10000×4.2元/㎡÷每箱件数；EPS 15kg/m³、1.5cm厚、425元/m³，上下各一整片（外箱长宽各−3cm）。',
  '3. 固定包装 12.1 元/件（条码1.5＋说明书2.5＋护角8×0.2＋装柜人工1.5＋包装人工5）。',
  '4. 报价链：C=主料+配件+加工+喷涂+保护包材+纸箱+固定包装；Q=C/(1−r×(1+0.9)×(1+0.1))，r=8.5%；P=Q−C−M−T，M=P×0.9，T=U×10%。',
  '5. 配件价来自 1688 详情页可见普通批发价，同规格 2 条样本取算术平均；单样本已在各产品底稿注明；M6×15 螺丝/螺母、EPS 走原表模板价。',
  '6. 净重、毛重、产品尺寸、外箱尺寸取自原报价需求表；铁/木主料分重按图片识别与配件估重拆分，详见各产品分表「报价底稿」。',
  '7. 每款产品的完整 BOM、单价来源与档位、脚本复算校验见同一工作簿该产品分表，以及底稿「脚本复算（只读校验）」区块。',
  '8. 汇总金额为各产品独立报价的引用汇总，量价随采购批量变化需重新核对档位。',
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function round4(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null;
}

function dimsText(dims) {
  if (!dims || typeof dims !== 'object') return '';
  const {length, width, height} = dims;
  if ([length, width, height].some((item) => typeof item !== 'number')) return '';
  return `${length}×${width}×${height}`;
}

function sanitizeLabel(value) {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || '未命名产品').slice(0, 80);
}

function sheetTitle(index, label) {
  const prefix = String(index).padStart(2, '0');
  const room = 31 - prefix.length - 1;
  return `${prefix}_${sanitizeLabel(label).replace(/[\[\]:*?/\\]/g, '_').slice(0, room)}`;
}

function reserveOutput(outputDir, date, label, draft) {
  fs.mkdirSync(outputDir, {recursive: true});
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
    }
  }
  throw new Error(`输出目录里已有 999 个同名版本，请清理后重试：${outputDir}`);
}

function runPython(pythonPath, scriptPath, args, cwd) {
  const env = {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'};
  return new Promise((resolve) => {
    execFile(
      pythonPath,
      [scriptPath, ...args],
      {cwd, env, windowsHide: true, timeout: 600_000, maxBuffer: 32 * 1024 * 1024},
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({code, stdout, stderr, timedOut: Boolean(error && error.killed)});
      },
    );
  });
}

/** 把各款 calculate() 结果整理成汇总表行（含合计行）。 */
export function summaryRows(products) {
  const rows = [];
  const totals = new Array(SUMMARY_HEADERS.length).fill(null);
  products.forEach((product, index) => {
    const calc = product.calc ?? {};
    const costs = calc.costs ?? {};
    const weights = calc.weights ?? {};
    const totalsCalc = calc.totals ?? {};
    const item = product.item ?? {};
    const row = [
      index + 1,
      calc.product?.sku ?? '',
      calc.product?.name ?? '',
      dimsText(calc.product?.dimensions),
      dimsText(calc.product?.cartonDimensions),
      round4(weights.net),
      round4(weights.gross),
      round4(weights.metal),
      round4(weights.wood),
      round4(costs.main),
      round4(costs.accessories),
      round4(costs.processing),
      round4(costs.coating),
      round4(costs.protection),
      round4(costs.carton),
      round4(costs.fixedPackaging),
      round4(calc.directCost),
      round4(totalsCalc.profit),
      round4(totalsCalc.management),
      round4(totalsCalc.beforeTax),
      round4(totalsCalc.tax),
      round4(totalsCalc.afterTax),
      typeof item.note === 'string' ? item.note : '',
    ];
    row.forEach((value, column) => {
      if (typeof value === 'number' && column >= 9) {
        totals[column] = (totals[column] ?? 0) + value;
      }
    });
    rows.push(row);
  });
  const sumRow = new Array(SUMMARY_HEADERS.length).fill(null);
  sumRow[2] = `合计（${products.length}款，按500件/单）`;
  for (let column = 9; column <= 21; column += 1) {
    sumRow[column] = totals[column] === null ? null : round4(totals[column]);
  }
  rows.push(sumRow);
  return rows;
}

export function buildSummary(products, options = {}) {
  const first = products[0]?.calc ?? {};
  const quantity = first.order?.quantity ?? 500;
  const perCarton = first.order?.unitsPerCarton ?? 1;
  const netMargin = (first.rates?.netMargin ?? 0.085) * 100;
  const label = options.label || `${products.length}款合集`;
  const title = `${label} 报价汇总（${options.date ?? first.product?.date ?? ''}｜规则 v${VERSION}｜${quantity}件/单、${perCarton}件/箱、含税净利率${netMargin}%）`;
  return {
    title,
    headers: [...SUMMARY_HEADERS],
    rows: summaryRows(products),
    notes: [...SUMMARY_NOTES],
    widths: [...SUMMARY_WIDTHS],
  };
}

/**
 * 多产品合并导出。
 * @param {Array<{input?:object, inputPath?:string, name?:string, imagePath?:string, allowDraft?:boolean, note?:string}>} items
 * @param {{outputDir?:string, workDir?:string, label?:string, pythonPath?:string}} [options]
 */
export async function buildBatch(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError('buildBatch(items, options)：至少需要 1 个产品。');
  }
  const startedAt = Date.now();
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : path.resolve(process.cwd(), 'output');
  const workDir = options.workDir
    ? path.resolve(options.workDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-quote-batch-'));
  const singlesDir = path.join(workDir, 'singles');
  fs.mkdirSync(singlesDir, {recursive: true});
  const pythonPath = resolvePython(options.pythonPath);

  const products = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] ?? {};
    let input = item.input;
    if (!input && typeof item.inputPath === 'string') {
      const file = path.resolve(item.inputPath);
      input = JSON.parse(fs.readFileSync(file, 'utf8'));
      item.inputPath = file;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError(`第 ${index + 1} 个产品缺少 input / inputPath。`);
    }
    const withDraft = item.allowDraft === true ? {...input, allowDraft: true} : input;
    const quote = await buildQuote(withDraft, {
      outputDir: singlesDir,
      workDir: path.join(workDir, `p${String(index + 1).padStart(2, '0')}`),
      imagePath:
        typeof item.imagePath === 'string' && item.imagePath
          ? path.resolve(item.imagePath)
          : typeof input?.product?.imagePath === 'string'
            ? path.resolve(path.dirname(item.inputPath ?? process.cwd()), input.product.imagePath)
            : undefined,
      pythonPath,
    });
    const plan = readJson(quote.planPath) ?? {};
    const calc = plan.calc ?? {};
    products.push({
      index: index + 1,
      item,
      quote,
      calc,
      name: sheetTitle(index + 1, item.name || calc.product?.name || calc.product?.sku || `产品${index + 1}`),
    });
  }

  const draft = products.some((product) => product.quote?.metadata?.draft === true);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(products[0]?.calc?.product?.date ?? ''))
    ? String(products[0].calc.product.date)
    : new Date().toISOString().slice(0, 10);
  const label = sanitizeLabel(options.label || `${products.length}款`);
  const summary = buildSummary(products, {label, date});
  const summaryPath = path.join(workDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary), 'utf8');

  const mergedTemp = path.join(workDir, 'merged.xlsx');
  if (!fs.existsSync(MERGER_PATH)) throw new Error(`缺少合并脚本：${MERGER_PATH}`);
  const mergeArgs = [];
  for (const product of products) {
    mergeArgs.push('--source', product.quote.output, '--name', product.name);
  }
  mergeArgs.push('--summary', summaryPath, '--out', mergedTemp);
  const mergeRun = await runPython(pythonPath, MERGER_PATH, mergeArgs, workDir);
  const mergeOut = (() => {
    try {
      return JSON.parse(mergeRun.stdout.trim().split('\n').pop() ?? '');
    } catch {
      return null;
    }
  })();
  if (mergeRun.code !== 0 || !mergeOut?.ok) {
    const detail = (mergeRun.stderr || mergeRun.stdout || '').trim() || `退出码 ${mergeRun.code}`;
    throw new Error(`合并多产品工作簿失败：${detail}`);
  }

  // 静态校验：值 / 公式 / 合并区域 / 超链接 / 图片
  const pairsPath = path.join(workDir, 'pairs.json');
  fs.writeFileSync(
    pairsPath,
    JSON.stringify(
      mergeOut.sheets.map((sheet, index) => [
        sheet.title,
        products[index].quote.output,
        sheet.frontRows,
        sheet.bottomRows,
        sheet.bottomStart,
      ]),
    ),
    'utf8',
  );
  const verifyRun = await runPython(pythonPath, VERIFIER_PATH, [mergedTemp, pairsPath], workDir);
  let verification = null;
  try {
    verification = JSON.parse(verifyRun.stdout.trim().split('\n').pop() ?? '');
  } catch {
    verification = null;
  }
  if (verifyRun.code !== 0 || !verification?.ok) {
    const detail =
      (verifyRun.stderr || verifyRun.stdout || '').trim() ||
      JSON.stringify(verification?.sheets ?? {}, null, 2) ||
      `退出码 ${verifyRun.code}`;
    throw new Error(`合并结果校验未通过：${detail}`);
  }

  const output = reserveOutput(outputDir, date, label, draft);
  try {
    fs.copyFileSync(mergedTemp, output);
  } catch (error) {
    fs.rmSync(output, {force: true});
    throw error;
  }

  const stat = (() => {
    try {
      return fs.statSync(output);
    } catch {
      return null;
    }
  })();
  const checks = {
    products: products.map((product) => ({
      index: product.index,
      sheet: product.name,
      sku: product.calc?.product?.sku ?? null,
      name: product.calc?.product?.name ?? null,
      single: product.quote.output,
      draft: product.quote?.metadata?.draft === true,
      totals: product.quote?.checks?.totals ?? null,
      weights: product.quote?.checks?.weights ?? null,
      formulaErrors: product.quote?.checks?.formulaErrors ?? [],
      links: product.quote?.checks?.links?.length ?? 0,
      imageEmbedded: product.quote?.checks?.imageEmbedded === true,
    })),
    merged: mergeOut.sheets,
    verification: {
      ok: verification.ok === true,
      sheets: verification.sheets,
    },
    summary: {rows: summary.rows.length - 1, headers: summary.headers.length, title: summary.title},
  };
  const metadata = {
    generator: 'hardware-quote',
    version: VERSION,
    createdAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    draft,
    ready: !draft,
    python: pythonPath,
    workDir,
    summaryPath,
    output,
    outputBytes: stat?.size ?? null,
    products: products.length,
  };
  return {output, workDir, summaryPath, sheets: mergeOut.sheets, checks, metadata};
}

export default buildBatch;

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildQuote, layoutFor, PLUGIN_ROOT } from '../lib/quote.mjs';
import { calculate } from '../lib/pricing.mjs';
import { averagePriceEvidence } from '../lib/lookup.mjs';

const PYTHON =
  process.env.HWQ_PYTHON ||
  'C:\\Users\\Lenovo\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

const ROOT = resolve(PLUGIN_ROOT);
const SAMPLE = join(ROOT, 'examples', 'sample-input.json');

const sampleInput = () => JSON.parse(readFileSync(SAMPLE, 'utf8'));

function workspace(name) {
  const dir = mkdtempSync(join(tmpdir(), `hwq-${name}-`));
  const workDir = join(dir, 'work');
  const outputDir = join(dir, 'out');
  return { dir, workDir, outputDir };
}

function cleanup(ctx) {
  try {
    rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响断言结果。
  }
}

function runPython(code, args = []) {
  const result = spawnSync(PYTHON, ['-c', code, ...args], {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`python 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

// 读回成品：结构、打印设置、超链接、图片、指定单元格的值/公式/格式。
const DUMP_SCRIPT = `
import json, sys
from openpyxl import load_workbook

path = sys.argv[1]
addresses = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
wb = load_workbook(path)
def plain(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)
info = {
    'calcFullCalcOnLoad': bool(wb.calculation and wb.calculation.fullCalcOnLoad),
    'sheetNames': wb.sheetnames,
    'sheets': {},
}
for ws in wb.worksheets:
    ps = ws.page_setup
    pr = ws.sheet_properties.pageSetUpPr
    cells = {}
    if addresses == '*':
        for row in ws.iter_rows(min_col=1, max_col=9):
            for cell in row:
                if cell.value is not None:
                    cells[cell.coordinate] = {'value': plain(cell.value), 'type': cell.data_type,
                                              'format': cell.number_format}
    for addr in (addresses if isinstance(addresses, list) else []):
        cell = ws[addr]
        cells[addr] = {'value': plain(cell.value), 'type': cell.data_type, 'format': cell.number_format}
    links = []
    for row in ws.iter_rows(min_col=1, max_col=9):
        for cell in row:
            if cell.hyperlink is not None:
                links.append({'ref': cell.coordinate, 'target': cell.hyperlink.target,
                              'location': cell.hyperlink.location, 'display': cell.hyperlink.display})
    images = []
    for img in getattr(ws, '_images', []) or []:
        ext = getattr(getattr(img, 'anchor', None), 'ext', None)
        images.append({'cx': getattr(ext, 'cx', None), 'cy': getattr(ext, 'cy', None)})
    info['sheets'][ws.title] = {
        'maxRow': ws.max_row,
        'maxColumn': ws.max_column,
        'merges': sorted(str(r) for r in ws.merged_cells.ranges),
        'printArea': ws.print_area,
        'paperSize': str(ps.paperSize),
        'orientation': ps.orientation,
        'fitToWidth': str(ps.fitToWidth),
        'fitToHeight': str(ps.fitToHeight),
        'fitToPage': bool(pr.fitToPage) if pr is not None else False,
        'freezePanes': ws.freeze_panes,
        'images': images,
        'links': links,
        'cells': cells,
    }
print(json.dumps(info, ensure_ascii=True))
`;

function dumpWorkbook(file, addresses = []) {
  return JSON.parse(runPython(DUMP_SCRIPT, [file, JSON.stringify(addresses)]));
}

function formula(cell) {
  return `${cell.type}:${cell.value}`;
}

test('layoutFor 复现模板的行号规则', () => {
  const two = layoutFor(2);
  assert.equal(two.extra, 0);
  assert.equal(two.accessoryStart, 14);
  assert.equal(two.accessoryEnd, 15);
  assert.equal(two.accessorySubtotal, 16);
  assert.equal(two.protection, 29);
  assert.equal(two.carton, 31);
  assert.equal(two.cost, 34);
  assert.equal(two.management, 35);
  assert.equal(two.profit, 36);
  assert.equal(two.beforeTax, 37);
  assert.equal(two.tax, 38);
  assert.equal(two.afterTax, 39);
  assert.equal(two.footer, 40);

  const three = layoutFor(3);
  assert.equal(three.extra, 1);
  assert.equal(three.accessoryEnd, 16);
  assert.equal(three.accessorySubtotal, 17);
  assert.equal(three.processingStart, 19);
  assert.equal(three.processingSubtotal, 25);
  assert.equal(three.coating, 24);
  assert.equal(three.packagingStart, 26);
  assert.equal(three.packagingSubtotal, 34);
  assert.equal(three.protection, 30);
  assert.equal(three.carton, 32);
  assert.equal(three.cost, 35);
  assert.equal(three.management, 36);
  assert.equal(three.profit, 37);
  assert.equal(three.beforeTax, 38);
  assert.equal(three.tax, 39);
  assert.equal(three.afterTax, 40);
  assert.equal(three.footer, 41);

  const five = layoutFor(5);
  assert.equal(five.extra, 3);
  assert.equal(five.accessoryEnd, 18);
  assert.equal(five.beforeTax, 40);
  assert.equal(five.footer, 43);
});

test('ready 样例：端到端生成，两表结构/公式/打印/超链接/复算区块齐备', async () => {
  const ctx = workspace('ready');
  const input = sampleInput();
  input.allowDraft = true;
  input.accessories[0] = {
    ...input.accessories[0],
    url: 'https://detail.1688.com/offer/1234567890.html',
    sourceType: 'user',
    sourceLabel: '用户提供',
    unitPrice: 0.1,
  };
  const expected = calculate(input);
  assert.equal(expected.ready, true);

  try {
    const res = await buildQuote(input, { outputDir: ctx.outputDir, workDir: ctx.workDir });
    const layout = layoutFor(input.accessories.length);

    assert.equal(existsSync(res.output), true, '成品文件未生成');
    assert.match(res.output, /2026-11-04_DEMO-ONLY_报价_v\d{2}\.xlsx$/);
    assert.equal(res.metadata.ready, true);
    assert.equal(res.metadata.draft, false);
    assert.equal(res.planPath && existsSync(res.planPath), true, 'plan.json 未生成');

    assert.deepEqual(
      res.sheets.map(s => ({ name: s.name, lastRow: s.lastRow, lastColumn: s.lastColumn })),
      [
        { name: '报价BOM', lastRow: layout.footer, lastColumn: 9 },
        { name: '报价底稿', lastRow: res.sheets[1].lastRow, lastColumn: 9 },
      ],
    );
    assert.ok(res.sheets[1].lastRow > 70, '底稿行数异常');

    assert.deepEqual(res.checks.formulaErrors, [], `公式错误：${res.checks.formulaErrors}`);
    assert.deepEqual(res.checks.structuralErrors, []);
    assert.equal(res.checks.rowMap.extra, 0);
    assert.equal(res.checks.imageEmbedded, false);
    assert.equal(res.checks.weights.net, expected.weights.net);
    assert.ok(Math.abs(res.checks.totals.taxed - expected.totals.afterTax) < 1e-9);
    assert.ok(Math.abs(res.checks.totals.untaxed - expected.totals.beforeTax) < 1e-9);
    assert.ok(Math.abs(res.checks.totals.cost - expected.directCost) < 1e-9);

    const addresses = [
      'A1', 'B4', 'B6', 'F2', 'E8', 'E9', 'G8', 'G9', 'H12',
      'H14', 'B15', `H${layout.accessorySubtotal}`,
      `D${layout.beforeTax}`, `G${layout.beforeTax}`,
      `G${layout.tax}`, `G${layout.afterTax}`, `L${layout.afterTax}`,
      `B${layout.footer}`, `E${layout.footer}`,
      'A4', 'A5', 'B5', 'A25', 'H9', 'H10', 'H11',
    ];
    assert.ok(res.checks.links.length >= 4, '底稿内部/外部超链接数量不足');
    const externalLinks = res.checks.links.filter(l => l.target);
    assert.ok(
      externalLinks.some(l => l.target === 'https://detail.1688.com/offer/1234567890.html'),
      '1688 证据链接未以原生超链接写入',
    );
    assert.ok(
      res.checks.links.some(l => l.location && /报价底稿'?\!A/.test(l.location)),
      '缺少底稿内部跳转链接',
    );

    const dump = dumpWorkbook(res.output, addresses);
    assert.equal(dump.calcFullCalcOnLoad, true, '缺少 calcPr fullCalcOnLoad=1');
    assert.deepEqual(dump.sheetNames, ['报价BOM', '报价底稿']);

    const front = dump.sheets['报价BOM'];
    const bottom = dump.sheets['报价底稿'];

    assert.equal(formula(front.cells.B6), `f:='报价底稿'!B17`);
    assert.equal(formula(front.cells.E8), `f:='报价底稿'!B19`);
    assert.equal(formula(front.cells.E9), `f:='报价底稿'!B18`);
    assert.equal(formula(front.cells.G8), `f:='报价底稿'!B5`);
    assert.equal(formula(front.cells.H14), 'f:=IF(ISNUMBER(G14),D14*G14,NA())');
    assert.equal(
      front.cells[`H${layout.accessorySubtotal}`].value,
      `=SUM(H14:H${layout.accessoryEnd})`,
    );
    assert.equal(front.cells[`D${layout.beforeTax}`].value, '未税报价');
    assert.equal(
      front.cells[`G${layout.beforeTax}`].value,
      `=SUM(G${layout.cost}:G${layout.profit})`,
    );
    assert.match(front.cells[`G${layout.tax}`].value, /^=G\d+\*'报价底稿'!B9$/);
    assert.ok(String(front.cells[`G${layout.afterTax}`].value).startsWith('='));
    assert.equal(
      front.cells[`L${layout.afterTax}`].value,
      `=G${layout.profit}/G${layout.afterTax}`,
    );
    assert.equal(front.cells[`L${layout.afterTax}`].format, '0.0%');
    assert.match(String(front.cells['F2'].value), /2026-11-04/);
    assert.equal(front.cells['F2'].format, 'yyyy-mm-dd');
    assert.equal(front.cells.B4.value, expected.product.name);

    // 模板样式与合并区域：配件区、加工区、图片区都按模板扩展规则映射。
    assert.ok(front.merges.includes('A13:A15'));
    assert.ok(front.merges.includes(`A17:A${23 + layout.extra}`));
    assert.ok(front.merges.includes(`A25:A${32 + layout.extra}`));
    assert.ok(front.merges.includes(`A34:A${38 + layout.extra + 1}`), `图片区合并：${front.merges}`);
    assert.ok(front.merges.includes(`D${layout.beforeTax}:F${layout.beforeTax}`));
    assert.ok(front.merges.includes(`G${layout.beforeTax}:I${layout.beforeTax}`));

    // 打印：BOM A4 纵向一页；底稿 A3 横向按列宽。
    assert.equal(front.paperSize, '9');
    assert.equal(front.orientation, 'portrait');
    assert.equal(front.fitToWidth, '1');
    assert.equal(front.fitToHeight, '1');
    assert.equal(front.fitToPage, true);
    assert.ok(front.printArea, 'BOM 缺少打印区域');
    assert.equal(bottom.paperSize, '8');
    assert.equal(bottom.orientation, 'landscape');
    assert.equal(bottom.fitToWidth, '1');
    assert.equal(bottom.fitToHeight, '0');
    assert.equal(bottom.fitToPage, true);
    assert.equal(bottom.freezePanes, 'A5');

    // 底稿：公共参数、证据链接、均价/来源与「脚本复算」区块。
    assert.equal(bottom.cells.A5.value, '铁单价');
    assert.equal(bottom.cells.B5.value, expected.rates.metal);
    assert.equal(formula(bottom.cells.H9), `f:='报价BOM'!G${layout.beforeTax}`);
    assert.equal(formula(bottom.cells.H10), `f:='报价BOM'!G${layout.afterTax}`);
    assert.equal(formula(bottom.cells.H11), `f:='报价BOM'!L${layout.afterTax}`);
    assert.ok(
      bottom.links.some(l => l.target === 'https://detail.1688.com/offer/1234567890.html'),
      '底稿未写入原生 1688 超链接',
    );
    assert.ok(
      front.links.some(link => link.location && link.location.includes(`'报价底稿'`)),
      'BOM 缺少跳转底稿的内部链接',
    );
    assert.ok(
      bottom.links.length >= 1,
      '底稿缺少证据超链接',
    );
    const recalcStart = res.checks.rowMap.bottom.recalcStart;
    assert.ok(recalcStart > 0);
    const recalcDump = dumpWorkbook(res.output, [`A${recalcStart}`, `A${recalcStart + 1}`]);
    assert.match(recalcDump.sheets['报价底稿'].cells[`A${recalcStart}`].value, /脚本复算/);
    assert.equal(res.checks.metadata === undefined, true);
  } finally {
    cleanup(ctx);
  }
});

test('三条配件：自动扩行并保持公式与合并区域正确', async () => {
  const ctx = workspace('three');
  const input = sampleInput();
  input.allowDraft = true;
  input.accessories.push({
    name: '垫片',
    spec: 'M6 平垫',
    quantity: 4,
    unit: 'PCS',
    unitPrice: 0.05,
    sourceType: 'user',
    sourceLabel: '用户提供',
    weightKgPerUnit: 0.003,
    weightSourceType: 'estimate',
    weightBasis: '按同规格垫片估算',
  });
  const layout = layoutFor(3);
  assert.equal(layout.extra, 1);

  try {
    const res = await buildQuote(input, { outputDir: ctx.outputDir, workDir: ctx.workDir });
    assert.equal(res.metadata.ready, true);
    assert.equal(res.checks.rowMap.extra, 1);
    assert.equal(res.checks.rowMap.accessoryEnd, 16);
    assert.equal(res.checks.rowMap.beforeTax, 38);
    assert.equal(res.checks.rowMap.footer, 41);
    assert.deepEqual(res.checks.formulaErrors, []);
    assert.equal(res.sheets[0].lastRow, 41);
    assert.equal(res.sheets[0].maxRow === undefined, true);

    const addresses = [
      'B14', 'B15', 'B16', 'H16', `H${layout.accessorySubtotal}`,
      `D${layout.beforeTax}`, `G${layout.beforeTax}`, `G${layout.tax}`, `G${layout.afterTax}`,
      `B${layout.footer}`,
    ];
    const dump = dumpWorkbook(res.output, addresses);
    const front = dump.sheets['报价BOM'];
    assert.equal(front.cells.B16.value, '垫片');
    assert.equal(front.cells.H16.value, '=IF(ISNUMBER(G16),D16*G16,NA())');
    assert.equal(front.cells[`H${layout.accessorySubtotal}`].value, '=SUM(H14:H16)');
    assert.equal(front.cells[`D${layout.beforeTax}`].value, '未税报价');
    assert.equal(front.cells[`G${layout.beforeTax}`].value, '=SUM(G35:G37)');
    assert.ok(front.merges.includes('A18:A24'), `加工区合并：${front.merges}`);
    assert.ok(front.merges.includes('A26:A33'));
    assert.ok(front.merges.includes('A35:A40'));
    assert.ok(!front.merges.includes('A34:A39'), '图片区未随增行扩展');
    assert.ok(front.merges.includes('D38:F38'));
    assert.ok(front.merges.includes('G38:I38'));
    assert.ok(!front.merges.includes('A34:A39'), '图片区未随增行扩展');
  } finally {
    cleanup(ctx);
  }
});

test('缺价草稿：数值单元格写 #N/A，可导出且不误报公式错误', async () => {
  const ctx = workspace('draft');
  const input = sampleInput();
  input.allowDraft = true;
  for (const item of input.accessories) {
    delete item.unitPrice;
    delete item.templateKey;
  }
  delete input.packaging.protection[0].unitPrice;
  delete input.packaging.protection[0].templateKey;

  const expected = calculate(input);
  assert.equal(expected.ready, false);
  assert.equal(expected.draftOnly, true);
  assert.equal(expected.blockingIssues.every(issue => issue.draftAllowed === true), true);
  const layout = layoutFor(input.accessories.length);

  try {
    const res = await buildQuote(input, { outputDir: ctx.outputDir, workDir: ctx.workDir });
    assert.equal(existsSync(res.output), true);
    assert.match(res.output, /_待核价_报价_v\d{2}\.xlsx$/);
    assert.equal(res.metadata.draft, true);
    assert.equal(res.metadata.ready, false);
    assert.equal(res.checks.totals.taxed, null);
    assert.equal(Object.values(res.checks.totals).every(value => value === null), true);
    assert.ok(res.checks.naCells.length > 0, '草稿单没有记录 #N/A 单元格');
    assert.deepEqual(res.checks.formulaErrors, []);
    assert.ok(res.checks.naCells.some(ref => ref === `报价BOM!G${layout.profit}`));
    assert.ok(res.checks.rowMap.beforeTax > 0);

    const dump = dumpWorkbook(res.output, [
      `G${layout.management}`,
      `G${layout.profit}`,
      `G${layout.afterTax}`,
      `D${layout.beforeTax}`,
      `G${layout.beforeTax}`,
      'A1',
    ]);
    const front = dump.sheets['报价BOM'];
    assert.equal(front.cells[`G${layout.management}`].value, '=NA()');
    assert.equal(front.cells[`G${layout.profit}`].value, '=NA()');
    assert.match(String(front.cells[`G${layout.afterTax}`].value), /NA\(\)/);
    assert.equal(front.cells.A1.value, '成本核算报价单（待核价）');
    assert.equal(front.cells[`D${layout.beforeTax}`].value, '未税报价');
    assert.equal(res.checks.imageEmbedded, false);
  } finally {
    cleanup(ctx);
  }
});

test('重量类 blocking：即使允许草稿也必须拒绝导出', async () => {
  const ctx = workspace('blocking');
  const input = sampleInput();
  input.allowDraft = true;
  delete input.product.netWeightKg;
  delete input.product.netWeightBasis;
  for (const item of input.accessories) {
    delete item.weightKgPerUnit;
    delete item.weightSourceType;
  }

  const expected = calculate(input);
  assert.equal(expected.ready, false);
  assert.equal(expected.draftOnly, false);
  assert.ok(expected.blockingIssues.some(issue => issue.draftAllowed === false));

  try {
    await assert.rejects(
      () => buildQuote(input, { outputDir: ctx.outputDir, workDir: ctx.workDir }),
      error => {
        assert.match(String(error.message), /未就绪/);
        return true;
      },
    );
    const emitted = [];
    // 失败时不得留下半成品。
    try {
      const { readdirSync } = await import('node:fs');
      for (const name of readdirSync(ctx.outputDir)) emitted.push(name);
    } catch {
      // 输出目录可能尚未创建。
    }
    assert.deepEqual(emitted, []);
  } finally {
    cleanup(ctx);
  }
});

test('1688 均价证据：逐家样本与原生超链接写入底稿', async () => {
  const ctx = workspace('mean');
  const input = sampleInput();
  input.allowDraft = true;

  const samples = [
    {
      url: 'https://detail.1688.com/offer/6100001.html',
      supplier: '东莞市A五金',
      title: '内六角法兰面螺丝 M6*15',
      selectedSpec: 'M6*15 304不锈钢',
      quoteUnit: '个',
      targetUnit: '个',
      targetUnitsPerQuoteUnit: 1,
      observedText: '1000件起批 0.10元/件',
      queriedAt: '2026-11-04',
      evidenceKind: 'visible_dom',
      searchMethod: 'keyword',
      keywords: '内六角法兰面螺丝 M6*15',
      specMatched: true,
      currency: 'CNY',
      priceKind: 'regular',
      originalPrice: 0.1,
      comparisonKey: 'M6*15 304不锈钢',
      priceBasis: '含税单价',
    },
    {
      url: 'https://detail.1688.com/offer/6100002.html',
      supplier: '深圳市B紧固件',
      title: '法兰面螺丝 M6*15',
      selectedSpec: 'M6*15 304不锈钢',
      quoteUnit: '个',
      targetUnit: '个',
      targetUnitsPerQuoteUnit: 1,
      observedText: '0.12元/件 500件起批',
      queriedAt: '2026-11-04',
      evidenceKind: 'visible_dom',
      searchMethod: 'keyword',
      keywords: '法兰面螺丝 M6*15',
      specMatched: true,
      currency: 'CNY',
      priceKind: 'regular',
      originalPrice: 0.12,
      comparisonKey: 'M6*15 304不锈钢',
      priceBasis: '含税单价',
    },
  ];
  const demand = 500 * input.accessories[0].quantity;
  const aggregate = averagePriceEvidence(samples, demand, {
    comparisonKey: 'M6*15 304不锈钢',
    targetUnit: '个',
    priceBasis: '含税单价',
  });
  input.accessories[0] = {
    ...input.accessories[0],
    unitPrice: aggregate.mean,
    sourceType: 'web',
    provider: '1688 2条同规格算术均价',
    sourceLabel: '1688 2条同规格算术均价',
    url: samples[0].url,
    queriedAt: '2026-11-04',
    quoteUnit: '元/个',
    priceEvidence: aggregate,
  };
  const expected = calculate(input);
  assert.equal(expected.ready, true, JSON.stringify(expected.blockingIssues));

  try {
    const res = await buildQuote(input, { outputDir: ctx.outputDir, workDir: ctx.workDir });
    assert.deepEqual(res.checks.formulaErrors, []);
    for (const sample of samples) {
      assert.ok(
        res.checks.links.some(link => link.target === sample.url),
        `样本链接未成为原生超链接：${sample.url}`,
      );
    }

    const dump = dumpWorkbook(res.output, '*');
    const bottomText = Object.values(dump.sheets['报价底稿'].cells)
      .map(cell => String(cell.value))
      .join('\n');
    assert.match(bottomText, /均价/);
    assert.match(bottomText, /算术平均/);
    assert.match(bottomText, /东莞市A五金/);
    assert.match(bottomText, /深圳市B紧固件/);
    assert.ok(
      bottomText.includes('0.11') || bottomText.includes(samples[0].url),
      '均价区块缺少样本明细',
    );

    const sampleLinks = dump.sheets['报价底稿'].links.filter(link => link.target);
    assert.ok(sampleLinks.length >= 2, '底稿样本行缺少链接');
    assert.ok(sampleLinks.every(link => /^https:\/\/detail\.1688\.com\//.test(link.target)));
  } finally {
    cleanup(ctx);
  }
});

test('图片：按 Pillow 尺寸等比缩放嵌入 BOM 图片区', async () => {
  const ctx = workspace('image');
  const imagePath = join(ctx.dir, '示例产品图.png');
  runPython(
    'from PIL import Image\nImage.new("RGB", (400, 300), (28, 120, 200)).save(__import__("sys").argv[1])',
    [imagePath],
  );

  const input = sampleInput();
  input.allowDraft = true;
  try {
    const res = await buildQuote(input, {
      outputDir: ctx.outputDir,
      workDir: ctx.workDir,
      imagePath,
    });
    assert.equal(res.checks.imageEmbedded, true);
    assert.equal(res.checks.imageCount, 1);

    const dump = dumpWorkbook(res.output, []);
    const front = dump.sheets['报价BOM'];
    assert.equal(front.images.length, 1, 'BOM 图片区没有嵌入图片');
    const { cx, cy } = front.images[0];
    assert.ok(cx > 0 && cy > 0, '图片锚点尺寸缺失');
    const px = cx / 9525;
    const py = cy / 9525;
    assert.ok(px <= 220.5 && py <= 137.5, `图片超出 220×137 盒：${px}×${py}`);
    assert.ok(Math.abs(px / py - 400 / 300) < 0.02, `图片未等比缩放：${px}×${py}`);
    assert.ok(px > 170, '图片过小');
  } finally {
    cleanup(ctx);
  }
});

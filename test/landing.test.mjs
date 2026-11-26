import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {buildQuote, PLUGIN_ROOT, SHEET_BOTTOM, SHEET_FRONT, SHEET_LANDING} from '../lib/quote.mjs';

const PYTHON =
  process.env.HWQ_PYTHON ||
  'C:\\Users\\Lenovo\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const SAMPLE = join(resolve(PLUGIN_ROOT), 'examples', 'sample-input.json');
const sampleInput = () => JSON.parse(readFileSync(SAMPLE, 'utf8'));

function workspace(name) {
  const dir = mkdtempSync(join(tmpdir(), `hwq-landing-${name}-`));
  return {dir, workDir: join(dir, 'work'), outputDir: join(dir, 'out')};
}

function cleanup(ctx) {
  try {
    rmSync(ctx.dir, {recursive: true, force: true});
  } catch {
    // 临时目录清理失败不影响断言。
  }
}

const INSPECT = `
import json, sys
from openpyxl import load_workbook

wb = load_workbook(sys.argv[1])
ws = wb[sys.argv[2]]
out = {
    'sheetNames': wb.sheetnames,
    'active': wb.active.title,
    'tabSelected': [bool(sheet.sheet_view.tabSelected) for sheet in wb.worksheets],
    'printArea': ws.print_area,
    'orientation': ws.page_setup.orientation,
    'paperSize': ws.page_setup.paperSize,
    'fitToWidth': ws.page_setup.fitToWidth,
    'fitToHeight': ws.page_setup.fitToHeight,
    'fitToPage': bool(getattr(ws.sheet_properties.pageSetUpPr, 'fitToPage', False)),
    'merged': sorted(str(item) for item in ws.merged_cells.ranges),
    'formats': {cell.coordinate: cell.number_format for row in ws.iter_rows() for cell in row
                if isinstance(cell.number_format, str) and cell.number_format not in ('General',)},
}
print('@@' + json.dumps(out, ensure_ascii=False))
`;

function inspect(path) {
  const result = spawnSync(PYTHON, ['-c', INSPECT, path, SHEET_LANDING], {
    encoding: 'utf8',
    timeout: 120000,
    env: {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'},
  });
  if (result.status !== 0) throw new Error(`python 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);
  const line = result.stdout.trim().split('\n').pop();
  return JSON.parse(line.slice(line.indexOf('@@') + 2));
}

const rowByLabel = (rows, label) => rows.filter((row) => row.label === label);

function assertClose(actual, expected, message, tolerance = 1e-6) {
  assert.equal(typeof actual, 'number', `${message}：实际不是数值（${actual}）`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}：${actual} vs ${expected}`);
}
const amountOf = (rows, label) => {
  const found = rowByLabel(rows, label);
  assert.equal(found.length, 1, `首页「${label}」应恰好出现一次，实际 ${found.length} 次`);
  return found[0].amount;
};

test('首页结构：三表顺序、默认选中、四列、公式链与横向打印', async () => {
  const ctx = workspace('structure');
  try {
    const res = await buildQuote(sampleInput(), {outputDir: ctx.outputDir, workDir: ctx.workDir});
    const info = inspect(res.output);
    assert.deepEqual(info.sheetNames, [SHEET_LANDING, SHEET_FRONT, SHEET_BOTTOM]);
    assert.equal(info.active, SHEET_LANDING, '打开工作簿时应默认停在首页');
    assert.deepEqual(info.tabSelected, [true, false, false]);
    assert.equal(info.orientation, 'landscape');
    assert.equal(String(info.paperSize), '9');
    assert.equal(String(info.fitToWidth), '1');
    assert.equal(String(info.fitToHeight), '1');
    assert.equal(info.fitToPage, true);
    assert.match(String(info.printArea), /A\$?1:\$?D\$?\d+$/);

    assert.equal(res.checks.landing.sheet, SHEET_LANDING);
    assert.ok(res.checks.landing.rows.length >= 8);
    assert.equal(res.checks.landing.rows[0].label, '材料', '明细第一行应是材料');
    assert.equal(res.checks.landing.rows[0].tag, 'material');
    assert.equal(
      res.checks.landing.rows[0].quantity,
      res.checks.weights.metal + (res.checks.weights.wood ?? 0),
      '材料数量应取 BOM 的金属+木重量',
    );
    assert.ok(
      Object.keys(info.formats).some((addr) => /^B[4-9]\d?$/.test(addr) && info.formats[addr].includes('"kg"')),
      `数量列应带单位显示：${JSON.stringify(info.formats)}`,
    );
    assert.equal(info.formats.D2, '0.00');

    // 首页合计必须与 BOM 含税报价逐分一致
    assert.equal(res.checks.landing.matchesBom, true);
    assertClose(res.checks.landing.total, res.checks.totals.taxed, '首页合计与 BOM 含税报价', 1e-6);
  } finally {
    cleanup(ctx);
  }
});

test('无配件产品：护角/说明书贴标/包装人工/验货装柜四项仍各计一次，合计 12.10', async () => {
  const ctx = workspace('no-accessory');
  try {
    const input = sampleInput();
    input.accessories = [];
    const res = await buildQuote(input, {outputDir: ctx.outputDir, workDir: ctx.workDir});
    const rows = res.checks.landing.rows;
    const fees = {
      护角: amountOf(rows, '护角'),
      '说明书、贴标': amountOf(rows, '说明书、贴标'),
      包装人工: amountOf(rows, '包装人工'),
      '验货、装柜': amountOf(rows, '验货、装柜'),
    };
    assert.deepEqual(fees, {护角: 1.6, '说明书、贴标': 4, 包装人工: 5, '验货、装柜': 1.5});
    const sum = Object.values(fees).reduce((acc, value) => acc + value, 0);
    assert.ok(Math.abs(sum - 12.1) < 1e-9, `四项固定费用合计应为 12.10，实际 ${sum}`);
    assert.equal(rowByLabel(rows, '材料').length, 1);
    assertClose(res.checks.landing.total, res.checks.totals.taxed, '首页合计与 BOM 含税报价');
    assert.equal(res.checks.landing.matchesBom, true);
  } finally {
    cleanup(ctx);
  }
});

test('多规格螺丝/螺母/垫片 + 门锁：紧固件按套合价、门锁一行、明细覆盖税与合计', async () => {
  const ctx = workspace('fastener-lock');
  try {
    const input = sampleInput();
    input.accessories = [
      {
        name: '内六角法兰面螺丝', spec: 'M6×15MM', quantity: 8, unit: 'PCS', unitPrice: 0.1,
        sourceType: 'user', sourceLabel: '用户提供', weightKgPerUnit: 0.006,
        weightSourceType: 'estimate', weightBasis: '同规格紧固件估重',
      },
      {
        name: '螺母', spec: 'M6', quantity: 8, unit: 'PCS', unitPrice: 0.2,
        sourceType: 'user', sourceLabel: '用户提供', weightKgPerUnit: 0.004,
        weightSourceType: 'estimate', weightBasis: '同规格紧固件估重',
      },
      {
        name: '平垫', spec: 'M6 平垫', quantity: 4, unit: 'PCS', unitPrice: 0.05,
        sourceType: 'user', sourceLabel: '用户提供', weightKgPerUnit: 0.003,
        weightSourceType: 'estimate', weightBasis: '同规格垫片估重',
      },
      {
        name: '门锁', spec: '锌合金搭扣锁', quantity: 1, unit: 'PCS', unitPrice: 3.5,
        sourceType: 'user', sourceLabel: '用户提供', weightKgPerUnit: 0.05,
        weightSourceType: 'estimate', weightBasis: '按同类门锁估重',
      },
    ];
    const res = await buildQuote(input, {outputDir: ctx.outputDir, workDir: ctx.workDir});
    const rows = res.checks.landing.rows;
    const layout = res.checks.rowMap;
    assert.equal(layout.extra, 2);

    assert.equal(rows[0].label, '材料');
    assert.equal(rows[1].label, '紧固件（螺丝、螺母）', '紧固件合并行应紧跟材料');
    assert.equal(res.checks.landing.fastenerRow, rows[1].row);
    assert.equal(rows[1].quantity, 1, '紧固件行按 1 套展示');
    const expectedFastener = 8 * 0.1 + 8 * 0.2 + 4 * 0.05;
    assert.ok(Math.abs(rows[1].amount - expectedFastener) < 1e-9, `紧固件合价 ${rows[1].amount}`);

    assert.equal(rowByLabel(rows, '门锁').length, 1, '门锁只能出现一行');
    assert.ok(Math.abs(amountOf(rows, '门锁') - 3.5) < 1e-9);
    assert.equal(rowByLabel(rows, '螺母').length, 0, '螺母应并入紧固件行');

    // 明细行金额之和应等于成本合计，且税金按明细计算后并入含税合计
    const costRow = res.checks.landing.costRow;
    assert.equal(typeof costRow, 'number');
    const detailSum = rows
      .filter((row) => typeof row.amount === 'number' && row.row < costRow)
      .reduce((acc, row) => acc + row.amount, 0);
    assert.ok(
      Math.abs(detailSum - res.checks.landing.costAmount) < 1e-9,
      `明细合计 ${detailSum} vs 成本合计 ${res.checks.landing.costAmount}`,
    );
    assert.ok(Math.abs(res.checks.landing.taxRate - 0.1) < 1e-12, '首页税率应显示 10%');
    assert.equal(res.checks.landing.matchesBom, true);
    assertClose(res.checks.landing.total, res.checks.totals.taxed, '首页合计与 BOM 含税报价');
  } finally {
    cleanup(ctx);
  }
});

test('多件装纸箱：纸箱费按每件拆分并随 BOM 一致', async () => {
  const ctx = workspace('carton-split');
  try {
    const single = sampleInput();
    single.order.unitsPerCarton = 1;
    const one = await buildQuote(single, {outputDir: join(ctx.outputDir, 'one'), workDir: join(ctx.workDir, 'one')});

    const quadruple = sampleInput();
    quadruple.order.unitsPerCarton = 4;
    const four = await buildQuote(quadruple, {
      outputDir: join(ctx.outputDir, 'four'),
      workDir: join(ctx.workDir, 'four'),
    });

    const cartonOne = amountOf(one.checks.landing.rows, '纸箱');
    const cartonFour = amountOf(four.checks.landing.rows, '纸箱');
    assert.ok(Math.abs(cartonOne - cartonFour * 4) < 1e-9, `每件纸箱费 ${cartonFour}×4 ≠ ${cartonOne}`);
    const qtyFour = rowByLabel(four.checks.landing.rows, '纸箱')[0].quantity;
    assert.ok(Math.abs(qtyFour - 0.25) < 1e-9, `每件箱数应为 0.25，实际 ${qtyFour}`);
    assert.equal(four.checks.landing.matchesBom, true);
    assert.equal(one.checks.landing.matchesBom, true);
  } finally {
    cleanup(ctx);
  }
});

test('改底稿单价：首页与 BOM 同步联动且始终逐分一致', async () => {
  const ctx = workspace('linkage');
  try {
    const base = sampleInput();
    const expensive = sampleInput();
    expensive.rates = {...(expensive.rates || {}), metal: 7};

    const low = await buildQuote(base, {outputDir: join(ctx.outputDir, 'low'), workDir: join(ctx.workDir, 'low')});
    const high = await buildQuote(expensive, {
      outputDir: join(ctx.outputDir, 'high'),
      workDir: join(ctx.workDir, 'high'),
    });

    assert.equal(low.checks.landing.matchesBom, true);
    assert.equal(high.checks.landing.matchesBom, true);
    const materialLow = amountOf(low.checks.landing.rows, '材料');
    const materialHigh = amountOf(high.checks.landing.rows, '材料');
    assert.ok(materialHigh > materialLow, '铁单价抬高后材料金额应上升');
    assert.ok(Math.abs(materialHigh - materialLow * 7 / 5) < 1e-9);
    assert.ok(high.checks.totals.taxed > low.checks.totals.taxed);
    assertClose(high.checks.landing.total, high.checks.totals.taxed, '首页合计与 BOM 含税报价');
  } finally {
    cleanup(ctx);
  }
});

test('缺价草稿：首页含税合计显示「待核价」，不出现假金额', async () => {
  const ctx = workspace('draft');
  try {
    const input = sampleInput();
    input.allowDraft = true;
    input.accessories = [
      {
        name: '门锁', spec: '锌合金搭扣锁', quantity: 1, unit: 'PCS',
        sourceType: 'user', sourceLabel: '用户提供，价格待核', weightKgPerUnit: 0.05,
        weightSourceType: 'estimate', weightBasis: '按同类门锁估重',
      },
    ];
    const res = await buildQuote(input, {outputDir: ctx.outputDir, workDir: ctx.workDir});
    assert.equal(res.metadata.draft, true);
    assert.equal(res.checks.landing.total, '待核价');
    assert.equal(res.checks.landing.matchesBom, false);
    assert.match(res.output, /_待核价_/);
    const info = inspect(res.output);
    assert.deepEqual(info.sheetNames, [SHEET_LANDING, SHEET_FRONT, SHEET_BOTTOM]);
  } finally {
    cleanup(ctx);
  }
});

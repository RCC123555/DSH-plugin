import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildQuote} from '../lib/quote.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.join(here, '..', 'examples', 'sample-real-evidence.json');

test('只有 1 条配件的产品也能导出（模板保留行整行留空，不出现半填数据）', async () => {
  const input = JSON.parse(await fs.readFile(examplePath, 'utf8'));
  assert.equal(input.accessories.length, 1, '该用例要求恰好 1 条配件');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hwq-one-accessory-'));
  try {
    const result = await buildQuote(input, {
      outputDir: path.join(root, 'out'),
      workDir: path.join(root, 'work'),
    });
    assert.ok(result.output.endsWith('.xlsx'));
    const stat = await fs.stat(result.output);
    assert.ok(stat.size > 10000, '导出的工作簿不应是空壳');
    assert.deepEqual(result.sheets.map(sheet => sheet.name), ['报价BOM', '报价底稿']);
    // 只有 1 条配件时不需要扩行：配件行仍是模板的 14/15 两行
    assert.equal(result.checks.rowMap.accessoryStart, 14);
    assert.equal(result.checks.rowMap.accessorySubtotal, 16);
    assert.deepEqual(result.checks.formulaErrors, []);
    assert.equal(result.checks.totals.cost, 215.03187499999999);
    assert.equal(result.checks.totals.taxed, 287.6330789809692);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

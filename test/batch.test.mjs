import assert from 'node:assert/strict'
import test from 'node:test'

import {SUMMARY_HEADERS, SUMMARY_WIDTHS, buildSummary, summaryRows} from '../lib/batch.mjs'
import {TOOLS} from '../lib/index.mjs'

function fakeCalc(sku, name, net, overrides = {}) {
  const directCost = 100
  return {
    product: {
      sku,
      name,
      dimensions: {length: 63, width: 63, height: 163},
      cartonDimensions: {length: 90, width: 50, height: 16.5},
      date: '2026-11-04',
    },
    order: {quantity: 500, unitsPerCarton: 1},
    rates: {netMargin: 0.085},
    weights: {net, gross: net + 1.5, metal: net - 1, wood: 1},
    costs: {
      main: 40,
      accessories: 1.032,
      processing: 21,
      coating: 17.5,
      protection: 5.2135,
      carton: 7.9538,
      fixedPackaging: 12.1,
    },
    directCost,
    totals: {profit: 15.852, management: 14.2668, beforeTax: 169.54, tax: 16.954, afterTax: 186.494},
    ...overrides,
  }
}

test('汇总表列定义完整且宽度一一对应', () => {
  assert.equal(SUMMARY_HEADERS.length, 23)
  assert.equal(SUMMARY_WIDTHS.length, SUMMARY_HEADERS.length)
  assert.equal(SUMMARY_HEADERS[1], 'SKU')
  assert.equal(SUMMARY_HEADERS[21], '含税报价Q')
  assert.ok(SUMMARY_WIDTHS.every((width) => typeof width === 'number' && width > 0))
})

test('summaryRows 逐款取数、合计行只累加金额列', () => {
  const rows = summaryRows([
    {calc: fakeCalc('B0GWLX4NC7', '滚动鸟架', 9.98), item: {note: '待核'}},
    {calc: fakeCalc('B0G6D67828', '鹦鹉鸟架', 13), item: {}},
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows[0][0], 1)
  assert.equal(rows[1][0], 2)
  assert.equal(rows[0][1], 'B0GWLX4NC7')
  assert.equal(rows[0][3], '63×63×163')
  assert.equal(rows[0][4], '90×50×16.5')
  assert.equal(rows[0][22], '待核')
  assert.equal(rows[1][22], '')
  const sum = rows[2]
  assert.equal(sum[2], '合计（2款，按500件/单）')
  assert.equal(sum[16], 200) // 每件成本 C 两件合计
  assert.equal(sum[21], 372.988) // 含税报价 Q 两件合计
  assert.equal(sum[0], null)
  assert.equal(sum[1], null)
  assert.equal(sum[5], null) // 重量列不合计
})

test('buildSummary 标题带批次名/日期/规则版本', () => {
  const products = [{calc: fakeCalc('A', '甲', 9.98)}]
  const summary = buildSummary(products, {label: '星商宠物笼5款', date: '2026-11-04'})
  assert.match(summary.title, /星商宠物笼5款 报价汇总/)
  assert.match(summary.title, /2026-11-04/)
  assert.match(summary.title, /500件\/单、1件\/箱、含税净利率8\.5%/)
  assert.equal(summary.rows.length, 2)
  assert.deepEqual(summary.headers, [...SUMMARY_HEADERS])
  assert.ok(summary.notes.length >= 5)
  assert.equal(summary.widths.length, 23)
})

test('hwq_quote_batch 已注册且参数契约正确', () => {
  const names = TOOLS.map((tool) => tool.name)
  assert.deepEqual(names, [
    'hwq_calculate',
    'hwq_quote',
    'hwq_quote_batch',
    'hwq_1688_login',
    'hwq_1688_search',
    'hwq_1688_offer',
    'hwq_1688_average',
  ])
  const batch = TOOLS.find((tool) => tool.name === 'hwq_quote_batch')
  assert.deepEqual(batch.parameters.required, ['items'])
  assert.equal(batch.parameters.properties.items.type, 'array')
  assert.deepEqual(batch.parameters.properties.items.items.properties.allowDraft.type, 'boolean')
  assert.match(batch.description, /每款一张分表/)
  assert.match(batch.description, /00_汇总/)
})

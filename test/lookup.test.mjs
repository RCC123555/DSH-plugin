// hardware-quote · lib/lookup.mjs 验收测试
//
// 1) 逐条等价旧版 _legacy/test-1688-lookup.mjs 的 19 个查价/证据/均价用例；
// 2) 新增 evidenceSchema / averageEvidenceSchema 与校验器口径一致性；
// 3) 新增核算器对 1688 证据问题的 blockingIssues 分类（input，且不得草稿放行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {is1688, isOffer, classifyFailure, planLookups, validatePriceEvidence, priceFromEvidence, averagePriceEvidence, priceFromAverage, evidenceSchema, averageEvidenceSchema} from '../lib/lookup.mjs';
import {calculate} from '../lib/pricing.mjs';

const evidence = () => ({url: 'https://detail.1688.com/offer/1234567890.html', supplier: '测试供应商（测试夹具，非真实商家报价）', title: '测试M6螺丝', queriedAt: '2026-11-02', selectedSpec: 'M6×15', specMatched: true, quoteUnit: '100个', targetUnit: '个', targetUnitsPerQuoteUnit: 100, originalPrice: 3.2, currency: 'CNY', priceKind: 'regular', evidenceKind: 'visible_dom', observedText: '测试夹具：M6×15，3.20元/100个，10包起，10至100包档', searchMethod: 'keyword', keywords: 'M6 15 螺丝', minOrderQty: 10, tierMinQty: 10, tierMaxQty: 100});

/* ------------------------------------------------------------------ *
 * 旧版 test-1688-lookup.mjs 的 19 个用例（逐条翻译）
 * ------------------------------------------------------------------ */

test('域名及具体详情链接严格检查', () => {
  assert(is1688(evidence().url));
  assert(isOffer(evidence().url));
  assert(!is1688('https://1688.com.example.org/x'));
  assert(!isOffer('https://s.1688.com/selloffer/offer_search.htm'));
  assert(!isOffer('http://detail.1688.com/offer/123.html'));
});

test('通用网页错误不推断站点登录或验证码', () => {
  assert.equal(classifyFailure({channel: 'web', message: 'Internal Error', pageText: '扫码登录'}), 'web_tool_error');
});

test('连接故障与真实页面障碍分开', () => {
  assert.equal(classifyFailure({channel: 'browser', message: 'Debugger unattached', pageUrl: evidence().url, pageText: '扫码登录'}), 'browser_connection_error');
  assert.equal(classifyFailure({channel: 'browser', pageUrl: 'https://www.1688.com/', pageText: '登录后查看价格'}), 'login_required');
  assert.equal(classifyFailure({channel: 'browser', pageUrl: evidence().url, pageText: '请完成滑块验证'}), 'verification_required');
  assert.equal(classifyFailure({channel: 'browser', pageText: '扫码登录'}), 'browser_url_unverified');
});

test('缺价任务保留明确零价和已批准估价，pending模板仍查价', () => {
  const p = planLookups({accessories: [{name: '零价', sourceType: 'user', unitPrice: 0}, {name: '待查', sourceType: 'pending', templateKey: 'm6-nut', quantity: 4}, {name: '估价', sourceType: 'estimate', unitPrice: 1, estimateApproved: true}], order: {quantity: 500}});
  assert.equal(p.tasks.length, 1);
  assert.equal(p.tasks[0].quantityBeforeUnitConversion, 2000);
  assert.equal(p.tasks[0].status, 'not_started');
});

test('原报价包装及MOQ档位转换', () => {
  const p = priceFromEvidence(evidence(), 2000);
  assert.equal(p.unitPrice, .032);
  assert.equal(p.minOrderQty, 1000);
  assert.equal(p.priceTierMinQty, 1000);
  assert.equal(p.priceTierMaxQty, 10000);
  assert.match(p.notes, /1.*=100个/);
});

test('未公布MOQ档位不强制判无价', () => {
  const e = evidence(); delete e.minOrderQty; delete e.tierMinQty; delete e.tierMaxQty;
  assert.equal(validatePriceEvidence(e, 2000).length, 0);
  assert(!('minOrderQty' in priceFromEvidence(e, 2000)));
});

test('图片搜索需实际图片记录', () => {
  const e = evidence(); e.searchMethod = 'image';
  assert(validatePriceEvidence(e, 2000).some(x => x.includes('图片')));
  e.inputImage = '当前任务商品配件局部截图';
  assert.equal(validatePriceEvidence(e, 2000).length, 0);
});

test('拒绝起始价未确认规格和不足MOQ', () => {
  const e = evidence(); e.priceKind = 'starting';
  assert(validatePriceEvidence(e, 2000).length);
  e.priceKind = 'regular'; e.specMatched = false;
  assert(validatePriceEvidence(e, 2000).length);
  assert.throws(() => priceFromEvidence(evidence(), 500), /起订量|档位/);
});

test('拒绝颠倒档位及非人民币', () => {
  const e = evidence(); e.tierMaxQty = 1;
  assert(validatePriceEvidence(e, 2000).some(x => x.includes('颠倒')));
  e.currency = 'USD';
  assert(validatePriceEvidence(e, 2000).some(x => x.includes('人民币')));
});

const base = () => ({product: {name: '浏览器证据测试', material: 'metal', netWeightKg: 10, netWeightBasis: 'assembled', dimensions: {length: 100, width: 50, height: 70, unit: 'cm'}, cartonDimensions: {length: 110, width: 60, height: 10, unit: 'cm'}}, order: {quantity: 500}, processing: {needsCoating: true}, accessories: [{name: '测试螺丝', spec: 'M6×15', quantity: 4, weightKgPerUnit: .005, ...priceFromEvidence(evidence(), 2000)}], packaging: {protection: [], requireTopBottomEps: false, epsExceptionBasis: '测试夹具排除EPS，不用于实物报价'}});

test('核算器接受完整证据，拦截无证据1688价', () => {
  const x = base();
  assert.equal(calculate(x).ready, true);
  delete x.accessories[0].priceEvidence;
  const q = calculate(x);
  assert.equal(q.ready, false);
  assert.equal(q.accessories[0].unitPrice, null);
  assert.equal(q.totals, null);
  assert(q.issues.some(issue => issue.code === 'lookup_evidence'));
});

test('核算器拦截单位和价格不一致', () => {
  const x = base();
  x.accessories[0].unitPrice = 3.2;
  assert.equal(calculate(x).ready, false);
  x.accessories[0].unitPrice = .032;
  x.accessories[0].priceEvidence.targetUnit = '副';
  assert.equal(calculate(x).ready, false);
});

test('核算器拦截被丢弃的MOQ', () => {
  const x = base();
  delete x.accessories[0].minOrderQty;
  assert.equal(calculate(x).ready, false);
});

test('明确价格和非1688来源仍兼容', () => {
  const x = base();
  x.accessories[0] = {name: '测试配件', quantity: 4, weightKgPerUnit: .005, unitPrice: 0, sourceType: 'user'};
  assert.equal(calculate(x).ready, true);
  Object.assign(x.accessories[0], {unitPrice: 1, sourceType: 'web', provider: '测试公开供应商', url: 'https://example.com/item', queriedAt: '2026-11-02', quoteUnit: '元/个'});
  assert.equal(calculate(x).ready, true);
});

const options = {comparisonKey: 'M6×15钢螺丝', targetUnit: '个', priceBasis: '税未注明，运费另计'};
const sample = (price = 3.2, id = '1234567890') => ({...evidence(), ...options, url: `https://detail.1688.com/offer/${id}.html`, originalPrice: price});

test('均价先归一且保留多条原始证据', () => {
  const a = averagePriceEvidence([sample(), sample(6.4, '1234567891')], 2000, options);
  assert.equal(a.mean, .048);
  assert.equal(a.sampleCount, 2);
  assert.equal(priceFromAverage(a, 2000).unitPrice, .048);
});

test('跟踪参数不同的同一商品SKU仅计一次', () => {
  const b = sample(); b.url += '?tracking=1';
  const a = averagePriceEvidence([sample(), b], 2000, options);
  assert.equal(a.sampleCount, 1);
  assert.equal(a.excluded.length, 1);
});

test('排除异材质口径与无效优惠价并保留理由', () => {
  const a = averagePriceEvidence([sample(), {...sample(1, '2'), comparisonKey: 'PP轮'}, {...sample(1, '3'), priceBasis: '含运费'}, {...sample(1, '4'), priceKind: 'coupon'}], 2000, options);
  assert.equal(a.mean, .032);
  assert.equal(a.excluded.length, 3);
});

test('零有效样本报错，单样本明确标注', () => {
  assert.throws(() => averagePriceEvidence([], 2000, options));
  const p = priceFromAverage(averagePriceEvidence([sample()], 2000, options), 2000);
  assert.match(p.provider, /单一样本/);
});

test('拒绝均价篡改和采购量变化失效', () => {
  const a = averagePriceEvidence([sample(), sample(6.4, '1234567891')], 2000, options);
  assert.throws(() => priceFromAverage({...a, mean: .01}, 2000));
  assert.throws(() => priceFromAverage(a, 500));
});

test('核算器接受可复算均价且拦截伪造价及伪造MOQ', () => {
  const x = base();
  const a = averagePriceEvidence([sample(), sample(6.4, '1234567891')], 2000, options);
  Object.assign(x.accessories[0], priceFromAverage(a, 2000));
  delete x.accessories[0].minOrderQty;
  delete x.accessories[0].priceTierMinQty;
  delete x.accessories[0].priceTierMaxQty;
  assert.equal(calculate(x).ready, true);
  x.accessories[0].unitPrice = .02;
  assert.equal(calculate(x).ready, false);
  x.accessories[0].unitPrice = a.mean;
  x.accessories[0].minOrderQty = 1;
  assert.equal(calculate(x).ready, false);
});

/* ------------------------------------------------------------------ *
 * 新增：JSON Schema 草稿与校验器口径一致
 * ------------------------------------------------------------------ */

test('evidenceSchema 为 JSON Schema 草稿且与 validatePriceEvidence 必填字段一致', () => {
  assert.equal(evidenceSchema.type, 'object');
  assert.equal(evidenceSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const required = new Set(evidenceSchema.required);
  for (const k of ['url', 'supplier', 'title', 'selectedSpec', 'quoteUnit', 'targetUnit', 'targetUnitsPerQuoteUnit', 'observedText', 'queriedAt', 'evidenceKind', 'searchMethod', 'specMatched', 'currency', 'priceKind', 'originalPrice']) {
    assert(required.has(k), `evidenceSchema 缺少必填 ${k}`);
  }
  assert.equal(evidenceSchema.properties.currency.const, 'CNY');
  assert.equal(evidenceSchema.properties.priceKind.const, 'regular');
  assert.equal(evidenceSchema.properties.specMatched.const, true);
  assert.match(evidenceSchema.properties.url.pattern, /detail\\\.1688\\\.com/);
  assert.equal(evidenceSchema.properties.targetUnitsPerQuoteUnit.exclusiveMinimum, 0);
  assert.equal(evidenceSchema.properties.originalPrice.minimum, 0);
  assert.equal(evidenceSchema.allOf.length, 2); // keyword 需 keywords、image 需 inputImage
  // 实际合法证据覆盖全部必填键
  for (const k of required) assert(k in evidence(), `测试证据缺少 ${k}`);
});

test('averageEvidenceSchema 要求统一对比口径与样本数组', () => {
  const required = new Set(averageEvidenceSchema.required);
  for (const k of ['comparisonKey', 'targetUnit', 'priceBasis', 'samples']) assert(required.has(k), `averageEvidenceSchema 缺少 ${k}`);
  assert.equal(averageEvidenceSchema.properties.samples.minItems, 1);
  assert.equal(averageEvidenceSchema.properties.samples.items, evidenceSchema);
  const a = averagePriceEvidence([sample()], 2000, options);
  for (const k of ['comparisonKey', 'targetUnit', 'priceBasis', 'samples']) assert(a[k] !== undefined, `均价结果缺少 ${k}`);
});

test('classifyFailure 区分无语料与未解决状态', () => {
  assert.equal(classifyFailure({channel: 'browser', pageUrl: evidence().url, pageText: '没有找到相关商品'}), 'no_match');
  assert.equal(classifyFailure({channel: 'browser', pageUrl: evidence().url, pageText: ''}), 'unresolved');
  assert(is1688('https://www.1688.com/'));
});

test('无效 1688 证据归为 input 且不属于缺价草稿放行范围', () => {
  const x = base();
  delete x.accessories[0].priceEvidence;
  const q = calculate(x);
  assert.equal(q.ready, false);
  assert.equal(q.draftOnly, false);
  const bi = q.blockingIssues.find(i => i.code === 'lookup_evidence');
  assert(bi, '应产生 lookup_evidence blocking 问题');
  assert.equal(bi.severity, 'input');
  assert.equal(bi.draftAllowed, false);
});

test('缺价待核仍可草稿，但证据矛盾不可草稿', () => {
  const missing = base();
  missing.accessories.push({name: '待查配件', quantity: 4, weightKgPerUnit: .005, sourceType: 'pending'});
  assert.equal(calculate(missing).draftOnly, true);
  const contradicted = base();
  contradicted.accessories[0].unitPrice = 3.2; // 与证据换算不符
  const q = calculate(contradicted);
  assert.equal(q.ready, false);
  assert.equal(q.draftOnly, false);
  assert(q.blockingIssues.some(i => i.code === 'lookup_evidence' && i.draftAllowed === false));
});

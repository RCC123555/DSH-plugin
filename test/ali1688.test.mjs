// hardware-quote · 1688 查价层测试
//
// 分两层：
//   1) 离线层（默认跑）：纯解析函数 + 真实 fixture（详情页 window.context 剪裁、
//      合成搜索页 HTML、真实 live-*.json 抓取结果）。不启动浏览器。
//   2) live 层（HWQ_LIVE=1 时跑）：真实 Chrome 端口复用、登录态、关键词搜索、详情抽取。
//
// 跑法：
//   node --test test/ali1688.test.mjs
//   HWQ_LIVE=1 node --test test/ali1688.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as ali from '../lib/ali1688.mjs';
import {validatePriceEvidence, averagePriceEvidence, isOffer} from '../lib/lookup.mjs';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const readJson = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const readText = name => fs.readFileSync(path.join(fixtures, name), 'utf8');
const LIVE = process.env.HWQ_LIVE === '1';

// ---------------------------------------------------------------------------
// 离线层：纯解析函数
// ---------------------------------------------------------------------------

test('decodeHtmlText 还原页面里的 HTML 实体', () => {
  assert.equal(ali.decodeHtmlText('4寸10cm&gt;黑色'), '4寸10cm>黑色');
  assert.equal(ali.decodeHtmlText('A&amp;B &quot;x&quot; &#39;y&#39;'), "A&B \"x\" 'y'");
  assert.equal(ali.decodeHtmlText('  多   空白\n 文本  '), '多 空白 文本');
});

test('stripTags 去掉标签与脚本，保留可见文字', () => {
  const html = '<div class="x"><style>.a{color:red}</style><script>var a=1;</script>合成测试 商品</div>';
  assert.equal(ali.stripTags(html), '合成测试 商品');
});

test('parseCardText 解析被 span 拆开的价格、单位、MOQ、销量', () => {
  const parsed = ali.parseCardText('不满足：3项 ¥ 0 . 25 运费2元 100个起批 ¥0.25/个 月销 1200');
  assert.equal(parsed.priceText, '¥0.25');
  assert.equal(parsed.price, 0.25);
  assert.equal(parsed.unitText, '个');
  assert.equal(parsed.moqText, '100个');
  assert.equal(parsed.soldText, '1200');
  assert.equal(ali.parseCardText('全网10万+件').soldText, '10万+');
});

test('parseCardText 解析不到就留空，不猜价格', () => {
  const parsed = ali.parseCardText('铁艺沙发脚 家具五金配件');
  assert.deepEqual(parsed, {priceText: null, price: null, unitText: null, moqText: null, soldText: null});
});

test('parseCompanyFromText 提取公司名', () => {
  assert.equal(ali.parseCompanyFromText('发货地 广东佛山 佛山市南海区亿长明五金厂 回头率59%'), '佛山市南海区亿长明五金厂');
  assert.equal(ali.parseCompanyFromText('没有公司名'), null);
});

test('detectBlock 区分登录墙 / 验证码 / 正常页', () => {
  assert.equal(ali.detectBlock({url: 'https://login.1688.com/member/signin.htm', text: ''}), 'login');
  assert.equal(ali.detectBlock({url: 'https://login.taobao.com/member/login.jhtml', text: ''}), 'login');
  assert.equal(ali.detectBlock({url: 'https://s.1688.com/selloffer/offer_search.htm?keywords=x', text: '请拖动滑块完成验证'}), 'captcha');
  assert.equal(ali.detectBlock({url: 'https://s.1688.com/selloffer/offer_search.htm?keywords=x', text: '使用 1688 / 淘宝App 扫码登录'}), 'login');
  assert.equal(ali.detectBlock({url: 'https://detail.1688.com/offer/721403962321.html', text: '铁艺餐桌脚 茶几 沙发脚'}), null);
});

test('parseSearchCard 只接受 detail.1688.com/offer/<id>.html 链接', () => {
  const card = ali.parseSearchCard({
    url: 'https://detail.1688.com/offer/721403962321.html?spm=x',
    title: '铁艺餐桌脚茶几沙发脚三线铁线脚',
    text: '¥ 5 . 80 / 个 4个起批 月销 4100 佛山市南海区亿长明五金厂',
    company: '',
  });
  assert.equal(card.url, 'https://detail.1688.com/offer/721403962321.html');
  assert.equal(card.title, '铁艺餐桌脚茶几沙发脚三线铁线脚');
  assert.equal(card.price, 5.8);
  assert.equal(card.unitText, '个');
  assert.equal(card.moqText, '4个');
  assert.equal(card.company, '佛山市南海区亿长明五金厂');
  assert.equal(ali.parseSearchCard({url: 'https://www.1688.com/', title: 'x'}), null);
});

test('parseSearchCards 按 URL 去重并补全缺失字段', () => {
  const result = ali.parseSearchCards([
    {url: 'https://detail.1688.com/offer/100000000011.html', title: '合成商品甲', text: '¥ 6 . 80 / 个'},
    {url: 'https://detail.1688.com/offer/100000000011.html', title: '合成商品甲', text: '100个起批 月销 1200'},
    {url: 'https://detail.1688.com/offer/100000000012.html', title: '合成商品乙', text: '¥9.50/个'},
  ]);
  assert.equal(result.candidates.length, 2);
  const merged = result.candidates.find(c => c.url.endsWith('100000000011.html'));
  assert.equal(merged.price, 6.8);
  assert.equal(merged.moqText, '100个');
  assert.equal(merged.soldText, '1200');
});

test('parseSearchHtml 解析内嵌 JSON（__INIT_DATA__）', () => {
  const result = ali.parseSearchHtml(readText('search-page-inline-json.html'));
  assert.equal(result.candidates.length, 2);
  const first = result.candidates[0];
  assert.equal(first.url, 'https://detail.1688.com/offer/100000000001.html');
  assert.equal(first.title, '合成测试商品甲 内六角法兰盘螺丝 M6*15');
  assert.equal(first.price, 12.5);
  assert.equal(first.unitText, '个');
  assert.equal(first.moqText, '100个');
  assert.equal(first.company, '合成测试五金厂');
  assert.equal(first.soldText, '3200');
  assert.ok(result.notes.some(note => note.includes('__INIT_DATA__')));
});

test('parseSearchHtml 退回详情链接 + 邻近文本，并按 URL 去重', () => {
  const result = ali.parseSearchHtml(readText('search-page-anchors.html'));
  assert.equal(result.candidates.length, 2);
  const card = result.candidates.find(c => c.url.endsWith('100000000011.html'));
  assert.equal(card.title, '合成测试商品丙 内六角法兰盘螺丝');
  assert.equal(card.price, 6.8);
  assert.equal(card.unitText, '个');
  assert.equal(card.moqText, '100个');
  assert.equal(card.soldText, '1200');
  assert.equal(card.company, '合成测试紧固件有限公司');
});

test('parseSearchHtml 对 JS 空壳页面返回 0 候选并说明原因', () => {
  const result = ali.parseSearchHtml('<html><body><div id="app"></div><script>render()</script></body></html>');
  assert.equal(result.candidates.length, 0);
  assert.ok(result.notes.some(note => note.includes('未从 HTML 解析出候选')));
});

test('extractOfferFromContext 从真实详情页 window.context 抽取标题/供应商/SKU/阶梯价', () => {
  const fixture = readJson('offer-context-721403962321.json');
  const data = ali.extractOfferFromContext(fixture.data);
  assert.equal(data.contextFound, true);
  assert.equal(data.title, '铁艺餐桌脚茶几沙发脚三线铁线脚 家具五金配件批发三角支架桌腿');
  assert.equal(data.company, '佛山市南海区亿长明五金厂');
  assert.equal(data.unit, '个');
  assert.equal(data.beginNum, 4);
  assert.equal(data.props.length, 2);
  assert.equal(data.props[0].prop, '规格');
  assert.equal(data.props[0].values.length, 19);
  assert.equal(data.props[0].values[0], '4寸10cm');
  assert.deepEqual(data.props[1], {fid: 404, prop: '颜色', values: ['黑色']});
  assert.deepEqual(data.tiers, [
    {price: 5.8, priceText: '¥5.80', beginAmount: 4},
    {price: 22.2, priceText: '¥22.20', beginAmount: 4},
  ]);
  assert.equal(data.offers.length, 19);
  const first = data.offers.find(offer => offer.props === '4寸10cm > 黑色');
  assert.ok(first, '应存在 4寸10cm > 黑色 的 SKU');
  assert.equal(first.price, 5.8);
  assert.equal(first.unit, '个');
  assert.equal(first.moq, 4);
  assert.equal(first.moqText, '≥4个');
  assert.ok(first.skuId);
  assert.ok(first.specId);
  // &gt; 必须还原成 >，否则上层规格匹配会失败
  assert.ok(data.offers.every(offer => !offer.props.includes('&gt;')));
});

test('extractOfferFromContext 遇到不可读 context 返回 domNotes 而不是抛错', () => {
  const result = ali.extractOfferFromContext({});
  assert.equal(result.contextFound, false);
  assert.deepEqual(result.offers, []);
  assert.ok(result.domNotes[0].includes('dataJson 不可读'));
});

test('extractOfferFromDom 兜底解析可见文本', () => {
  const result = ali.extractOfferFromDom({
    titleText: '铁艺餐桌脚茶几沙发脚三线铁线脚',
    companyText: '佛山市南海区亿长明五金厂',
    text: '¥ 5 . 80 / 个 4个起批 月销 4100',
    skuTexts: ['4寸10cm', '黑色'],
  });
  assert.equal(result.contextFound, false);
  assert.equal(result.title, '铁艺餐桌脚茶几沙发脚三线铁线脚');
  assert.equal(result.company, '佛山市南海区亿长明五金厂');
  assert.equal(result.unit, '个');
  assert.equal(result.offers.length, 2);
  assert.equal(result.offers[0].priceText, '¥5.80');
  assert.ok(result.domNotes[0].includes('window.context 不可用'));
});

test('matchHint 完整词元命中、部分命中、空关键词三种情况', () => {
  const full = ali.matchHint('内六角法兰盘螺丝', {title: '304不锈钢 内六角法兰盘螺丝 M6*15'});
  assert.equal(full.matched, 1);
  assert.equal(full.total, 1);

  const partial = ali.matchHint('内六角法兰盘螺丝 M6*15', {title: '304不锈钢平头内六角螺丝钉沉头螺栓螺母套装'});
  assert.equal(partial.matched, 0);
  assert.ok(partial.partial >= 1, '中文双字片段应命中');
  assert.ok(partial.hint.includes('部分词元命中'));

  assert.deepEqual(ali.matchHint('', {title: 'x'}), {matched: 0, total: 0, partial: 0, hint: null});
});

// ---------------------------------------------------------------------------
// 离线层：证据组装（联通 lib/lookup.mjs 的校验器）
// ---------------------------------------------------------------------------

test('collectEvidence 产出旧版 14 字段（缺失留 null，不猜）', () => {
  const live = readJson('live-offer-721403962321.json');
  const sku = live.offers.find(offer => offer.props === '4寸10cm > 黑色');
  const evidence = ali.collectEvidence({
    offer: {url: live.url, company: live.company, title: live.title, unit: live.unit, tiers: live.tiers, within: undefined, domNotes: live.domNotes},
    sku,
    targetUnit: '个',
    unitsPerOriginalUnit: 1,
    method: 'keyword_search+offer_detail',
    keywordOrImage: '铁艺餐桌脚',
    capturedAt: live.capturedAt,
  });
  assert.deepEqual(Object.keys(evidence).sort(), [
    'capturedAt', 'detailUrl', 'domObservation', 'keywordOrImage', 'method', 'moq',
    'originalPrice', 'originalUnit', 'sku', 'specMatch', 'supplier', 'targetUnit',
    'title', 'unitsPerOriginalUnit',
  ]);
  assert.equal(evidence.detailUrl, live.url);
  assert.equal(evidence.supplier, live.company);
  assert.equal(evidence.title, live.title);
  assert.equal(evidence.capturedAt, live.capturedAt);
  assert.equal(evidence.method, 'keyword_search+offer_detail');
  assert.equal(evidence.keywordOrImage, '铁艺餐桌脚');
  assert.equal(evidence.sku, '4寸10cm > 黑色');
  assert.equal(evidence.specMatch, null, '未显式核对规格时不能自报匹配');
  assert.equal(evidence.originalPrice, 5.8);
  assert.equal(evidence.originalUnit, '个');
  assert.equal(evidence.targetUnit, '个');
  assert.equal(evidence.unitsPerOriginalUnit, 1);
  assert.equal(evidence.moq, 4);
  assert.ok(evidence.domObservation.includes('¥5.80'));
});

test('toEvidence 映射后可直接通过 validatePriceEvidence', () => {
  const live = readJson('live-offer-721403962321.json');
  const sku = live.offers.find(offer => offer.props === '4寸10cm > 黑色');
  const evidence = ali.toEvidence(
    {...sku, supplier: live.company, title: live.title, url: live.url},
    {
      queriedAt: '2026-11-04',
      searchMethod: 'keyword',
      keywords: '铁艺餐桌脚',
      targetUnit: '个',
      targetUnitsPerQuoteUnit: 1,
      selectedSpec: sku.props,
      observedText: `页面规格 ${sku.props}，页面价格文本 ${sku.priceText}，起订 ${sku.moqText}`,
      specMatched: true,
      minOrderQty: sku.moq,
    },
  );
  assert.equal(evidence.currency, 'CNY');
  assert.equal(evidence.priceKind, 'regular');
  assert.equal(evidence.originalPrice, 5.8);
  assert.equal(evidence.queriedAt, '2026-11-04');
  assert.ok(isOffer(evidence.url));
  const issues = validatePriceEvidence(evidence, 500);
  assert.deepEqual(issues, [], `validatePriceEvidence 不应报错：${issues.join('；')}`);
});

test('toEvidence 缺字段时不猜，交给 validator 报问题', () => {
  const evidence = ali.toEvidence(
    {price: 5.8, supplier: '佛山市南海区亿长明五金厂', title: '铁艺餐桌脚', unit: '个', url: 'https://detail.1688.com/offer/721403962321.html'},
    {queriedAt: '2026-11-04', searchMethod: 'keyword', keywords: '铁艺餐桌脚', targetUnit: '个', targetUnitsPerQuoteUnit: 1},
  );
  assert.equal(evidence.selectedSpec, null, '未提供规格时映射为 null，不能编造');
  assert.equal(evidence.specMatched, undefined, '未核对规格时不写 specMatched');
  const issues = validatePriceEvidence(evidence, 500);
  assert.ok(issues.includes('缺少selectedSpec'));
  assert.ok(issues.includes('所选规格尚未核对匹配'));
});

test('search → offer → toEvidence → validate → average 可直接串联（真实 fixture，铁艺脚）', () => {
  // 这条只验证机制串联（映射→校验→均价），两条样本来自同一真实 offer 的不同规格；
  // 同规格比价口径由上层 comparisonKey 保证，这里不假装它们是同一需求样本。
  const chainOptions = {
    queriedAt: '2026-11-04',
    searchMethod: 'keyword',
    keywords: '铁艺餐桌脚',
    targetUnit: '个',
    targetUnitsPerQuoteUnit: 1,
    evidenceKind: 'visible_dom',
    comparisonKey: '串联自检：铁艺餐桌脚（仅验证机制，非同规格比价）',
    priceBasis: '含税不含运出厂价',
  };
  const offer = readJson('live-offer-721403962321.json');
  const skus = ['4寸10cm > 黑色', '8寸20cm > 黑色'].map(props => {
    const sku = offer.offers.find(item => item.props === props);
    assert.ok(sku, `fixture 应包含规格 ${props}`);
    return sku;
  });
  const samples = skus.map(sku =>
    ali.toEvidence(
      {...sku, supplier: offer.company, title: offer.title, url: offer.url},
      {...chainOptions, selectedSpec: sku.props, observedText: `页面价格文本 ${sku.priceText}；SKU ${sku.skuId}`, specMatched: true, minOrderQty: sku.moq, tierMinQty: offer.tiers[0].beginAmount},
    ),
  );
  for (const sample of samples) {
    assert.deepEqual(validatePriceEvidence(sample, 500), []);
    assert.equal(sample.comparisonKey, chainOptions.comparisonKey);
    assert.equal(sample.priceBasis, chainOptions.priceBasis);
  }
  const record = averagePriceEvidence(samples, 500, {
    comparisonKey: chainOptions.comparisonKey,
    targetUnit: '个',
    priceBasis: chainOptions.priceBasis,
  });
  assert.equal(record.method, 'arithmetic_mean');
  assert.equal(record.sampleCount, 2);
  assert.equal(record.excluded.length, 0);
  const expectedMean = (skus[0].price + skus[1].price) / 2;
  assert.ok(Math.abs(record.mean - expectedMean) < 1e-9);
});

test('结构化规格匹配：M6*15 的候选必须是 M6、长度 15、非套装且头型不冲突', () => {
  const ok = ali.matchSpec({query: '内六角 M6*15', title: '304不锈钢内六角螺丝', spec: 'M6*15-单颗'});
  assert.equal(ok.matched, true, ok.reason);
  assert.deepEqual(ok.candidate.threads, ['M6']);
  assert.deepEqual(ok.candidate.lengths, ['15']);

  const lengthMismatch = ali.matchSpec({query: '内六角 M6*15', title: '304不锈钢内六角螺丝', spec: 'M6*25'});
  assert.equal(lengthMismatch.matched, false);
  assert.match(lengthMismatch.reason, /长度规格不符/);

  const threadMismatch = ali.matchSpec({query: 'M6*15', title: '304不锈钢内六角螺丝', spec: 'M10*15'});
  assert.equal(threadMismatch.matched, false);
  assert.match(threadMismatch.reason, /螺纹规格不符/);

  const headConflict = ali.matchSpec({query: '内六角法兰面 M6*15', title: '十字盘头螺丝', spec: 'M6*15'});
  assert.equal(headConflict.matched, false);
  assert.match(headConflict.reason, /头型不符/);
});

test('真实 fixture：M6*15 关键词与 609759622174 的 M10*40-1套 必须判不匹配', () => {
  // 关键词来自 2026-11-04 的真实搜索（live-search.json 现在记录后续一次不同关键词的采集，
  // 所以这里固定当时的关键词，避免 fixture 覆盖后断言失去意义）。
  const keyword = '内六角法兰盘螺丝 M6*15';
  const offer = readJson('live-offer-609759622174.json');
  const sku = offer.offers.find(item => item.props === 'M10*40-1套');
  assert.ok(sku, 'fixture 应保留被误选的 M10*40-1套 SKU');
  const check = ali.matchSpec({query: keyword, title: offer.title, spec: sku.props});
  assert.equal(check.matched, false, `M10*40-1套 不应匹配 M6*15：${check.reason}`);
  assert.match(check.reason, /螺纹规格不符/);
  assert.match(check.reason, /长度规格不符/);
  assert.match(check.reason, /套装|组合/);
  assert.match(check.reason, /头型不符/);

  // 即便调用方硬说 specMatched=true，证据层也必须把它降级，并给出原因。
  const evidence = ali.toEvidence(
    {...sku, supplier: offer.company, title: offer.title, url: offer.url},
    {
      queriedAt: '2026-11-04',
      searchMethod: 'keyword',
      keywords: keyword,
      targetUnit: '件',
      targetUnitsPerQuoteUnit: 1,
      selectedSpec: sku.props,
      observedText: `页面价格文本 ${sku.priceText}`,
      specMatched: true,
      minOrderQty: sku.moq,
    },
  );
  assert.equal(evidence.specMatched, undefined, '规格不符时不得写 specMatched=true');
  assert.match(evidence.specMatchReason, /M6|套装|头型/);
  assert.equal(evidence.priceKind, 'bundle', '套装价不得标成 regular 单颗价');
  const issues = validatePriceEvidence(evidence, 500);
  assert.ok(issues.length > 0, '规格不符/套装价的证据必须被 validator 拒绝');
});

test('searchUrl / 常量与真实站点一致', () => {
  assert.equal(ali.HOME_URL, 'https://www.1688.com/');
  assert.equal(ali.LOGIN_URL, 'https://login.1688.com/member/signin.htm');
  // 该 legacy 端点按 GBK 解码 keywords：真机对比过 UTF-8 编码会把标题/搜索框变成
  // 「鍐呭叚瑙掓硶鍏伴潰铻轰笣」乱码，GBK 编码才显示正确中文。
  assert.equal(
    ali.searchUrl('内六角 螺丝'),
    'https://s.1688.com/selloffer/offer_search.htm?keywords=%C4%DA%C1%F9%BD%C7%20%C2%DD%CB%BF',
  );
});

test('encodeGbkComponent / GBK 编码边界', () => {
  // 纯 ASCII 与 * 保持不变，方便 M6*15 这类规格串
  assert.equal(ali.encodeGbkComponent('M6*15'), 'M6*15');
  // 空格必须转 %20（不能是 +，1688 不接受）
  assert.equal(ali.encodeGbkComponent(' '), '%20');
  // 常见五金词：内六角法兰面螺丝
  assert.equal(ali.encodeGbkComponent('内六角'), '%C4%DA%C1%F9%BD%C7');
  // 查询参数分隔符必须被转义，避免注入
  assert.equal(ali.encodeGbkComponent('a&b=c'), 'a%26b%3Dc');
  // GBK 无法表示的字符（emoji）退回 UTF-8，不能整串失败
  assert.match(ali.encodeGbkComponent('桌脚😀'), /%F0%9F%98%80$/);
});

// ---------------------------------------------------------------------------
// 离线层：live fixture 的自洽性（不访问网络，但确认真实抓取结果没被改写）
// ---------------------------------------------------------------------------

test('live 抓取结果自洽：登录态、URL、时间戳、真实价格', () => {
  const search = readJson('live-search.json');
  assert.equal(search.loggedIn, true, 'live-search.json 应为登录后的真实搜索');
  assert.equal(search.method, 'keyword');
  assert.ok(search.candidates.length > 0);
  const capturedAt = new Date(search.capturedAt);
  assert.ok(!Number.isNaN(capturedAt.getTime()));

  const offer = readJson('live-offer-609759622174.json');
  assert.ok(isOffer(offer.url));
  assert.ok(offer.title.length > 6);
  assert.ok(offer.company.length > 2);
  assert.equal(offer.unit, '件');
  assert.ok(offer.offers.length > 0);
  assert.ok(!Number.isNaN(new Date(offer.capturedAt).getTime()));
  assert.ok(offer.offers.every(item => typeof item.price === 'number' && item.price > 0));
  assert.equal(offer.source, 'window.context');
});

test('live-evidence fixtures：同规格样例通过校验，规格/套装不符的样例被拒绝', () => {
  // 真实 4寸10cm 黑色 SKU → 结构化校验通过，可直接喂 hwq_1688_average。
  const valid = readJson('live-evidence-721403962321.json');
  assert.equal(valid.validated, true, [...valid.issues].join('；'));
  assert.deepEqual(valid.issues, []);
  assert.equal(isOffer(valid.evidence.url), true);
  assert.match(valid.evidence.queriedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(valid.evidence.currency, 'CNY');
  assert.equal(valid.evidence.priceKind, 'regular');
  assert.equal(valid.evidence.searchMethod, 'keyword');
  assert.equal(valid.evidence.specMatched, true);
  assert.ok(valid.evidence.originalPrice > 0);
  assert.deepEqual(validatePriceEvidence(valid.evidence, 500), []);

  // 真实 M6*15 搜索里的「M10*40-1套」：螺纹/长度/头型/套装四项都不符，必须被拒绝。
  const bundle = readJson('live-evidence-609759622174.json');
  assert.equal(bundle.validated, false);
  assert.ok(bundle.issues.length > 0);
  assert.match(bundle.evidence.specMatchReason, /套装|螺纹规格不符/);
  assert.equal(bundle.evidence.specMatched, undefined);
  assert.equal(bundle.evidence.priceKind, 'bundle');
  assert.ok(validatePriceEvidence(bundle.evidence, 500).length > 0);

  // 真实 M6*15 规格但头型是十字/圆头（要求内六角法兰面）：尺寸对、头型不符，同样必须拒绝。
  const headMismatch = readJson('live-evidence-782671210980.json');
  assert.equal(headMismatch.validated, false);
  assert.match(headMismatch.evidence.specMatchReason, /头型不符/);
  assert.equal(headMismatch.evidence.specMatched, undefined);
  assert.ok(validatePriceEvidence(headMismatch.evidence, 500).length > 0);
});

// ---------------------------------------------------------------------------
// live 层（HWQ_LIVE=1）：真实 Chrome
// ---------------------------------------------------------------------------

test('live: ensureBrowser 复用同一个端口/profile', {skip: !LIVE}, async () => {
  const cdp = await import('../lib/cdp.mjs');
  const a = await cdp.ensureBrowser({});
  const b = await cdp.ensureBrowser({});
  assert.equal(a.port, b.port, '两次 ensureBrowser 必须复用同一调试端口');
  assert.ok(String(a.browser ?? b.browser).includes('Chrome/'), '应能从 /json/version 读到 Chrome 版本');
  assert.equal(a.userDataDir, b.userDataDir, '必须复用同一个持久 profile 目录');
  assert.equal(cdp.defaultStateDir(), a.stateDir);
});

test('live: loginStatus 返回真实登录态证据（不导出 cookie 值）', {skip: !LIVE}, async () => {
  const cdp = await import('../lib/cdp.mjs');
  const browser = await cdp.ensureBrowser({});
  const status = await ali.loginStatus();
  assert.equal(typeof status.loggedIn, 'boolean');
  assert.equal(status.port, browser.port, 'loginStatus 应复用 ensureBrowser 的调试端口');
  assert.ok(status.capturedAt && !Number.isNaN(new Date(status.capturedAt).getTime()));
  assert.ok(typeof status.evidence === 'string' && status.evidence.length > 20);
  assert.ok(!/__cn_logon__=[^;\s]/.test(status.evidence), 'evidence 不得包含 cookie 值');
  if (status.loggedIn) assert.ok(status.evidence.includes('__cn_logon__'));
});

test('live: 关键词搜索返回可校验候选（需登录）', {skip: !LIVE}, async () => {
  const result = await ali.searchOffers({keywords: '内六角法兰盘螺丝 M6*15', limit: 5});
  assert.equal(result.method, 'keyword');
  assert.ok(result.searchedAt);
  if (result.blocked) {
    assert.ok(result.screenshot || result.evidence, 'blocked 时必须给出截图或证据');
    return;
  }
  assert.ok(result.candidates.length > 0, `搜索无候选：${result.note ?? ''}`);
  for (const candidate of result.candidates) {
    assert.ok(isOffer(candidate.url), `候选 URL 必须是真实详情页：${candidate.url}`);
    assert.ok(candidate.title);
    assert.ok(candidate.capturedAt);
    assert.ok(candidate.evidence && candidate.evidence.kind);
  }
});

test('live: 规格不符的候选不会被证据层放行（真机负例）', {skip: !LIVE}, async () => {
  const result = await ali.searchOffers({keywords: '内六角法兰盘螺丝 M6*15', limit: 3});
  if (result.blocked) {
    assert.ok(result.screenshot || result.evidence);
    return;
  }
  assert.ok(result.candidates.length > 0);
  const offer = await ali.openOffer(result.candidates[0].url);
  if (offer.blocked) {
    assert.ok(offer.screenshot);
    return;
  }
  assert.ok(offer.offers.length > 0);
  const sku = offer.selectedSku ?? offer.offers[0];
  const evidence = ali.toEvidence(
    {...sku, supplier: offer.company, title: offer.title, url: offer.url},
    {
      queriedAt: new Date(offer.capturedAt).toISOString().slice(0, 10),
      searchMethod: 'keyword',
      keywords: result.keyword,
      targetUnit: offer.unit,
      targetUnitsPerQuoteUnit: 1,
      selectedSpec: sku.props,
      observedText: `在真实详情页看到 ${sku.props} 的价格文本 ${sku.priceText}，MOQ ${sku.moqText}`,
      specMatched: true,
      minOrderQty: sku.moq,
    },
  );
  // 真实站点上这个关键词的首个候选是「套装 SKU / 规格不符」时，证据必须被判不匹配；
  // 只有确实找到 M6*15 这类同规格单颗 SKU 时才允许通过。
  if (offer.selectedSku) {
    assert.deepEqual(validatePriceEvidence(evidence, 500), []);
  } else {
    assert.equal(evidence.specMatched, undefined);
    assert.ok(evidence.specMatchReason, '不匹配时必须说明原因');
    assert.ok(validatePriceEvidence(evidence, 500).length > 0, '规格不符的证据不得被 validator 放行');
  }
});

test('live: 详情抽取返回真实 SKU/阶梯价（无需登录）', {skip: !LIVE}, async () => {
  const offer = await ali.openOffer('https://detail.1688.com/offer/721403962321.html', {skuHint: '4寸10cm 黑色'});
  assert.ok(isOffer(offer.url));
  assert.equal(offer.blocked, null);
  assert.equal(offer.title, '铁艺餐桌脚茶几沙发脚三线铁线脚 家具五金配件批发三角支架桌腿');
  assert.equal(offer.company, '佛山市南海区亿长明五金厂');
  assert.equal(offer.unit, '个');
  assert.equal(offer.beginNum, 4);
  assert.equal(offer.offers.length, 19);
  assert.ok(offer.tiers.some(tier => tier.price === 5.8 && tier.beginAmount === 4));
  const selected = offer.offers.find(item => item.props === '4寸10cm > 黑色');
  assert.ok(selected);
  assert.equal(selected.price, 5.8);
  assert.equal(selected.selected, true, 'skuHint 命中时应在该 SKU 上标记 selected');
});

test.after(async () => {
  if (!LIVE) return;
  const {disconnectAll} = await import('../lib/cdp.mjs');
  disconnectAll();
});

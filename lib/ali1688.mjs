// hardware-quote · 1688 业务层（零 npm 依赖）
//
// 由本机持久 Chrome（lib/cdp.mjs）驱动：登录态复用、关键词/以图搜款、详情页抽取、
// 证据组装、验证码/登录墙识别。所有返回值都带真实 capturedAt；绝不伪造 URL/价格/日期，
// 绝不读取账号密码或导出 cookie 值，绝不绕过验证码。
//
// 数据来源优先级（搜索）：页面上下文 fetch 同源 HTML → 解析；解析不到再读可见 DOM。
// 详情页：window.context.result.data（页面内嵌 JSON）优先，DOM 文本兜底。

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ensureBrowser,
  defaultStateDir,
  openTarget,
  listTargets,
  navigate,
  evaluate,
  waitFor,
  screenshot,
  getCookies,
  closeBrowser,
  pageInfo,
  sendCommand,
} from './cdp.mjs';
import { isOffer } from './lookup.mjs';

export const HOME_URL = 'https://www.1688.com/';
export const WORK_URL = 'https://work.1688.com/';
export const LOGIN_URL = 'https://login.1688.com/member/signin.htm';
export const IMAGE_SEARCH_URL = 'https://s.1688.com/youyuan/index.htm';

// 1688 的 s.1688.com/selloffer/offer_search.htm 是 legacy 端点：它把 keywords 参数的
// 百分号字节按 GBK 解码。传 UTF-8 的 %E5%86%85… 会被解成「鍐呭叚瑙掓硶鍏伴潰…」乱码
// （真机对比验证：同一关键词 GBK 编码时页面标题正常、UTF-8 编码时标题与搜索框全乱码）。
// Node 只内置 GBK 解码器（TextDecoder），没有编码器，这里用解码器反向建表，保持零依赖。
let gbkEncodeMap = null;

const GBK_ASCII_SAFE = /[A-Za-z0-9\-_.~*]/;

function buildGbkEncodeMap() {
  const decoder = new TextDecoder('gbk', {fatal: true});
  const map = new Map();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      let text;
      try {
        text = decoder.decode(new Uint8Array([lead, trail]));
      } catch {
        continue;
      }
      if (text.length === 1 && !map.has(text)) map.set(text, [lead, trail]);
    }
  }
  return map;
}

const gbkMap = () => (gbkEncodeMap ??= buildGbkEncodeMap());

const percentByte = byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * 按 GBK 生成 1688 legacy 搜索端点可接受的百分号编码。
 * GBK 无法表示的字符（极少见生僻字/emoji）退回 UTF-8 百分号编码，避免整串失败。
 */
export function encodeGbkComponent(value) {
  const text = String(value ?? '');
  const map = gbkMap();
  const out = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) {
      out.push(GBK_ASCII_SAFE.test(char) ? char : percentByte(code));
      continue;
    }
    const pair = map.get(char);
    if (pair) {
      out.push(percentByte(pair[0]), percentByte(pair[1]));
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) out.push(percentByte(byte));
  }
  return out.join('');
}

export const searchUrl = keywords =>
  `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeGbkComponent(keywords)}`;

const OFFER_URL_RE = /^https?:\/\/detail\.1688\.com\/offer\/(\d+)\.html/i;
const CAPTCHA_PAT = /(滑块验证|拖动滑块|请完成验证|验证码|安全验证|访问验证|人机验证|访问受限)/;
const LOGIN_WALL_PAT = /(扫码登录|密码登录|请先登录|登录后查看|登录后可见|立即登录)/;
const LOGIN_HOST_PAT = /(^|\.)login\.(taobao|1688)\.com$/i;
const RESULT_ANCHOR_SELECTOR = 'a[href*="detail.1688.com/offer/"]';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();
const nowDate = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nonEmptyStringOrUndefined = value =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function stateDirOf(options = {}) {
  return options.stateDir ? path.resolve(options.stateDir) : defaultStateDir();
}

async function ensureStateDir(dir) {
  await fs.mkdir(dir, {recursive: true});
  return dir;
}

async function screenshotBlocked(port, targetId, reason, stateDir) {
  const dir = path.join(await ensureStateDir(stateDir), 'screenshots');
  await fs.mkdir(dir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `blocked-${reason}-${stamp}.png`);
  try {
    await screenshot(port, targetId, file);
    return file;
  } catch {
    return null;
  }
}

async function readPageState(port, targetId) {
  return evaluate(
    port,
    targetId,
    `(() => {
      const body = document.body;
      return {url: location.href, title: document.title, text: (body && body.innerText || '').slice(0, 8000)};
    })()`,
  );
}

/** 只根据 URL/可见文本判定登录墙/验证码；不绕过，只上报。 */
export function detectBlock(pageState = {}) {
  const url = String(pageState.url ?? '');
  const text = String(pageState.text ?? '');
  let loginHost = false;
  try {
    const parsed = new URL(url);
    // 真实的 1688 未登录跳转会落到 login.taobao.com/member/login.jhtml，
    // 路径不是 signin.htm，所以必须按 host 判定，而不是只匹配某个路径。
    loginHost = LOGIN_HOST_PAT.test(parsed.host) || /\/member\/signin\.htm/i.test(parsed.pathname);
  } catch {
    loginHost = LOGIN_HOST_PAT.test(url);
  }
  if (loginHost) return 'login';
  if (/punish|captcha|verify/i.test(url) && !/captcha.*1688\.com\/$/.test(url)) return 'captcha';
  if (CAPTCHA_PAT.test(text)) return 'captcha';
  if (LOGIN_WALL_PAT.test(text)) return 'login';
  return null;
}

/**
 * 选择工作标签页：优先复用已打开的 1688 页面，其次 about:blank，最后新开。
 * 不会关闭或导航用户自己的其他标签页。
 */
async function pickTarget(port, preferPattern) {
  const targets = await listTargets(port);
  const preferred = preferPattern ? targets.find(target => preferPattern.test(target.url)) : null;
  if (preferred) return preferred;
  const blank = targets.find(target => target.url === 'about:blank')
    ?? targets.find(target => target.url === 'chrome://newtab/');
  if (blank) return blank;
  return openTarget(port, 'about:blank');
}

// ---------------------------------------------------------------------------
// 纯解析函数（离线单测覆盖）
// ---------------------------------------------------------------------------

const HTML_ENTITIES = {
  '&gt;': '>',
  '&lt;': '<',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function decodeHtmlText(value) {
  return String(value ?? '')
    .replace(/&(gt|lt|amp|quot|apos|nbsp);/g, match => HTML_ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripTags(html) {
  return decodeHtmlText(String(html ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '));
}

/** 从任意候选文字里解析价格/单位/MOQ/销量，解析不到就留空（不猜）。 */
export function parseCardText(text) {
  const raw = decodeHtmlText(text);
  const out = {priceText: null, price: null, unitText: null, moqText: null, soldText: null};
  // 页面把价格拆成多个 span，innerText 会变成 "¥ 0 . 25"：允许数字/小数点两侧有空白。
  const money = raw.match(/[¥￥]\s*([\d,]+(?:\s*\.\s*\d+)?)/);
  if (money) {
    const normalized = money[1].replace(/,/g, '').replace(/\s+/g, '');
    out.priceText = `¥${normalized}`;
    const price = Number(normalized);
    if (Number.isFinite(price)) out.price = price;
  }
  const unitWithSlash = raw.match(/[¥￥]\s*[\d,]+(?:\s*\.\s*\d+)?\s*\/\s*([\u4e00-\u9fa5A-Za-z]{1,4})/);
  if (unitWithSlash) out.unitText = unitWithSlash[1];
  const moq = raw.match(/(\d+)\s*(个|件|套|只|副|对|条|米|公斤|千克|kg|包|箱|支|片|张|卷|袋|桶|盒|台|把|双)\s*起批/i)
    ?? raw.match(/起批\s*[:：]?\s*(\d+)\s*(个|件|套|只|副|对|条|米|公斤|千克|kg|包|箱|支|片|张|卷|袋|桶|盒|台|把|双)?/i);
  if (moq) {
    out.moqText = moq[1] + (moq[2] ?? '');
  }
  const sold = raw.match(/(?:月销|已售|累计销量|成交|销量)\s*[:：]?\s*([\d.]+万?\+?)/)
    ?? raw.match(/全网\s*([\d.]+万?\+?)\s*件/);
  if (sold) out.soldText = sold[1];
  return out;
}

const COMPANY_PAT = /([\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,40}(?:有限公司|有限责任公司|厂|商行|经营部|合作社|店铺|商行))/;

export function parseCompanyFromText(text) {
  const match = decodeHtmlText(text).match(COMPANY_PAT);
  return match ? match[1] : null;
}

/** 解析一张搜索结果卡片的文本（DOM 路径与离线测试共用）。 */
export function parseSearchCard(card = {}) {
  const urlMatch = String(card.url ?? '').match(/detail\.1688\.com\/offer\/(\d+)\.html/i);
  if (!urlMatch) return null;
  const text = decodeHtmlText(card.text ?? '');
  const titleFromHtml = decodeHtmlText(card.title ?? '');
  const title = titleFromHtml || text.slice(0, 120);
  if (!title) return null;
  const parsed = parseCardText(text || title);
  const company = decodeHtmlText(card.company ?? '') || parseCompanyFromText(text);
  return {
    url: `https://detail.1688.com/offer/${urlMatch[1]}.html`,
    title,
    priceText: parsed.priceText,
    price: parsed.price,
    unitText: parsed.unitText,
    moqText: parsed.moqText,
    company: company || null,
    soldText: parsed.soldText,
    snippet: text.slice(0, 240),
  };
}

function mergeCandidates(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const previous = seen.get(candidate.url);
    if (!previous) {
      seen.set(candidate.url, candidate);
      continue;
    }
    for (const key of ['title', 'priceText', 'price', 'unitText', 'moqText', 'company', 'soldText']) {
      if (previous[key] == null && candidate[key] != null) previous[key] = candidate[key];
    }
    if (!previous.snippet && candidate.snippet) previous.snippet = candidate.snippet;
  }
  return [...seen.values()];
}

/** 在 HTML 中提取 `= { ... }` 形式的 JSON 赋值的对象（括号配平，容忍字符串里的括号）。 */
function extractJsonAssignment(html, marker) {
  const index = html.indexOf(marker);
  if (index < 0) return null;
  const brace = html.indexOf('{', index + marker.length);
  if (brace < 0) return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(brace, i + 1);
    }
  }
  return null;
}

function looksLikeOfferRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasId = value.offerId != null || value.offer_id != null;
  const hasUrl = typeof value.detailUrl === 'string' || typeof value.url === 'string' || typeof value.offerUrl === 'string';
  const hasTitle = typeof value.title === 'string' || typeof value.subject === 'string' || typeof value.offerTitle === 'string';
  return (hasId || hasUrl) && hasTitle;
}

function walkOfferRecords(node, out, depth = 0) {
  if (node == null || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) walkOfferRecords(item, out, depth + 1);
    return;
  }
  if (looksLikeOfferRecord(node)) {
    out.push(node);
    return;
  }
  for (const value of Object.values(node)) walkOfferRecords(value, out, depth + 1);
}

function candidateFromJsonRecord(record) {
  const offerId = record.offerId ?? record.offer_id ?? record.id;
  let url = null;
  const rawUrl = record.detailUrl ?? record.url ?? record.offerUrl ?? '';
  const urlMatch = String(rawUrl).match(/detail\.1688\.com\/offer\/(\d+)\.html/i);
  if (urlMatch) url = `https://detail.1688.com/offer/${urlMatch[1]}.html`;
  else if (offerId != null && /^\d+$/.test(String(offerId))) url = `https://detail.1688.com/offer/${offerId}.html`;
  if (!url) return null;
  const title = decodeHtmlText(record.title ?? record.subject ?? record.offerTitle ?? '');
  if (!title) return null;
  const priceSource = record.price ?? record.priceText ?? record.showPrice ?? record.discountPrice;
  let price = null;
  let priceText = null;
  if (typeof priceSource === 'number' && Number.isFinite(priceSource) && priceSource > 0) {
    price = priceSource;
    priceText = `¥${priceSource}`;
  } else if (typeof priceSource === 'string') {
    const money = priceSource.match(/[¥￥]?\s*([\d,]+(?:\.\d+)?)/);
    if (money) {
      priceText = `¥${money[1].replace(/,/g, '')}`;
      const num = Number(money[1].replace(/,/g, ''));
      if (Number.isFinite(num) && num > 0) price = num;
    }
  }
  const unitText = decodeHtmlText(record.unit ?? record.saleUnit ?? record.priceUnit ?? '') || null;
  const company = decodeHtmlText(record.companyName ?? record.company ?? record.shopName ?? record.sellerName ?? '') || null;
  const moqRaw = record.beginAmount ?? record.beginNum ?? record.moq ?? record.minOrderQuantity;
  const moqText = moqRaw != null && `${moqRaw}` !== '' ? `${moqRaw}${unitText ?? ''}` : null;
  const soldRaw = record.saledCount ?? record.saleCount ?? record.sold ?? record.tradeCount;
  const soldText = soldRaw != null && `${soldRaw}` !== '' ? String(soldRaw) : null;
  return {
    url,
    title,
    priceText,
    price,
    unitText,
    moqText,
    company,
    soldText,
    snippet: JSON.stringify(record).slice(0, 240),
  };
}

const JSON_MARKERS = [
  'window.__INIT_DATA__',
  'window.__page_data__',
  'window.__SEARCH_DATA__',
  'window.__INITIAL_STATE__',
  'window.__NEXT_DATA__',
  'window.__PRELOADED_STATE__',
];

/**
 * 解析搜索页 HTML（页面上下文 fetch 到的那份）：
 * 先尝试内嵌 JSON（__INIT_DATA__ 等），再退到 `<a href="detail...">` + 邻近文本。
 */
export function parseSearchHtml(html) {
  const source = String(html ?? '');
  const candidates = [];
  const notes = [];
  for (const marker of JSON_MARKERS) {
    const raw = extractJsonAssignment(source, marker);
    if (!raw) continue;
    try {
      const json = JSON.parse(raw);
      const records = [];
      walkOfferRecords(json, records);
      for (const record of records) {
        const candidate = candidateFromJsonRecord(record);
        if (candidate) candidates.push(candidate);
      }
      if (records.length) notes.push(`${marker} 内嵌 JSON 命中 ${records.length} 条商品记录`);
    } catch {
      notes.push(`${marker} JSON 解析失败`);
    }
  }

  const anchorRe = /<a\b[^>]*href=["']([^"']*?detail\.1688\.com\/offer\/(\d+)\.html[^"']*)["'][^>]*>/gi;
  const anchorHits = [];
  let match;
  while ((match = anchorRe.exec(source)) !== null) {
    anchorHits.push({index: match.index, url: `https://detail.1688.com/offer/${match[2]}.html`, tag: match[0]});
  }
  for (const hit of anchorHits) {
    const before = source.slice(Math.max(0, hit.index - 900), hit.index + 1400);
    const titleAttr = hit.tag.match(/title=["']([^"']+)/i);
    const innerEnd = source.indexOf('</a>', hit.index);
    const inner = innerEnd >= 0 ? source.slice(hit.index, innerEnd) : '';
    const title = decodeHtmlText(titleAttr?.[1] ?? '') || stripTags(inner).slice(0, 200);
    if (!title) continue;
    const parsed = parseCardText(before);
    const company = parseCompanyFromText(before);
    candidates.push({
      url: hit.url,
      title,
      priceText: parsed.priceText,
      price: parsed.price,
      unitText: parsed.unitText,
      moqText: parsed.moqText,
      company: company || null,
      soldText: parsed.soldText,
      snippet: decodeHtmlText(stripTags(before)).slice(-240),
    });
  }
  const deduped = mergeCandidates(candidates);
  if (anchorHits.length) notes.push(`HTML 页面命中 ${anchorHits.length} 个详情链接`);
  if (!deduped.length) notes.push('未从 HTML 解析出候选（页面可能是 JS 壳或被重定向）');
  return {candidates: deduped, notes, urlCount: anchorHits.length};
}

/** 解析一组 DOM 卡片（由页面上下文采集的 {url,title,text,company}）。 */
export function parseSearchCards(cards) {
  const candidates = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const candidate = parseSearchCard(card);
    if (candidate) candidates.push(candidate);
  }
  return {candidates: mergeCandidates(candidates), notes: candidates.length ? [`DOM 可见商品卡片 ${candidates.length} 个`] : ['DOM 中未看到商品卡片']};
}

/** 从 window.context.result.data 抽取详情（纯函数，离线测试用真实页面数据）。 */
export function extractOfferFromContext(data) {
  const root = data?.Root?.fields?.dataJson ?? null;
  const out = {
    contextFound: Boolean(root),
    title: decodeHtmlText(data?.productTitle?.fields?.title ?? data?.gallery?.fields?.subject ?? ''),
    company: '',
    unit: '',
    saleNum: '',
    beginNum: null,
    tiers: [],
    props: [],
    offers: [],
    domNotes: [],
  };
  if (!root) {
    out.domNotes.push('window.context.result.data.Root.fields.dataJson 不可读');
    return out;
  }
  const shop = data?.productTitle?.fields?.shopInfo ?? {};
  out.company = decodeHtmlText(shop.companyName ?? shop.authCompanyName ?? root.tempModel?.companyName ?? '');
  out.unit = decodeHtmlText(data?.productTitle?.fields?.unit ?? data?.mainPrice?.fields?.unit ?? '');
  const order = root.orderParamModel?.orderParam ?? {};
  out.saleNum = String(data?.productTitle?.fields?.saleNum ?? order.saledCount ?? '');
  out.beginNum = Number.isFinite(Number(order.beginNum)) ? Number(order.beginNum) : null;

  const skuModel = root.skuModel ?? {};
  for (const prop of Array.isArray(skuModel.skuProps) ? skuModel.skuProps : []) {
    out.props.push({fid: prop.fid, prop: decodeHtmlText(prop.prop), values: (prop.value ?? []).map(item => decodeHtmlText(item.name))});
  }

  const priceModel = data?.mainPrice?.fields?.priceModel ?? {};
  for (const tier of Array.isArray(priceModel.currentPrices) ? priceModel.currentPrices : []) {
    const price = Number(tier.price);
    if (!Number.isFinite(price)) continue;
    out.tiers.push({
      price,
      priceText: `¥${tier.price}`,
      beginAmount: Number.isFinite(Number(tier.beginAmount)) ? Number(tier.beginAmount) : null,
    });
  }

  const skuInfoMap = skuModel.skuInfoMap ?? skuModel.skuInfoMapOriginal ?? {};
  const unit = out.unit;
  for (const [key, value] of Object.entries(skuInfoMap)) {
    const props = decodeHtmlText(key).replace(/\s*>\s*/g, ' > ');
    const priceValue = value?.discountPrice ?? value?.price;
    const price = Number(priceValue);
    const original = Number(value?.price);
    const moq = Number.isFinite(Number(order.beginNum)) ? Number(order.beginNum) : null;
    out.offers.push({
      skuId: String(value?.skuId ?? value?.specId ?? key),
      specId: value?.specId != null ? String(value.specId) : null,
      props,
      priceText: Number.isFinite(price) ? `¥${priceValue}` : null,
      price: Number.isFinite(price) ? price : null,
      priceOriginal: Number.isFinite(original) ? original : null,
      unit: unit || null,
      moqText: moq != null ? `≥${moq}${unit || ''}` : null,
      moq,
      canBookCount: Number.isFinite(Number(value?.canBookCount)) ? Number(value.canBookCount) : null,
      saleCount: Number.isFinite(Number(value?.saleCount)) ? Number(value.saleCount) : null,
    });
  }
  out.domNotes.push(
    `window.context 可读：SKU 属性 ${out.props.length} 组、SKU 明细 ${out.offers.length} 条、价格档位 ${out.tiers.length} 条`,
  );
  return out;
}

/** 从详情页 DOM 文本兜底解析（window.context 不可用时；只取可见文字，不猜价格）。 */
export function extractOfferFromDom({titleText = '', companyText = '', text = '', skuTexts = []} = {}) {
  const body = decodeHtmlText(text);
  const parsed = parseCardText(body);
  const company = decodeHtmlText(companyText) || parseCompanyFromText(body);
  const offers = [];
  for (const skuText of Array.isArray(skuTexts) ? skuTexts : []) {
    const label = decodeHtmlText(skuText);
    if (!label) continue;
    offers.push({
      skuId: null,
      specId: null,
      props: label.slice(0, 120),
      priceText: parsed.priceText,
      price: null,
      priceOriginal: null,
      unit: parsed.unitText,
      moqText: parsed.moqText,
      moq: null,
      canBookCount: null,
      saleCount: null,
    });
  }
  return {
    contextFound: false,
    title: decodeHtmlText(titleText) || stripTags(body).slice(0, 120),
    company,
    unit: parsed.unitText ?? '',
    saleNum: '',
    beginNum: null,
    tiers: [],
    props: [],
    offers,
    domNotes: ['window.context 不可用，已退回可见 DOM 文本'],
  };
}

/** 关键词与候选的匹配提示（不做语义猜测，只统计命中的词元与中文双字片段）。 */
export function matchHint(keywords, candidate = {}) {
  const tokens = String(keywords ?? '')
    .split(/[\s,，;；/]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
  if (!tokens.length) return {matched: 0, total: 0, partial: 0, hint: null};
  const haystack = `${candidate.title ?? ''} ${candidate.props ?? ''} ${candidate.snippet ?? ''}`.toLowerCase();
  const normalizedHaystack = haystack.replace(/[×*]/g, 'x').replace(/\s+/g, '');
  let matched = 0;
  let partial = 0;
  for (const token of tokens) {
    const needle = token.toLowerCase().replace(/[×*]/g, 'x');
    if (normalizedHaystack.includes(needle.replace(/\s+/g, ''))) {
      matched += 1;
      partial += 1;
      continue;
    }
    // 整词未命中时，用中文双字片段判断「部分相关」，仅用于排序，不作为规格匹配依据。
    const compact = needle.replace(/\s+/g, '');
    let hit = false;
    for (let i = 0; i + 2 <= compact.length && !hit; i += 1) {
      const bigram = compact.slice(i, i + 2);
      if (/^[0-9a-z]/i.test(bigram)) continue;
      if (normalizedHaystack.includes(bigram)) hit = true;
    }
    if (hit) partial += 1;
  }
  return {matched, total: tokens.length, partial, hint: `匹配关键词 ${matched}/${tokens.length}（部分词元命中 ${partial}/${tokens.length}）`};
}

// ---------------------------------------------------------------------------
// 规格匹配（螺纹 / 长度 / 头型 / 套装）——决定一条证据能不能用
// ---------------------------------------------------------------------------

// family=drive 是传动/驱动方式，family=shape 是头部形状；同一 family 内要求与候选不一致即冲突。
const SPEC_HEAD_WORDS = [
  {name: '内六角', family: 'drive', pattern: /内六角/},
  {name: '外六角', family: 'drive', pattern: /外六角/},
  {name: '十字', family: 'drive', pattern: /十字/},
  {name: '一字', family: 'drive', pattern: /一字/},
  {name: '梅花', family: 'drive', pattern: /梅花/},
  {name: '法兰面', family: 'shape', pattern: /法兰面|法兰盘|法兰/},
  {name: '沉头', family: 'shape', pattern: /沉头/},
  {name: '平头', family: 'shape', pattern: /平头|大扁头/},
  {name: '圆头', family: 'shape', pattern: /圆头|半圆头/},
  {name: '盘头', family: 'shape', pattern: /盘头/},
];

// 「套」类字样说明标价可能是整包/整套，不能当单颗价。
const SPEC_BUNDLE_PAT = /套装|套件|成套|组合|大全|配螺母|含螺母|一套|\d+\s*套/;

// 只有标题本身是紧固件时，标题里的 M6 才当螺纹规格；否则「问界M6」「哈弗m6plus」会被误判。
const FASTENER_PAT = /螺丝|螺母|螺钉|螺栓|螺柱|机丝|丝攻|丝锥|紧固件|紧固/;

/** 从任意文本里抽结构化规格 token：螺纹（M6）、长度（*15/×15/x15）、头型、套装。 */
export function parseSpecTokens(input) {
  const text = String(input ?? '');
  const threads = [];
  const lengths = [];
  const heads = [];
  // 螺纹 token 后面不能紧跟字母：M6PLUS 是车型，不是 M6 螺纹。
  for (const match of text.matchAll(/(?<![A-Za-z0-9])[Mm]\s*(\d+(?:\.\d+)?)(?![\d.A-Za-z])/g)) {
    const token = `M${match[1]}`;
    if (!threads.includes(token)) threads.push(token);
  }
  for (const match of text.matchAll(/[*×xX]\s*(\d+(?:\.\d+)?)(?![\d.])/g)) {
    const token = match[1];
    if (!lengths.includes(token)) lengths.push(token);
  }
  for (const word of SPEC_HEAD_WORDS) {
    if (word.pattern.test(text) && !heads.some(head => head.name === word.name)) {
      heads.push({name: word.name, family: word.family});
    }
  }
  return {threads, lengths, heads, bundle: SPEC_BUNDLE_PAT.test(text), text};
}

/** 文本是否像套装/组合件（套装、组合、配螺母、1套……）。 */
export function isBundleText(input) {
  return SPEC_BUNDLE_PAT.test(String(input ?? ''));
}

/**
 * 结构化规格匹配：用需求文本（关键词/skuHint）核对候选的规格属性与标题。
 * 螺纹、长度必须命中；头型同 family 内不一致算冲突；套装候选在需求未要套装时不算匹配。
 * 返回 {matched, reason, query, candidate}；matched=false 时 reason 说明哪一项不符。
 */
export function matchSpec({query, title = '', spec = ''} = {}) {
  const queryTokens = parseSpecTokens(query);
  const parsedTitle = parseSpecTokens(title);
  // 标题不是紧固件时，标题里的 M6 是车型/型号，不是螺纹；此时标题不提供任何规格 token。
  const titleTokens = FASTENER_PAT.test(String(title ?? ''))
    ? parsedTitle
    : {threads: [], lengths: [], heads: [], bundle: parsedTitle.bundle, text: parsedTitle.text};
  const specTokens = parseSpecTokens(spec);
  // SKU 规格属性比标题精确：规格里标了螺纹/长度就以规格为准，
  // 避免被标题的全尺寸清单（如 MM2M3M4M5M6-M16）误判为匹配。
  const hasSpecNumbers = specTokens.threads.length > 0 || specTokens.lengths.length > 0;
  const candidate = {
    threads: hasSpecNumbers ? specTokens.threads : titleTokens.threads,
    lengths: hasSpecNumbers ? specTokens.lengths : titleTokens.lengths,
    heads: [...specTokens.heads, ...titleTokens.heads.filter(head => !specTokens.heads.some(existing => existing.family === head.family && existing.name === head.name))],
    bundle: specTokens.bundle || titleTokens.bundle,
  };
  const reasons = [];
  if (candidate.bundle && !queryTokens.bundle) {
    reasons.push('套装/组合件价格，不能当单颗价');
  }
  const missingThreads = queryTokens.threads.filter(thread => !candidate.threads.includes(thread));
  if (missingThreads.length) {
    reasons.push(
      `螺纹规格不符：要求 ${queryTokens.threads.join('、')}，候选${candidate.threads.length ? `为 ${candidate.threads.join('、')}` : '未标注螺纹'}`,
    );
  }
  const missingLengths = queryTokens.lengths.filter(length => !candidate.lengths.includes(length));
  if (missingLengths.length) {
    reasons.push(
      `长度规格不符：要求 ${queryTokens.lengths.join('、')}，候选${candidate.lengths.length ? `为 ${candidate.lengths.join('、')}` : '未标注长度'}`,
    );
  }
  const headConflicts = [];
  for (const queryHead of queryTokens.heads) {
    const sameFamily = candidate.heads.filter(head => head.family === queryHead.family);
    if (sameFamily.length && !sameFamily.some(head => head.name === queryHead.name)) {
      headConflicts.push(`要求${queryHead.name}，候选为${sameFamily.map(head => head.name).join('/')}`);
    }
  }
  if (headConflicts.length) reasons.push(`头型不符：${headConflicts.join('；')}`);
  return {
    matched: reasons.length === 0,
    reason: reasons.join('；'),
    query: queryTokens,
    candidate,
  };
}

// ---------------------------------------------------------------------------
// 证据组装（旧版 14 字段 + lookup.mjs validator 字段）
// ---------------------------------------------------------------------------

/**
 * 旧版证据字段（14 项）：detailUrl/supplier/title/capturedAt/method/keywordOrImage/
 * domObservation/sku/specMatch/originalPrice/originalUnit/targetUnit/unitsPerOriginalUnit/moq。
 * 只写实际看到的字段；缺失即留空，不猜测。
 */
export function collectEvidence({
  offer = {},
  candidate = null,
  sku = null,
  targetUnit = '',
  unitsPerOriginalUnit = null,
  method = 'keyword_search+offer_detail',
  keywordOrImage = null,
  capturedAt = nowIso(),
  domObservation = null,
} = {}) {
  const price = sku?.price ?? offer?.tiers?.[0]?.price ?? null;
  const originalPriceText = sku?.priceText ?? offer?.tiers?.[0]?.priceText ?? candidate?.priceText ?? null;
  const moq = sku?.moq ?? offer?.beginNum ?? null;
  const domNotes = offer?.domNotes;
  const domNotesText = Array.isArray(domNotes)
    ? domNotes.filter(Boolean).join('；')
    : typeof domNotes === 'string' && domNotes.trim()
      ? domNotes.trim()
      : null;
  const domObservationText = [
    domObservation,
    domNotesText,
    originalPriceText ? `页面价格文本 ${originalPriceText}` : null,
  ]
    .filter(Boolean)
    .join('；');
  return {
    detailUrl: offer?.url ?? candidate?.url ?? null,
    supplier: offer?.company ?? candidate?.company ?? null,
    title: offer?.title ?? candidate?.title ?? null,
    capturedAt,
    method,
    keywordOrImage,
    domObservation: domObservationText || null,
    sku: sku?.props ?? sku?.propsText ?? null,
    specMatch: sku?.selected === true ? true : null,
    originalPrice: Number.isFinite(price) ? price : null,
    originalUnit: sku?.unit ?? offer?.unit ?? null,
    targetUnit: targetUnit || null,
    unitsPerOriginalUnit: Number.isFinite(unitsPerOriginalUnit) ? unitsPerOriginalUnit : null,
    moq: moq != null ? moq : null,
  };
}

/**
 * 映射成 lib/lookup.mjs validatePriceEvidence 要求的字段名，供 hwq_1688_average 直接消费。
 * 映射不准的字段留空（undefined），交给 validator 报问题，绝不猜测。
 */
export function toEvidence(input = {}, options = {}) {
  const {
    queriedAt = nowDate(),
    searchMethod = 'keyword',
    keywords,
    inputImage,
    targetUnit,
    targetUnitsPerQuoteUnit,
    selectedSpec,
    observedText,
    specMatched,
    evidenceKind = 'visible_dom',
    minOrderQty,
    tierMinQty,
    tierMaxQty,
    comparisonKey,
    priceBasis,
  } = options;
  const url = input.url ?? input.detailUrl ?? null;
  const originalPrice = Number.isFinite(Number(input.price))
    ? Number(input.price)
    : Number.isFinite(Number(input.originalPrice))
      ? Number(input.originalPrice)
      : null;
  const specText = selectedSpec ?? input.props ?? input.sku ?? null;
  const queryText = [options.skuHint, input.skuHint, keywords, input.query]
    .filter(value => typeof value === 'string' && value.trim())
    .join(' ')
    .trim();
  const claimsMatched = specMatched === true || (specMatched === undefined && input.selected === true);
  // 证据层的硬门槛：调用方说「匹配」不算数，必须由结构化规格校验复核通过。
  const specCheck = claimsMatched && queryText && specText
    ? matchSpec({query: queryText, title: input.title ?? '', spec: specText})
    : null;
  const specVerified = specCheck?.matched === true;
  const bundle = isBundleText(specText) || isBundleText(input.title);
  const evidence = {
    url,
    supplier: input.supplier ?? input.company ?? null,
    title: input.title ?? null,
    selectedSpec: selectedSpec ?? input.props ?? input.sku ?? null,
    quoteUnit: input.unit ?? input.originalUnit ?? null,
    targetUnit: targetUnit ?? null,
    observedText: observedText ?? null,
    queriedAt,
    evidenceKind,
    searchMethod,
    keywords: searchMethod === 'keyword' ? keywords ?? null : undefined,
    inputImage: searchMethod === 'image' ? inputImage ?? null : undefined,
    // 只有结构化校验通过才写 specMatched=true；套装价或规格不符宁可不给匹配标记。
    specMatched: claimsMatched && specVerified ? true : undefined,
    specMatchReason: specCheck && !specVerified ? specCheck.reason : undefined,
    currency: 'CNY',
    priceKind: bundle ? 'bundle' : 'regular',
    priceKindNote: bundle ? '套装/组合件价格，不能当单颗价' : undefined,
    originalPrice,
    targetUnitsPerQuoteUnit: Number.isFinite(Number(targetUnitsPerQuoteUnit)) ? Number(targetUnitsPerQuoteUnit) : null,
    minOrderQty: Number.isFinite(Number(minOrderQty)) ? Number(minOrderQty) : undefined,
    tierMinQty: Number.isFinite(Number(tierMinQty)) ? Number(tierMinQty) : undefined,
    tierMaxQty: Number.isFinite(Number(tierMaxQty)) ? Number(tierMaxQty) : undefined,
    // 均价样本口径（hwq_1688_average 要求样本自带这三项）；未提供就不写，不猜。
    comparisonKey: nonEmptyStringOrUndefined(comparisonKey),
    priceBasis: nonEmptyStringOrUndefined(priceBasis),
  };
  for (const key of Object.keys(evidence)) {
    if (evidence[key] === undefined) delete evidence[key];
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// 登录态
// ---------------------------------------------------------------------------

const LOGIN_PROBE_JS = `(() => {
  const text = (document.body && document.body.innerText || '').slice(0, 6000);
  const nickEl = document.querySelector(
    '.site-nav-login-info-nick, .member-nick, [class*="login-info-nick"], .site-nav-user-info .nick, a[href*="work.1688.com"][class*="nick"]'
  );
  const memberName = nickEl ? nickEl.textContent.trim() : '';
  const hasLogout = /退出登录/.test(text);
  const loginEntry = !!document.querySelector('a[href*="login.1688.com"], a[href*="login.taobao.com"], .site-nav-login a')
    || /登录开启|立即登录|免费注册/.test(text);
  return {
    url: location.href,
    title: document.title,
    memberName,
    hasLogout,
    loginEntry,
    hasAvatar: !!document.querySelector('.site-nav-login-info img, [class*="avatar"]'),
    textSample: text.slice(0, 400),
  };
})()`;

async function readCookiesSafe(port, targetId) {
  try {
    const cookies = await getCookies(port, targetId);
    return Array.isArray(cookies) ? cookies : [];
  } catch {
    return [];
  }
}

function cookieSignal(cookies) {
  const is1688Host = cookie => /(^|\.)1688\.com$/i.test(String(cookie.domain ?? '').replace(/^\./, '.'));
  const relevant = cookies.filter(cookie => is1688Host(cookie));
  const names = [...new Set(relevant.map(cookie => cookie.name))];
  const logon = relevant.find(cookie => cookie.name === '__cn_logon__');
  const logonTrue = logon ? String(logon.value).toLowerCase() === 'true' : false;
  const hasLogonId = names.includes('__cn_logon_id__');
  const hasNk = names.includes('_nk_');
  return {names, logonTrue, hasLogonId, hasNk, total: relevant.length};
}

/**
 * 检测 1688 登录态：打开首页，读可见 DOM 特征 + 1688 域 cookie 名称/登录标记。
 * 只返回结论与证据文字，绝不返回 cookie 值。
 */
export async function loginStatus(options = {}) {
  const stateDir = stateDirOf(options);
  const capturedAt = nowIso();
  let browser;
  try {
    browser = await ensureBrowser({stateDir, port: options.port, timeoutMs: options.timeoutMs});
  } catch (error) {
    return {loggedIn: false, evidence: `无法启动本机 Chrome：${error?.message ?? error}`, capturedAt, port: options.port ?? null};
  }
  let target = null;
  try {
    target = await pickTarget(browser.port, /(^https?:\/\/)(www|work)\.1688\.com\//);
    await navigate(browser.port, target.targetId, HOME_URL, {timeout: 30000});
  } catch (error) {
    return {
      loggedIn: false,
      evidence: `打开 ${HOME_URL} 失败：${error?.message ?? error}`,
      capturedAt,
      port: browser.port,
    };
  }
  let probe = null;
  try {
    probe = await evaluate(browser.port, target.targetId, LOGIN_PROBE_JS);
  } catch {
    probe = null;
  }
  const cookies = await readCookiesSafe(browser.port, target.targetId);
  const signal = cookieSignal(cookies);
  const memberName = typeof probe?.memberName === 'string' ? probe.memberName : '';
  const domLoggedIn = Boolean(memberName) && probe?.loginEntry !== true;
  const loggedIn = signal.logonTrue || domLoggedIn || (signal.hasLogonId && probe?.loginEntry !== true && signal.hasNk);
  const signals = [];
  if (signal.logonTrue) signals.push('cookie __cn_logon__ 标记已登录');
  else if (signal.names.includes('__cn_logon__')) signals.push('cookie __cn_logon__ 存在但未标记登录');
  if (signal.hasLogonId) signals.push('存在 __cn_logon_id__');
  if (signal.hasNk) signals.push('存在 _nk_');
  signals.push(`1688 域 cookie ${signal.total} 个（名称：${signal.names.slice(0, 12).join(',') || '无'}；不读取值）`);
  signals.push(memberName ? `页面显示会员名「${memberName}」` : '页面未显示会员名');
  signals.push(probe?.loginEntry ? '页面显示登录入口（登录/立即登录）' : '页面未显示登录入口');
  signals.push(probe?.hasAvatar ? '页面显示用户头像' : '页面未显示用户头像');
  return {
    loggedIn,
    ...(loggedIn && memberName ? {memberName} : {}),
    evidence: `${probe?.url ?? HOME_URL}：${signals.join('；')}`,
    capturedAt,
    port: browser.port,
  };
}

/** 打开 1688 登录页（扫码由用户在窗口内完成；不读/存账号密码）。 */
export async function openLoginPage(options = {}) {
  const stateDir = stateDirOf(options);
  const capturedAt = nowIso();
  const browser = await ensureBrowser({stateDir, port: options.port, timeoutMs: options.timeoutMs});
  const target = await openTarget(browser.port, LOGIN_URL);
  try {
    await waitFor(
      browser.port,
      target.targetId,
      `Boolean(document.body && /扫码登录|密码登录|登录/.test(document.body.innerText))`,
      {timeout: 20000, interval: 400},
    );
  } catch {
    // 页面可能自行跳转，下面统一读最终 URL。
  }
  const info = await pageInfo(browser.port, target.targetId).catch(() => ({url: LOGIN_URL, title: ''}));
  return {
    url: info.url || LOGIN_URL,
    title: info.title || null,
    port: browser.port,
    opened: true,
    capturedAt,
    note: '已在该 Chrome 窗口打开 1688 登录页，请用 1688 App 扫码登录；插件不会读取账号密码，也不会导出 cookie 值。登录完成后调用 loginStatus 复核。',
  };
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

const SEARCH_DOM_JS = `(() => {
  const pickCard = anchor => {
    let el = anchor;
    for (let i = 0; i < 8 && el; i += 1, el = el.parentElement) {
      const text = el.innerText || '';
      if (text.length > 1200) break;
      if (/[¥￥]/.test(text) && text.length > 30) return el;
    }
    return anchor.parentElement;
  };
  const anchors = Array.from(document.querySelectorAll('a[href*="detail.1688.com/offer/"]'));
  const seen = new Set();
  const cards = [];
  for (const anchor of anchors) {
    let href;
    try {
      href = new URL(anchor.getAttribute('href'), location.href).href;
    } catch {
      continue;
    }
    const match = href.match(/detail\\.1688\\.com\\/offer\\/(\\d+)\\.html/);
    if (!match) continue;
    const url = 'https://detail.1688.com/offer/' + match[1] + '.html';
    if (seen.has(url)) continue;
    seen.add(url);
    const card = pickCard(anchor);
    const img = card && card.querySelector('img');
    const cardText = (card && card.innerText) || '';
    const lines = cardText.split(/\\n+/).map(line => line.trim()).filter(Boolean);
    const looksLikeTitle = line => line.length >= 6
      && line.length <= 160
      && !/[¥￥]/.test(line)
      && !/(不满足|运费|回头率|退货|包邮|先采后付|人付款|好评率|件$|^\\d+(\\.\\d+)?$)/.test(line);
    const titleFromCard = lines.find(looksLikeTitle) || '';
    const title = (
      anchor.getAttribute('title')
      || (img && img.getAttribute('alt'))
      || titleFromCard
      || anchor.innerText
      || ''
    ).trim().replace(/\\s+/g, ' ').slice(0, 220);
    const companyEl = card && card.querySelector('[class*="company"], [class*="shop-name"], a[href*="shop.1688.com"], a[href*="winport"]');
    const company = companyEl ? (companyEl.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90) : '';
    cards.push({
      url,
      title,
      company,
      text: (card && card.innerText || '').trim().slice(0, 700),
    });
    if (cards.length >= 80) break;
  }
  return {
    url: location.href,
    title: document.title,
    bodySample: (document.body && document.body.innerText || '').slice(0, 1200),
    cards,
  };
})()`;

const FETCH_SAME_ORIGIN_JS = `(async () => {
  try {
    const response = await fetch(location.href, {
      credentials: 'include',
      headers: {accept: 'text/html,application/xhtml+xml,application/json'},
    });
    const text = await response.text();
    return {ok: true, status: response.status, length: text.length, html: text.slice(0, 900000)};
  } catch (error) {
    return {ok: false, error: String(error && error.message || error)};
  }
})()`;

async function captureBlock({port, targetId, reason, stateDir, pageState, method, keyword, imagePath, extra = {}}) {
  const shot = await screenshotBlocked(port, targetId, reason, stateDir);
  return {
    method,
    ...(keyword ? {keyword} : {}),
    ...(imagePath ? {imagePath} : {}),
    searchedAt: nowIso(),
    candidates: [],
    rawCount: 0,
    blocked: reason,
    screenshot: shot,
    url: pageState?.url ?? null,
    evidence: `被${reason === 'login' ? '登录墙' : '验证码/安全验证'}拦截：URL=${pageState?.url ?? '未知'}；可见文字「${String(pageState?.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}」；截图 ${shot ?? '失败'}；未尝试绕过。`,
    ...extra,
  };
}

async function keywordSearch({browser, target, keywords, limit, sameSpecOnly, stateDir}) {
  const url = searchUrl(keywords);
  const port = browser.port;
  try {
    await navigate(port, target.targetId, url, {timeout: 30000});
  } catch (error) {
    return {
      method: 'keyword',
      keyword: keywords,
      searchedAt: nowIso(),
      candidates: [],
      rawCount: 0,
      note: `导航失败：${error?.message ?? error}`,
      url,
    };
  }
  // 等结果卡片出现（JS 渲染需要时间），最多 8s；同时允许登录墙/验证码提前判定。
  try {
    await waitFor(
      port,
      target.targetId,
      `Boolean(document.querySelector('${RESULT_ANCHOR_SELECTOR}')) || /验证码|滑块|安全验证/.test(document.body && document.body.innerText || '')`,
      {timeout: 8000, interval: 350},
    );
  } catch {
    // 超时后继续判定页面状态。
  }
  let pageState = await readPageState(port, target.targetId).catch(() => ({url, title: '', text: ''}));
  let blocked = detectBlock(pageState);
  if (blocked) {
    const authCheck = await evaluate(
      port,
      target.targetId,
      `({loggedIn: Boolean(document.querySelector('.site-nav-login-info-nick'))})`,
    ).catch(() => null);
    if (blocked === 'login' && authCheck?.loggedIn) blocked = null;
    if (blocked) {
      return captureBlock({port, targetId: target.targetId, reason: blocked, stateDir, pageState, method: 'keyword', keyword: keywords});
    }
  }

  // 1) 页面上下文 fetch 同源 HTML（自动带登录 cookie），解析内嵌 JSON / 详情链接。
  let fetchResult = null;
  try {
    fetchResult = await evaluate(port, target.targetId, FETCH_SAME_ORIGIN_JS, {timeout: 30000});
  } catch (error) {
    fetchResult = {ok: false, error: String(error?.message ?? error)};
  }
  let parsed = {candidates: [], notes: []};
  if (fetchResult?.ok) {
    parsed = parseSearchHtml(fetchResult.html);
    if (parsed.candidates.length) {
      parsed.notes.unshift(`页面上下文 fetch 成功（HTTP ${fetchResult.status}，${fetchResult.length} 字符）`);
    }
  } else if (fetchResult) {
    parsed.notes.push(`页面上下文 fetch 失败：${fetchResult.error}`);
  }

  // 2) 解析不到时退可见 DOM。
  let domResult = null;
  if (!parsed.candidates.length) {
    try {
      domResult = await evaluate(port, target.targetId, SEARCH_DOM_JS);
    } catch (error) {
      domResult = {cards: [], url: pageState.url, bodySample: '', note: String(error?.message ?? error)};
    }
    if (domResult?.cards?.length) {
      const domParsed = parseSearchCards(domResult.cards);
      parsed = {candidates: domParsed.candidates, notes: [...parsed.notes, ...domParsed.notes]};
      parsed.source = 'dom';
    } else {
      parsed.notes.push('可见 DOM 中也没有商品卡片');
    }
  } else {
    parsed.source = 'fetch_html';
  }

  const withEvidence = parsed.candidates.map(candidate => {
    const hint = matchHint(keywords, candidate);
    // 搜索卡片通常没有 SKU 规格，只能拿标题做「结构化初筛」；不过这一层不能替代详情页证据。
    const specCheck = matchSpec({query: keywords, title: candidate.title ?? '', spec: ''});
    return {
      ...candidate,
      specMatch: {matched: specCheck.matched, reason: specCheck.reason},
      specMatched: specCheck.matched || undefined,
      capturedAt: nowIso(),
      evidence: {
        kind: parsed.source === 'dom' ? 'dom' : 'fetch_html',
        pageUrl: pageState.url || url,
        snippet: candidate.snippet ?? '',
        note: parsed.source === 'dom' ? '来自页面可见商品卡片' : '来自页面上下文 fetch 的同源 HTML 解析',
      },
      matchHint: hint.hint,
      keywordMatched: hint.matched,
      keywordPartial: hint.partial,
    };
  });
  // 相关度高的排前面（结构化规格命中优先，其次完整词元命中，再次中文双字片段命中）。
  withEvidence.sort(
    (a, b) =>
      Number(b.specMatched === true) - Number(a.specMatched === true) ||
      b.keywordMatched - a.keywordMatched ||
      b.keywordPartial - a.keywordPartial,
  );
  const wanted = Math.max(1, Number(limit) || 5);
  let candidates = sameSpecOnly
    ? withEvidence.filter(candidate => candidate.specMatched === true && matchHint(keywords, candidate).matched > 0)
    : withEvidence;
  // sameSpecOnly 把候选全过滤掉时，给出「近似候选」让上层可以继续进详情页核对，
  // 但绝不把它们的 specMatched 当成通过（搜索卡片通常缺长度/头型，只有详情页能定案）。
  const nearMisses = sameSpecOnly && candidates.length === 0
    ? withEvidence
      .filter(candidate => candidate.specMatched !== true)
      .sort((a, b) => b.keywordMatched - a.keywordMatched || b.keywordPartial - a.keywordPartial)
      .slice(0, 3)
      .map(candidate => ({
        url: candidate.url,
        title: candidate.title ?? null,
        priceText: candidate.priceText ?? null,
        company: candidate.company ?? null,
        specMatched: false,
        specMatchReason: candidate.specMatch?.reason ?? null,
      }))
    : [];
  candidates = candidates.slice(0, wanted);

  // 搜索页通常不显示单位/MOQ，能从卡片文字读到就保留，读不到留空。
  if (!pageState.url && domResult?.url) pageState = {...pageState, url: domResult.url};
  return {
    method: 'keyword',
    keyword: keywords,
    searchedAt: nowIso(),
    candidates,
    nearMisses,
    rawCount: withEvidence.length,
    note: [
      ...parsed.notes,
      `原始候选 ${withEvidence.length} 个，按 limit=${limit} 返回 ${candidates.length} 个`,
      sameSpecOnly ? '已按 sameSpecOnly 过滤：只保留标题层面结构化规格（螺纹/长度/头型/非套装）命中的候选' : null,
      nearMisses.length
        ? `标题级初筛无命中，另给出 ${nearMisses.length} 个近似候选（未通过初筛，仅可用于进详情页核对；不得当作已匹配证据）：${nearMisses.map(item => `${item.url}（${item.specMatchReason ?? '原因未知'}）`).join('；')}`
        : null,
      parsed.source === 'dom'
        ? '搜索页是 JS 渲染，HTML 解析未命中，使用可见 DOM 文本；单位/MOQ 可能缺失，需在详情页确认'
        : null,
    ]
      .filter(Boolean)
      .join('；'),
    url: pageState.url || url,
    screenshot: null,
  };
}

async function imageSearch({browser, target, imagePath, limit, sameSpecOnly, stateDir, keywords}) {
  const port = browser.port;
  const abs = path.resolve(imagePath);
  try {
    await fs.access(abs);
  } catch {
    return {method: 'image', imagePath: abs, searchedAt: nowIso(), candidates: [], rawCount: 0, note: `图片不存在：${abs}`};
  }
  try {
    await navigate(port, target.targetId, IMAGE_SEARCH_URL, {timeout: 30000});
  } catch (error) {
    return {method: 'image', imagePath: abs, searchedAt: nowIso(), candidates: [], rawCount: 0, note: `导航失败：${error?.message ?? error}`};
  }
  let pageState = await readPageState(port, target.targetId).catch(() => ({url: IMAGE_SEARCH_URL, title: '', text: ''}));
  let blocked = detectBlock(pageState);
  if (blocked) {
    return captureBlock({port, targetId: target.targetId, reason: blocked, stateDir, pageState, method: 'image', imagePath: abs});
  }
  let uploadNote = null;
  try {
    await waitFor(port, target.targetId, `Boolean(document.querySelector('input[type=file]'))`, {timeout: 12000, interval: 400});
    await sendCommand(port, target.targetId, 'DOM.enable');
    const doc = await sendCommand(port, target.targetId, 'DOM.getDocument', {depth: 1});
    const query = await sendCommand(port, target.targetId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file]',
    });
    if (!query?.nodeId) throw new Error('未找到可用的图片上传控件');
    await sendCommand(port, target.targetId, 'DOM.setFileInputFiles', {files: [abs], nodeId: query.nodeId});
    uploadNote = `已通过 CDP DOM.setFileInputFiles 上传 ${abs}`;
  } catch (error) {
    uploadNote = `上传失败：${error?.message ?? error}`;
    const shot = await screenshotBlocked(port, target.targetId, 'image-upload-failed', stateDir);
    return {
      method: 'image',
      imagePath: abs,
      searchedAt: nowIso(),
      candidates: [],
      rawCount: 0,
      note: uploadNote,
      screenshot: shot,
      url: pageState.url,
    };
  }
  try {
    await waitFor(port, target.targetId, `Boolean(document.querySelector('${RESULT_ANCHOR_SELECTOR}'))`, {timeout: 15000, interval: 500});
  } catch {
    // 下面统一按 DOM 结果与页面状态判定。
  }
  pageState = await readPageState(port, target.targetId).catch(() => pageState);
  blocked = detectBlock(pageState);
  if (blocked) {
    return captureBlock({port, targetId: target.targetId, reason: blocked, stateDir, pageState, method: 'image', imagePath: abs, extra: {note: uploadNote}});
  }
  const domResult = await evaluate(port, target.targetId, SEARCH_DOM_JS).catch(() => ({cards: []}));
  const parsed = parseSearchCards(domResult?.cards ?? []);
  const withEvidence = parsed.candidates.map(candidate => {
    const hint = matchHint(keywords ?? '', candidate);
    return {
      ...candidate,
      capturedAt: nowIso(),
      evidence: {
        kind: 'dom',
        pageUrl: pageState.url,
        snippet: candidate.snippet ?? '',
        note: '以图搜款结果页可见商品卡片',
      },
      matchHint: hint.hint,
    };
  });
  const filtered = sameSpecOnly
    ? withEvidence.filter(candidate => {
        const hint = matchHint(keywords ?? '', candidate);
        return hint.total > 0 && hint.matched === hint.total;
      })
    : withEvidence;
  return {
    method: 'image',
    imagePath: abs,
    searchedAt: nowIso(),
    candidates: filtered.slice(0, Math.max(1, Number(limit) || 5)),
    rawCount: withEvidence.length,
    note: [uploadNote, ...parsed.notes, `以图搜款返回候选 ${withEvidence.length} 个`].filter(Boolean).join('；'),
    url: pageState.url,
    screenshot: null,
  };
}

/**
 * 搜索 1688 商品候选。
 * 关键词优先走 s.1688.com 搜索页；页面上下文 fetch 同源 HTML 解析内嵌 JSON，失败退可见 DOM。
 * 以图搜款走 youyuan 图片搜索页，用 CDP 上传本地图片。
 */
export async function searchOffers(params = {}) {
  const stateDir = stateDirOf(params);
  const keywords = typeof params.keywords === 'string' && params.keywords.trim()
    ? params.keywords.trim()
    : typeof params.query === 'string' && params.query.trim()
      ? params.query.trim()
      : '';
  const imagePath = typeof params.imagePath === 'string' && params.imagePath.trim() ? params.imagePath.trim() : '';
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 5;
  const sameSpecOnly = params.sameSpecOnly === true;
  if (!keywords && !imagePath) {
    return {method: 'keyword', keyword: '', searchedAt: nowIso(), candidates: [], rawCount: 0, note: '请提供 keywords 或 imagePath 之一。'};
  }
  let browser;
  try {
    browser = await ensureBrowser({stateDir, port: params.port, timeoutMs: params.timeoutMs});
  } catch (error) {
    return {
      method: imagePath ? 'image' : 'keyword',
      keyword: keywords || undefined,
      searchedAt: nowIso(),
      candidates: [],
      rawCount: 0,
      note: `无法启动本机 Chrome：${error?.message ?? error}`,
    };
  }
  let target;
  try {
    target = await pickTarget(browser.port, /(^https?:\/\/)(www|s)\.1688\.com\//);
  } catch (error) {
    return {
      method: imagePath ? 'image' : 'keyword',
      keyword: keywords || undefined,
      searchedAt: nowIso(),
      candidates: [],
      rawCount: 0,
      note: `无法打开工作标签页：${error?.message ?? error}`,
    };
  }
  try {
    if (keywords) {
      return await keywordSearch({browser, target, keywords, limit, sameSpecOnly, stateDir});
    }
    return await imageSearch({browser, target, imagePath, limit, sameSpecOnly, stateDir, keywords});
  } catch (error) {
    return {
      method: imagePath ? 'image' : 'keyword',
      keyword: keywords || undefined,
      imagePath: imagePath || undefined,
      searchedAt: nowIso(),
      candidates: [],
      rawCount: 0,
      note: `搜索过程中出错：${error?.message ?? error}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 详情页
// ---------------------------------------------------------------------------

const OFFER_PROBE_JS = `(() => {
  const data = window.context && window.context.result && window.context.result.data;
  const priceEl = document.querySelector('.price-info, .item-price-stock, [class*="price-info"], [class*="price-wrap"]');
  const companyEl = document.querySelector('.company-name, [class*="company-name"], .shop-name, [class*="shop-title"]');
  const skuEls = Array.from(document.querySelectorAll('.sku-filter-button, [class*="sku-filter"] [class*="item"], .module-od-sku-selection [class*="sku"]'));
  return {
    url: location.href,
    title: document.title,
    hasContext: Boolean(data),
    data: data || null,
    dom: {
      priceText: priceEl ? (priceEl.innerText || '').trim().slice(0, 300) : '',
      companyText: companyEl ? (companyEl.innerText || '').trim().slice(0, 200) : '',
      skuTexts: skuEls.map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 60),
      bodySample: (document.body && document.body.innerText || '').slice(0, 1500),
    },
  };
})()`;

function normalizeOfferUrl(url) {
  const text = String(url ?? '').trim();
  const match = text.match(/detail\.1688\.com\/offer\/(\d+)\.html/i);
  if (!match) return null;
  return `https://detail.1688.com/offer/${match[1]}.html`;
}

/**
 * 在详情页 SKU 列表里按需求文本选规格：先过结构化匹配（螺纹/长度/头型/套装），
 * 通过后再按字面 token 打分（颜色、尺寸文字等），同分取低价。
 * 匹配不到就返回 selected=null —— 上层不得据此产出 specMatched 证据。
 */
function markSelectedSku(offers, skuHint) {
  if (!skuHint) return {offers, selected: null, match: null};
  const needles = String(skuHint)
    .toLowerCase()
    .split(/[\s,，;；/]+/)
    .filter(token => token.length >= 1)
    .map(token => token.replace(/[×*]/g, 'x'));
  const scored = [];
  for (const offer of offers) {
    const specText = String(offer.props ?? offer.propsText ?? '');
    const check = matchSpec({query: skuHint, title: '', spec: specText});
    if (!check.matched) continue;
    const haystack = specText.toLowerCase().replace(/[×*]/g, 'x');
    let score = 0;
    for (const needle of needles) if (needle && haystack.includes(needle)) score += 1;
    scored.push({offer, check, score, price: Number.isFinite(offer.price) ? offer.price : Number.POSITIVE_INFINITY});
  }
  if (!scored.length) return {offers, selected: null, match: null};
  scored.sort((a, b) => b.score - a.score || a.price - b.price);
  scored[0].offer.selected = true;
  return {offers, selected: scored[0].offer, match: scored[0].check};
}

/**
 * 打开并抽取 1688 详情页：标题、供应商、单位、SKU 规格列表（属性/价格/MOQ）。
 * 数据优先读 window.context.result.data；不可用时退可见 DOM 文本。
 * 遇到登录墙/验证码返回 blocked + 截图，绝不绕过。
 */
export async function openOffer(url, options = {}) {
  const stateDir = stateDirOf(options);
  const targetUrl = normalizeOfferUrl(url);
  if (!targetUrl) {
    return {
      url: String(url ?? ''),
      title: null,
      company: null,
      unit: null,
      offers: [],
      capturedAt: nowIso(),
      domNotes: '不是 detail.1688.com/offer/<id>.html 形式的详情页链接，未打开页面。',
      error: 'invalid_offer_url',
    };
  }
  if (!isOffer(targetUrl)) {
    return {url: targetUrl, title: null, company: null, unit: null, offers: [], capturedAt: nowIso(), domNotes: '链接未通过 lookup.isOffer 校验。', error: 'invalid_offer_url'};
  }
  let browser;
  try {
    browser = await ensureBrowser({stateDir, port: options.port, timeoutMs: options.timeoutMs});
  } catch (error) {
    return {url: targetUrl, title: null, company: null, unit: null, offers: [], capturedAt: nowIso(), domNotes: `无法启动本机 Chrome：${error?.message ?? error}`, error: 'browser_unavailable'};
  }
  let target;
  try {
    target = await pickTarget(browser.port, /^https?:\/\/detail\.1688\.com\/offer\//);
    await navigate(browser.port, target.targetId, targetUrl, {timeout: 35000});
  } catch (error) {
    return {url: targetUrl, title: null, company: null, unit: null, offers: [], capturedAt: nowIso(), domNotes: `打开详情页失败：${error?.message ?? error}`, error: 'navigate_failed'};
  }
  const port = browser.port;
  try {
    await waitFor(
      port,
      target.targetId,
      `Boolean((window.context && window.context.result && window.context.result.data)
        || document.querySelector('.price-info, .module-od-sku-selection, [class*="sku-selection"]'))`,
      {timeout: 20000, interval: 400},
    );
  } catch {
    // 超时也继续：下面 probe 会说明页面实际状态。
  }
  let probe = null;
  try {
    probe = await evaluate(port, target.targetId, OFFER_PROBE_JS);
  } catch (error) {
    probe = {url: targetUrl, title: '', hasContext: false, data: null, dom: {priceText: '', companyText: '', skuTexts: [], bodySample: ''}, error: String(error?.message ?? error)};
  }
  const pageState = {url: probe?.url ?? targetUrl, title: probe?.title ?? '', text: probe?.dom?.bodySample ?? ''};
  const blocked = detectBlock(pageState);
  if (blocked) {
    const shot = await screenshotBlocked(port, target.targetId, blocked, stateDir);
    return {
      url: pageState.url,
      title: pageState.title || null,
      company: null,
      unit: null,
      offers: [],
      capturedAt: nowIso(),
      domNotes: `页面被${blocked === 'login' ? '登录墙' : '验证码/安全验证'}拦截：可见文字「${String(pageState.text).replace(/\s+/g, ' ').slice(0, 160)}」；未尝试绕过。`,
      blocked,
      screenshot: shot,
    };
  }

  const fromContext = extractOfferFromContext(probe?.data ?? null);
  const domPriceText = decodeHtmlText(probe?.dom?.priceText ?? '');
  const domTextSample = String(probe?.dom?.bodySample ?? '');
  const domFallback = extractOfferFromDom({
    titleText: probe?.title ?? '',
    companyText: probe?.dom?.companyText ?? '',
    text: domTextSample,
    skuTexts: probe?.dom?.skuTexts ?? [],
  });
  const extracted = fromContext.contextFound ? fromContext : domFallback;
  const offers = Array.isArray(extracted.offers) ? [...extracted.offers] : [];
  const selection = markSelectedSku(offers, options.skuHint);
  const selected = selection.selected;
  const finalUrl = pageState.url && /detail\.1688\.com\/offer\/\d+\.html/i.test(pageState.url) ? normalizeOfferUrl(pageState.url) ?? targetUrl : targetUrl;
  const domNotes = [
    ...(extracted.domNotes ?? []),
    domPriceText ? `DOM 价格文本「${domPriceText}」` : null,
    probe?.dom?.companyText ? `DOM 供应商文本「${decodeHtmlText(probe.dom.companyText)}」` : null,
    finalUrl !== targetUrl ? `页面最终 URL ${finalUrl}` : null,
    options.skuHint && !selected
      ? `未找到同时满足「${options.skuHint}」的螺纹/长度/头型/非套装 SKU（${selection.match?.reason ?? '全部 SKU 均不匹配'}）`
      : null,
  ]
    .filter(Boolean)
    .join('；');

  // 详情页数据可能只有价格档位、没有 SKU 明细（单规格 offer）；此时把档位也返回，方便上层核对。
  return {
    url: finalUrl,
    title: extracted.title || decodeHtmlText(probe?.title ?? '') || null,
    company: extracted.company || null,
    unit: extracted.unit || null,
    saleNum: extracted.saleNum || null,
    beginNum: extracted.beginNum,
    tiers: extracted.tiers ?? [],
    props: extracted.props ?? [],
    offers: offers.map(offer => (selected && selected.skuId === offer.skuId ? {...offer, selected: true} : offer)),
    selectedSku: selected ?? null,
    specHint: options.skuHint ?? null,
    specMatch: selection.match
      ? {matched: selection.match.matched, reason: selection.match.reason}
      : null,
    capturedAt: nowIso(),
    domNotes,
    source: extracted.contextFound ? 'window.context' : 'dom_text',
    blocked: null,
  };
}

// ---------------------------------------------------------------------------
// 登录态落盘
// ---------------------------------------------------------------------------

/**
 * 把持久 Chrome 的 1688 登录 cookie 强制落盘：Chrome 只在优雅关闭时保证 cookie 写盘，
 * 这里用 CDP Browser.close 优雅关闭再按同一 profile 重启（登录态随之持久化）。
 * 未登录时不关闭窗口，直接返回 ok:false。绝不读写 cookie 值。
 */
export async function flushLogin(options = {}) {
  const stateDir = stateDirOf(options);
  const capturedAt = nowIso();
  let browser;
  try {
    browser = await ensureBrowser({stateDir, port: options.port, timeoutMs: options.timeoutMs});
  } catch (error) {
    return {ok: false, reason: `无法启动本机 Chrome：${error?.message ?? error}`, capturedAt};
  }
  const status = await loginStatus({...options, stateDir, port: browser.port});
  if (!status.loggedIn) {
    return {
      ok: false,
      reason: `当前未登录，无需落盘：${status.evidence}`,
      capturedAt,
      port: browser.port,
    };
  }
  const probeTarget = await pickTarget(browser.port, /(^https?:\/\/)(www|work)\.1688\.com\//).catch(() => null);
  const before = probeTarget ? await readCookiesSafe(browser.port, probeTarget.targetId) : [];
  const beforeSignal = cookieSignal(before);
  if (!beforeSignal.total) {
    return {ok: false, reason: '未读到 1688 域 cookie，无法确认登录会话。', capturedAt, port: browser.port};
  }
  const port = browser.port;
  try {
    const closed = await closeBrowser(port, {stateDir});
    if (!closed?.closed) {
      return {ok: false, reason: `关闭 Chrome 失败（端口 ${port} 仍被占用），未完成落盘。`, capturedAt, port};
    }
    const relaunched = await ensureBrowser({stateDir, port, timeoutMs: options.timeoutMs});
    // 刚重启的 Chrome 里 cookie 尚未附着到某个页面会话，必须重新加载 1688 页面
    // 再读，才能判断登录态是否随 profile 落盘（不能凭 about:blank 的 0 个 cookie 误判失败）。
    const afterStatus = await loginStatus({...options, stateDir, port: relaunched.port});
    let afterSignal = {total: 0, names: [], logonTrue: false};
    try {
      const checkTarget = await pickTarget(relaunched.port, /(^https?:\/\/)(www|work)\.1688\.com\//);
      if (checkTarget) afterSignal = cookieSignal(await readCookiesSafe(relaunched.port, checkTarget.targetId));
    } catch {}
    const persisted = afterStatus.loggedIn;
    return {
      ok: persisted,
      evidence: `优雅关闭 Chrome 触发 cookie 落盘后按同一 profile 重启（端口 ${relaunched.port}）；关闭前 1688 域 cookie ${beforeSignal.total} 个（名称：${beforeSignal.names.join(',')}）；重启并重新加载 1688 页面后 1688 域 cookie ${afterSignal.total} 个。登录态复核：${afterStatus.evidence}；只统计名称与数量，不读取值。${
        persisted ? '登录态已随 profile 持久化。' : '重启后未观察到登录态，未能确认落盘。'
      }`,
      capturedAt: nowIso(),
      port: relaunched.port,
      cookieCount: afterSignal.total,
      restarted: true,
      ...(persisted ? {} : {reason: '重启后未观察到登录态'}),
    };
  } catch (error) {
    return {ok: false, reason: `落盘过程出错：${error?.message ?? error}`, capturedAt, port};
  }
}

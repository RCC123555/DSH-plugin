// 真实采集入口：跑一次真实的 searchOffers + openOffer，把结果落成 fixture。
//
// 用法（在 hardware-quote 目录）：
//   node test/fixtures/capture-live.mjs
//   node test/fixtures/capture-live.mjs --keywords "铁艺沙发脚" --offer https://detail.1688.com/offer/721403962321.html
//   HWQ_LIVE_IMAGE=C:\\path\\part.jpg node test/fixtures/capture-live.mjs
//
// 搜索未登录时输出 blocked 原因 + 截图路径并以非 0 退出；详情页无需登录也可采集（会标注 loggedIn）。
// 不伪造任何字段：采不到就留空并写明原因。每个文件都带 capturedAt / url（或搜索 URL）/ driver / loggedIn。
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureBrowser, disconnectAll } from '../../lib/cdp.mjs';
import { loginStatus, searchOffers, openOffer, toEvidence } from '../../lib/ali1688.mjs';
import { validatePriceEvidence } from '../../lib/lookup.mjs';

const outDir = import.meta.dirname;
const args = process.argv.slice(2);
const arg = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const keywords = arg('keywords') ?? process.env.HWQ_LIVE_KEYWORDS ?? '内六角法兰盘螺丝 M6*15';
const imagePath = arg('image') ?? process.env.HWQ_LIVE_IMAGE;
const fallbackOffer = arg('offer') ?? process.env.HWQ_LIVE_OFFER ?? 'https://detail.1688.com/offer/721403962321.html';

const driver = async () => {
  const browser = await ensureBrowser({});
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    chrome: browser.browser ?? null,
    port: browser.port,
  };
};

async function write(name, value) {
  const file = path.join(outDir, name);
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  console.log(`wrote ${file}`);
}

const meta = await driver();
console.log('driver', JSON.stringify(meta));

const status = await loginStatus();
console.log(`loginStatus loggedIn=${status.loggedIn} capturedAt=${status.capturedAt}`);
console.log(status.evidence);

const loginNote = {
  loggedIn: Boolean(status.loggedIn),
  loginCapturedAt: status.capturedAt,
  loginEvidence: status.evidence,
};

let search;
if (!status.loggedIn) {
  search = {
    capturedAt: new Date().toISOString(),
    method: imagePath ? 'image' : 'keyword',
    keyword: imagePath ? undefined : keywords,
    imagePath: imagePath ?? undefined,
    candidates: [],
    rawCount: 0,
    blocked: 'login',
    evidence: `未登录，未执行搜索。loginStatus 证据：${status.evidence}`,
    ...loginNote,
  };
  await write('live-search.json', {...search, driver: meta});
  console.error('搜索未登录：无法进行真实关键词/以图搜索。请先在插件 Chrome 窗口扫码登录后重跑本脚本。');
  process.exitCode = 1;
} else {
  search = await searchOffers({keywords: imagePath ? undefined : keywords, imagePath, limit: 5});
  await write('live-search.json', {
    capturedAt: new Date().toISOString(),
    driver: meta,
    ...loginNote,
    ...search,
  });
  console.log(`search method=${search.method} candidates=${search.candidates?.length ?? 0} blocked=${search.blocked ?? 'no'}`);
  if (search.note) console.log(`search note: ${search.note}`);
  if (search.blocked) process.exitCode = 1;
}

// 详情页要带 skuHint 才能按结构化规格选 SKU；若首个候选没有同规格 SKU，
// 依次看下 2 个候选（只开详情页，不重复搜索），挑到同规格就停；都没有就保留首个并如实标不匹配。
const skuHint = imagePath ? undefined : keywords;
const candidateUrls = [
  ...(arg('offer') ? [arg('offer')] : []),
  ...(search.candidates ?? []).slice(0, 3).map(candidate => candidate.url),
];
if (!candidateUrls.length) candidateUrls.push(fallbackOffer);
let offer = null;
let offerUrl = candidateUrls[0];
for (const candidateUrl of candidateUrls) {
  const attempt = await openOffer(candidateUrl, {skuHint});
  if (!offer) {
    offer = attempt;
    offerUrl = candidateUrl;
  }
  if (attempt.selectedSku) {
    offer = attempt;
    offerUrl = candidateUrl;
    break;
  }
}
const offerId = String(offerUrl).match(/offer\/(\d+)\.html/)?.[1] ?? 'unknown';
await write(`live-offer-${offerId}.json`, {
  capturedAt: new Date().toISOString(),
  driver: meta,
  ...loginNote,
  ...offer,
});
console.log(`offer url=${offer.url} title=${offer.title} offers=${offer.offers?.length ?? 0} blocked=${offer.blocked ?? 'no'}`);
if (offer.blocked) {
  console.error(`详情页受阻：${offer.blocked}，截图 ${offer.screenshot}`);
  process.exitCode = 1;
}

// 用真实详情数据组装一条 canonical 证据，确认 hwq_1688_average 的校验器可直接消费。
if (!offer.blocked && Array.isArray(offer.offers) && offer.offers.length > 0) {
  // 只认结构化规格匹配到的 SKU；匹配不到时保留候选但不得标 specMatched。
  const sku = offer.selectedSku ?? offer.offers[0];
  const specMatched = Boolean(offer.selectedSku);
  const queriedAt = new Date(offer.capturedAt).toISOString().slice(0, 10);
  const evidence = toEvidence(
    {...sku, supplier: offer.company, title: offer.title, url: offer.url},
    {
      queriedAt,
      searchMethod: imagePath ? 'image' : 'keyword',
      keywords: imagePath ? undefined : keywords,
      inputImage: imagePath ?? undefined,
      targetUnit: offer.unit,
      targetUnitsPerQuoteUnit: 1,
      selectedSpec: sku.props,
      observedText: `真实详情页显示规格 ${sku.props} 的价格文本 ${sku.priceText}，起订 ${sku.moqText ?? '未显示'}${
        specMatched ? '' : `；未找到满足「${keywords ?? '需求'}」的规格（${offer.specMatch?.reason ?? offer.domNotes ?? '规格不符'}）`
      }`,
      specMatched,
      minOrderQty: sku.moq,
      tierMinQty: offer.tiers?.[0]?.beginAmount,
    },
  );
  const issues = validatePriceEvidence(evidence, 500);
  await write(`live-evidence-${offerId}.json`, {
    capturedAt: new Date().toISOString(),
    driver: meta,
    ...loginNote,
    sourceOffer: offer.url,
    demandSample: 500,
    validated: issues.length === 0,
    issues,
    evidence,
  });
  if (issues.length) console.error(`证据校验未通过：${issues.join('；')}`);
}

// 断开 CDP WebSocket，让脚本正常退出（不关闭用户的 Chrome 窗口）。
disconnectAll();
console.log(`done (exitCode=${process.exitCode ?? 0})`);

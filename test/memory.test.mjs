import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {
  MEMORY_SCHEMA_VERSION,
  ageDaysOf,
  clearMemory,
  forgetMemory,
  getOfferMemory,
  getSearchMemory,
  isCacheableOfferResult,
  isCacheableSearchResult,
  listMemory,
  memoryKeyForOffer,
  memoryKeyForSearch,
  normalizeSearchTerm,
  pruneMemory,
  rememberOffer,
  rememberSearch,
  resetMemoryCache,
  resolveMemoryConfig,
  resolveTtlDays,
  statusMemory,
  syncMemory,
} from '../lib/memory.mjs'

const DAY = 24 * 60 * 60 * 1000
const savedEnv = {}

function setEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = String(value)
  }
  resetMemoryCache()
}

function restoreEnv() {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetMemoryCache()
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'},
  })
}

function searchResult(overrides = {}) {
  const searchedAt = overrides.searchedAt ?? new Date(Date.now() - 2 * DAY).toISOString()
  return {
    method: 'keyword',
    keyword: 'M6*15 不锈钢 螺丝',
    searchedAt,
    candidates: [
      {
        url: 'https://detail.1688.com/offer/123456789.html',
        title: '304不锈钢内六角螺丝 M6*15',
        priceText: '¥0.12',
        price: 0.12,
        supplier: '测试供应商',
      },
    ],
    nearMisses: [],
    rawCount: 1,
    note: null,
    url: 'https://s.1688.com/selloffer/offer_search.htm?keywords=M6*15',
    ...overrides,
  }
}

function offerResult(overrides = {}) {
  const capturedAt = overrides.capturedAt ?? new Date(Date.now() - DAY).toISOString()
  return {
    url: 'https://detail.1688.com/offer/987654321.html',
    title: '304不锈钢内六角螺丝',
    company: '测试五金厂',
    unit: '个',
    saleNum: 1000,
    beginNum: 10,
    tiers: [{minQty: 10, price: 0.12}],
    props: [{name: '规格', value: 'M6*15'}],
    offers: [
      {spec: 'M6*15', price: 0.12, unit: '个', selected: true},
      {spec: 'M8*20', price: 0.2, unit: '个', selected: false},
    ],
    selectedSku: {spec: 'M6*15', price: 0.12},
    specHint: 'M6*15',
    specMatch: true,
    capturedAt,
    domNotes: [],
    source: 'context',
    blocked: null,
    ...overrides,
  }
}

async function setupRepo(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hwq-memory-'))
  const bare = path.join(root, 'memory.git')
  execFileSync('git', ['init', '--bare', bare], {encoding: 'utf8'})
  const dir = path.join(root, 'machine-a')
  setEnv({
    HWQ_MEMORY: '1',
    HWQ_MEMORY_GIT: '1',
    HWQ_MEMORY_DIR: undefined,
    HWQ_MEMORY_TTL_DAYS: undefined,
    HWQ_MEMORY_GIT_URL: `file://${bare.replace(/\\/g, '/')}`,
    HWQ_MEMORY_GIT_DIR: dir,
    HWQ_MEMORY_PULL_INTERVAL_MS: '0',
    HWQ_MEMORY_PUSH_INTERVAL_MS: '0',
    HWQ_MEMORY_GIT_BRANCH: 'price-memory',
  })
  t.after(async () => {
    restoreEnv()
    await fsp.rm(root, {recursive: true, force: true})
  })
  return {root, bare, dir}
}

test('关键词规范化与记忆键稳定', () => {
  assert.equal(normalizeSearchTerm('  M6 × 15  不锈钢 '), 'm6x15不锈钢')
  assert.equal(normalizeSearchTerm('Ｍ６＊１５'), 'm6x15')
  assert.equal(memoryKeyForSearch({method: 'keyword', keywords: 'M6*15'}), memoryKeyForSearch({method: 'keyword', keywords: 'm6 × 15'}))
  assert.match(memoryKeyForSearch({method: 'keyword', keywords: 'M6*15'}), /^search:keyword:/)
  const imageKey = memoryKeyForSearch({method: 'image', imageBuffer: Buffer.from('fake-image')})
  assert.equal(imageKey, memoryKeyForSearch({method: 'image', imageBuffer: Buffer.from('fake-image')}))
  assert.notEqual(imageKey, memoryKeyForSearch({method: 'image', imageBuffer: Buffer.from('other')}))
  assert.equal(memoryKeyForOffer('https://detail.1688.com/offer/123.html'), 'offer:123')
  assert.equal(memoryKeyForOffer('123'), 'offer:123')
  assert.throws(() => memoryKeyForOffer('https://detail.1688.com/offer/abc.html'))
})

test('TTL 默认 180 天且可被参数/环境覆写', () => {
  assert.equal(resolveTtlDays(), 180)
  assert.equal(resolveTtlDays(30), 30)
  setEnv({HWQ_MEMORY_TTL_DAYS: '90'})
  assert.equal(resolveTtlDays(), 90)
  assert.equal(resolveTtlDays(7), 7)
  restoreEnv()
})

test('搜索记忆写入命中、缺失与 useMemory:false', async t => {
  await setupRepo(t)
  const miss = await getSearchMemory({keywords: 'M6*15'})
  assert.equal(miss.hit, false)
  assert.equal(miss.reason, 'miss')
  const written = await rememberSearch({keywords: 'M6*15', result: searchResult()})
  assert.equal(written.stored, true)
  const hit = await getSearchMemory({keywords: 'm6 × 15'})
  assert.equal(hit.hit, true)
  assert.equal(hit.entry.payload.candidates.length, 1)
  assert.equal(hit.entry.payload.candidates[0].title, '304不锈钢内六角螺丝 M6*15')
  assert.ok(hit.ageDays >= 1.9 && hit.ageDays <= 2.1)
  assert.equal(hit.backend, 'git')
  assert.equal((await getSearchMemory({keywords: 'M6*15', useMemory: false})).hit, false)
})

test('超过 TTL 的记忆视为过期，必须重查', async t => {
  await setupRepo(t)
  const old = searchResult({searchedAt: new Date(Date.now() - 200 * DAY).toISOString()})
  assert.equal((await rememberSearch({keywords: 'M8*20', result: old})).stored, true)
  const expired = await getSearchMemory({keywords: 'M8*20'})
  assert.equal(expired.hit, false)
  assert.equal(expired.reason, 'expired')
  assert.ok(expired.ageDays > 199)
  const withLongTtl = await getSearchMemory({keywords: 'M8*20', maxAgeDays: 400})
  assert.equal(withLongTtl.hit, true)
})

test('只缓存成功且非空的结果', async t => {
  await setupRepo(t)
  assert.equal((await rememberSearch({keywords: 'blocked', result: searchResult({blocked: {kind: 'captcha'}})})).stored, false)
  assert.equal((await rememberSearch({keywords: 'empty', result: searchResult({candidates: []})})).stored, false)
  assert.equal((await rememberOffer({result: offerResult({blocked: {kind: 'login'}})})).stored, false)
  assert.equal((await rememberOffer({result: offerResult({offers: []})})).stored, false)
  assert.equal(isCacheableSearchResult(searchResult()), true)
  assert.equal(isCacheableSearchResult(searchResult({candidates: []})), false)
  assert.equal(isCacheableOfferResult(offerResult()), true)
  assert.equal(isCacheableOfferResult(offerResult({offers: []})), false)
})

test('详情记忆写入命中，并保留 SKU 供当前 skuHint 重选', async t => {
  await setupRepo(t)
  assert.equal((await getOfferMemory({url: 'https://detail.1688.com/offer/987654321.html'})).hit, false)
  const written = await rememberOffer({result: offerResult()})
  assert.equal(written.stored, true)
  const hit = await getOfferMemory({url: 'https://detail.1688.com/offer/987654321.html'})
  assert.equal(hit.hit, true)
  assert.equal(hit.entry.payload.offers.length, 2)
  assert.equal(hit.entry.payload.offers[0].spec, 'M6*15')
  assert.equal(hit.entry.payload.url, 'https://detail.1688.com/offer/987654321.html')
})

test('损坏文件按未命中处理且不抛错', async t => {
  const {dir} = await setupRepo(t)
  await rememberSearch({keywords: 'damaged', result: searchResult()})
  const key = memoryKeyForSearch({method: 'keyword', keywords: 'damaged'})
  const {createHash} = await import('node:crypto')
  const file = path.join(dir, 'search', `${createHash('sha256').update(key).digest('hex')}.json`)
  assert.equal(fs.existsSync(file), true)
  await fsp.writeFile(file, '{not-json', 'utf8')
  const result = await getSearchMemory({keywords: 'damaged'})
  assert.equal(result.hit, false)
  assert.equal(result.reason, 'corrupt_entry')
})

test('两台机器共享：后写入的 commit 可被另一台 pull 到', async t => {
  const {root, bare, dir} = await setupRepo(t)
  await rememberSearch({keywords: 'shared', result: searchResult()})
  const dirB = path.join(root, 'machine-b')
  setEnv({HWQ_MEMORY_GIT_DIR: dirB})
  const onB = await getSearchMemory({keywords: 'shared'})
  assert.equal(onB.hit, true)
  assert.equal(onB.backend, 'git')
  await rememberSearch({keywords: 'from-b', result: searchResult({searchedAt: new Date().toISOString()})})
  setEnv({HWQ_MEMORY_GIT_DIR: dir})
  const backOnA = await getSearchMemory({keywords: 'from-b'})
  assert.equal(backOnA.hit, true)
  assert.equal(fs.existsSync(path.join(dirB, '.git')), true)
  assert.ok(bare)
})

test('同一键并发/重复写入后读取最新 capturedAt 且不损坏', async t => {
  await setupRepo(t)
  const latest = new Date(Date.now() - DAY).toISOString()
  await Promise.all([
    rememberSearch({keywords: 'race', result: searchResult({searchedAt: new Date(Date.now() - 5 * DAY).toISOString()})}),
    rememberSearch({keywords: 'race', result: searchResult({searchedAt: latest})}),
  ])
  const hit = await getSearchMemory({keywords: 'race'})
  assert.equal(hit.hit, true)
  assert.equal(hit.entry.capturedAt, latest)
})

test('status/list/prune/forget/clear 全链路', async t => {
  await setupRepo(t)
  await rememberSearch({keywords: 'A', result: searchResult()})
  await rememberOffer({result: offerResult()})
  await rememberSearch({keywords: 'OLD', result: searchResult({searchedAt: new Date(Date.now() - 300 * DAY).toISOString()})})
  const status = await statusMemory()
  assert.equal(status.enabled, true)
  assert.equal(status.backend, 'git')
  assert.equal(status.entries.total, 3)
  assert.equal(status.entries.search, 2)
  assert.equal(status.entries.offer, 1)
  assert.equal(status.ttlDays, 180)
  const list = await listMemory()
  assert.equal(list.total, 3)
  assert.ok(list.items.some(item => item.kind === 'offer' && item.offerCount === 2))
  const pruned = await pruneMemory()
  assert.equal(pruned.removed, 1)
  const afterPrune = await statusMemory()
  assert.equal(afterPrune.entries.total, 2)
  const forgotten = await forgetMemory({keywords: 'A'})
  assert.equal(forgotten.removed, true)
  assert.equal((await statusMemory()).entries.total, 1)
  await assert.rejects(() => clearMemory(), /confirm:true/)
  const cleared = await clearMemory({confirm: true})
  assert.equal(cleared.removed, 1)
  assert.equal((await statusMemory()).entries.total, 0)
})

test('git 不可用时降级本地目录且仍能命中', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hwq-memory-fallback-'))
  const stateDir = path.join(root, 'state')
  setEnv({
    HWQ_MEMORY: '1',
    HWQ_MEMORY_GIT: '1',
    HWQ_MEMORY_GIT_URL: `file://${path.join(root, 'missing.git').replace(/\\/g, '/')}`,
    HWQ_MEMORY_GIT_DIR: path.join(root, 'clone'),
    HWQ_MEMORY_DIR: undefined,
    HWQ_MEMORY_PULL_INTERVAL_MS: '0',
    HWQ_MEMORY_PUSH_INTERVAL_MS: '0',
  })
  t.after(async () => {
    restoreEnv()
    await fsp.rm(root, {recursive: true, force: true})
  })
  const written = await rememberSearch({stateDir, keywords: 'offline', result: searchResult()})
  assert.equal(written.stored, true)
  const status = await statusMemory({stateDir})
  assert.equal(status.backend, 'local-fallback')
  assert.match(status.degraded, /clone|克隆|repository|仓库/i)
  const hit = await getSearchMemory({stateDir, keywords: 'offline'})
  assert.equal(hit.hit, true)
  assert.equal(hit.backend, 'dir')
})

test('HWQ_MEMORY_DIR 目录后端与 HWQ_MEMORY=0 关闭记忆', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hwq-memory-dir-'))
  const dir = path.join(root, 'memory')
  setEnv({HWQ_MEMORY: '1', HWQ_MEMORY_DIR: dir, HWQ_MEMORY_TTL_DAYS: undefined})
  t.after(async () => {
    restoreEnv()
    await fsp.rm(root, {recursive: true, force: true})
  })
  assert.equal(resolveMemoryConfig().backend, 'dir')
  assert.equal((await rememberSearch({keywords: 'dirback', result: searchResult()})).stored, true)
  assert.equal((await getSearchMemory({keywords: 'dirback'})).hit, true)
  setEnv({HWQ_MEMORY: '0'})
  assert.equal((await getSearchMemory({keywords: 'dirback'})).hit, false)
  assert.equal((await rememberSearch({keywords: 'dirback', result: searchResult()})).stored, false)
})

test('sync 在 git 后端拉取远端更新', async t => {
  const {root, dir} = await setupRepo(t)
  await rememberSearch({keywords: 'sync-me', result: searchResult()})
  const dirB = path.join(root, 'machine-b')
  setEnv({HWQ_MEMORY_GIT_DIR: dirB})
  await syncMemory()
  const hit = await getSearchMemory({keywords: 'sync-me'})
  assert.equal(hit.hit, true)
  setEnv({HWQ_MEMORY_GIT_DIR: dir})
  const sync = await syncMemory()
  assert.equal(sync.enabled, true)
  assert.equal(sync.backend, 'git')
  assert.equal(sync.synced, true)
  assert.equal(ageDaysOf({capturedAt: new Date(Date.now() - 10 * DAY).toISOString()}) > 9.9, true)
  assert.equal(MEMORY_SCHEMA_VERSION, 1)
})

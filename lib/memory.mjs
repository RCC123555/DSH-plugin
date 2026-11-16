/**
 * hardware-quote · 1688 价格记忆（跨机器共享）
 *
 * 目标：同一物料第二次查询直接复用上次真实抓取结果，避免重复访问 1688；
 * 记忆存放在 GitHub 仓库同仓库的独立分支 `price-memory`（与插件源码分仓不同分支，
 * 不影响安装/发布），本机克隆到 ~/.dsh/hardware-quote/price-memory-git。
 *
 * 存储：一条记录一个 JSON
 *   search/<sha256(key)>.json   关键词/以图搜款结果
 *   offer/<offerId>.json        详情页 SKU/价格结果
 * 字段：schemaVersion、kind、key、capturedAt、storedAt、source、payload。
 *
 * 规则：
 *   - 只缓存真实抓取成功的结果；登录墙/验证码/空结果绝不入库；
 *   - 默认 TTL 180 天（超过 6 个月必须重新查询），可被 maxAgeDays/HWQ_MEMORY_TTL_DAYS 覆写；
 *   - pull 节流 60s、push 节流 15s；push 遇到非快进先 pull --rebase 再重试一次；
 *   - 离线时保留本地 commit（pendingPush），下次 sync/查询继续推送；
 *   - 克隆/推送失败自动降级到本地目录 ~/.dsh/hardware-quote/price-memory，并在 status 标明；
 *   - HWQ_MEMORY_DIR 可切到任意目录后端（便于测试/OneDrive 等）。
 *
 * 该模块不读取 1688 账号、Cookie 或截图，只保存公开商品页的价格与规格文本。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFile} from 'node:child_process'
import {defaultStateDir} from './cdp.mjs'

export const MEMORY_SCHEMA_VERSION = 1
export const DEFAULT_TTL_DAYS = 180
export const DEFAULT_GIT_URL = 'https://github.com/RCC123555/DSH-plugin.git'
export const DEFAULT_GIT_BRANCH = 'price-memory'
export const DEFAULT_PULL_INTERVAL_MS = 60_000
export const DEFAULT_PUSH_INTERVAL_MS = 15_000

const DAY_MS = 24 * 60 * 60 * 1000
const GIT_IDENTITY = ['-c', 'user.name=hardware-quote-memory', '-c', 'user.email=hardware-quote-memory@users.noreply.github.com']

export const MEMORY_README = `# hardware-quote price-memory

1688 物料价格记忆（由 DSH hardware-quote 插件自动维护，请勿手工改结构）。

- \`search/<sha256>.json\`：关键词 / 以图搜款候选结果
- \`offer/<offerId>.json\`：详情页 SKU、阶梯价、供应商等抽取结果

每个文件字段：\`schemaVersion\`、\`kind\`、\`key\`、\`capturedAt\`、\`storedAt\`、\`source\`、\`payload\`。
只缓存真实抓取成功的结果；登录墙、验证码、空结果不入库。
超过 180 天的记录由插件在查询时重新抓取并覆盖。

价格数据来自 1688 等公开商品页，不包含账号、Cookie、聊天或截图。
`

const storeCache = new Map()
const writeQueues = new Map()
const gitState = new Map()

const nowIso = () => new Date().toISOString()
const round2 = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null)

function stateDirFor(options = {}) {
  return options.stateDir ? path.resolve(options.stateDir) : defaultStateDir()
}

function envNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 解析 TTL（天）：显式参数 > HWQ_MEMORY_TTL_DAYS > 180。 */
export function resolveTtlDays(value) {
  for (const candidate of [value, process.env.HWQ_MEMORY_TTL_DAYS]) {
    if (candidate === undefined || candidate === null || candidate === '') continue
    const num = Number(candidate)
    if (Number.isFinite(num) && num >= 0) return num
  }
  return DEFAULT_TTL_DAYS
}

/** 解析记忆后端配置；不做 I/O。 */
export function resolveMemoryConfig(options = {}) {
  const stateDir = stateDirFor(options)
  const ttlDays = resolveTtlDays(options.maxAgeDays)
  if (process.env.HWQ_MEMORY === '0') return {enabled: false, backend: 'disabled', stateDir, ttlDays}
  const dirOverride = process.env.HWQ_MEMORY_DIR
  if (dirOverride && dirOverride.trim()) {
    const dir = path.resolve(dirOverride.trim())
    return {enabled: true, backend: 'dir', stateDir, dir, mirrorDir: dir, ttlDays}
  }
  const localDir = path.join(stateDir, 'price-memory')
  if (process.env.HWQ_MEMORY_GIT === '0') {
    return {enabled: true, backend: 'dir', stateDir, dir: localDir, mirrorDir: localDir, ttlDays}
  }
  return {
    enabled: true,
    backend: 'git',
    stateDir,
    dir: process.env.HWQ_MEMORY_GIT_DIR ? path.resolve(process.env.HWQ_MEMORY_GIT_DIR) : path.join(stateDir, 'price-memory-git'),
    mirrorDir: localDir,
    url: process.env.HWQ_MEMORY_GIT_URL || DEFAULT_GIT_URL,
    branch: process.env.HWQ_MEMORY_GIT_BRANCH || DEFAULT_GIT_BRANCH,
    ttlDays,
    pullIntervalMs: envNumber('HWQ_MEMORY_PULL_INTERVAL_MS', DEFAULT_PULL_INTERVAL_MS),
    pushIntervalMs: envNumber('HWQ_MEMORY_PUSH_INTERVAL_MS', DEFAULT_PUSH_INTERVAL_MS),
  }
}

export function memoryEnabled() {
  return process.env.HWQ_MEMORY !== '0'
}

/** 测试/诊断用：清空进程内缓存（不改磁盘）。 */
export function resetMemoryCache() {
  storeCache.clear()
  writeQueues.clear()
  gitState.clear()
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** 关键词规范化：NFKC、英文小写、×/*→x、去所有空白。 */
export function normalizeSearchTerm(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, '')
    .trim()
}

/** 搜索记忆键：关键词归一化；以图搜款用图片内容 sha256。 */
export function memoryKeyForSearch({method = 'keyword', keywords, imageBuffer} = {}) {
  if (method === 'image') {
    if (!imageBuffer || imageBuffer.length === 0) throw new Error('以图搜款的记忆键需要图片内容。')
    return `search:image:${sha256Hex(imageBuffer)}`
  }
  const term = normalizeSearchTerm(keywords)
  if (!term) throw new Error('关键词搜索的记忆键需要非空 keywords。')
  return `search:keyword:${term}`
}

/** 详情记忆键：detail.1688.com/offer/<id>.html → offer:<id>。 */
export function memoryKeyForOffer(urlOrId) {
  const text = String(urlOrId ?? '').trim()
  const match = text.match(/offer\/(\d+)\.html/i) || text.match(/^(\d+)$/)
  if (!match) throw new Error(`不是可识别的 1688 商品详情：${text}`)
  return `offer:${match[1]}`
}

function entryRelativePath(kind, key) {
  if (kind === 'offer') {
    const id = String(key).startsWith('offer:') ? String(key).slice(6) : String(key)
    if (!/^\d+$/.test(id)) throw new Error(`详情记忆键无效：${key}`)
    return path.join('offer', `${id}.json`)
  }
  return path.join('search', `${sha256Hex(key)}.json`)
}

/** 记录年龄（天）；capturedAt 缺失/非法返回 Infinity。 */
export function ageDaysOf(entry, now = Date.now()) {
  const captured = Date.parse(entry?.capturedAt ?? '')
  if (!Number.isFinite(captured)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - captured) / DAY_MS)
}

function git(args, {cwd, timeout = 30000} = {}) {
  return new Promise(resolve => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'},
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(error?.killed),
        })
      },
    )
  })
}

async function clearWorkingTreeExceptGit(dir) {
  let entries = []
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === '.git') continue
    await fsp.rm(path.join(dir, entry), {recursive: true, force: true})
  }
}

function diagOf(cfg) {
  const key = cfg.dir
  if (!gitState.has(key)) {
    gitState.set(key, {lastPullAt: 0, lastPushAt: 0, lastError: null, lastPullResult: null, lastPushResult: null})
  }
  return gitState.get(key)
}

async function commitAll(cfg, message) {
  await git(['add', '-A'], {cwd: cfg.dir})
  const status = await git(['status', '--porcelain'], {cwd: cfg.dir})
  if (!status.stdout.trim()) return {committed: false}
  const result = await git([...GIT_IDENTITY, 'commit', '-m', message], {cwd: cfg.dir, timeout: 60000})
  if (result.code !== 0) throw new Error(`价格记忆提交失败：${(result.stderr || result.stdout || '').trim() || result.code}`)
  return {committed: true}
}

async function pushOnce(cfg, {allowPullRetry = true} = {}) {
  let result = await git(['push', 'origin', `HEAD:refs/heads/${cfg.branch}`], {cwd: cfg.dir, timeout: 120000})
  if (result.code === 0) return {pushed: true, output: (result.stdout || result.stderr || '').trim()}
  if (allowPullRetry) {
    await pullGit(cfg, {force: true, quiet: true}).catch(() => null)
    result = await git(['push', 'origin', `HEAD:refs/heads/${cfg.branch}`], {cwd: cfg.dir, timeout: 120000})
    if (result.code === 0) return {pushed: true, retried: true, output: (result.stdout || result.stderr || '').trim()}
  }
  return {pushed: false, error: (result.stderr || result.stdout || '').trim() || `git push 退出码 ${result.code}`}
}

async function pullGit(cfg, {force = false, quiet = false} = {}) {
  const diag = diagOf(cfg)
  const now = Date.now()
  const interval = Number.isFinite(cfg.pullIntervalMs) ? cfg.pullIntervalMs : DEFAULT_PULL_INTERVAL_MS
  if (!force && now - diag.lastPullAt < interval) return {pulled: false, throttled: true}
  const fetch = await git(['fetch', 'origin', `+refs/heads/${cfg.branch}:refs/remotes/origin/${cfg.branch}`], {
    cwd: cfg.dir,
    timeout: 120000,
  })
  if (fetch.code !== 0) {
    const error = (fetch.stderr || fetch.stdout || '').trim() || `git fetch 退出码 ${fetch.code}`
    diag.lastError = error
    return {pulled: false, error}
  }
  const remoteRef = `refs/remotes/origin/${cfg.branch}`
  const remote = await git(['rev-parse', '--verify', remoteRef], {cwd: cfg.dir})
  if (remote.code !== 0) return {pulled: false, reason: 'remote_branch_missing'}
  const head = await git(['rev-parse', '--verify', 'HEAD'], {cwd: cfg.dir})
  if (head.code !== 0) {
    await git(['checkout', '-B', cfg.branch, remoteRef], {cwd: cfg.dir})
  } else {
    const headIsAncestor = await git(['merge-base', '--is-ancestor', 'HEAD', remoteRef], {cwd: cfg.dir})
    if (headIsAncestor.code === 0) {
      const merge = await git(['merge', '--ff-only', remoteRef], {cwd: cfg.dir, timeout: 60000})
      if (merge.code !== 0) {
        diag.lastError = (merge.stderr || merge.stdout || '').trim()
        return {pulled: false, error: diag.lastError}
      }
    } else {
      const remoteIsAncestor = await git(['merge-base', '--is-ancestor', remoteRef, 'HEAD'], {cwd: cfg.dir})
      if (remoteIsAncestor.code !== 0) {
        const rebase = await git(['rebase', remoteRef], {cwd: cfg.dir, timeout: 120000})
        if (rebase.code !== 0) {
          await git(['rebase', '--abort'], {cwd: cfg.dir})
          diag.lastError = `价格记忆合并冲突：${(rebase.stderr || rebase.stdout || '').trim() || 'rebase 失败'}`
          return {pulled: false, error: diag.lastError}
        }
      }
    }
  }
  diag.lastPullAt = now
  diag.lastPullResult = {pulled: true, at: new Date(now).toISOString()}
  if (!quiet) diag.lastError = null
  return {pulled: true}
}

async function ensureGitRepo(cfg) {
  const version = await git(['--version'])
  if (version.code !== 0) throw new Error('系统未安装 git，无法使用 GitHub 价格记忆；已降级到本地目录。')
  await fsp.mkdir(path.dirname(cfg.dir), {recursive: true})
  if (!fs.existsSync(path.join(cfg.dir, '.git'))) {
    let clone = await git(['clone', '--single-branch', '--branch', cfg.branch, '--depth', '1', cfg.url, cfg.dir], {timeout: 180000})
    if (clone.code !== 0) {
      if (fs.existsSync(cfg.dir)) await fsp.rm(cfg.dir, {recursive: true, force: true})
      clone = await git(['clone', '--depth', '1', cfg.url, cfg.dir], {timeout: 180000})
      if (clone.code !== 0 && !fs.existsSync(path.join(cfg.dir, '.git'))) {
        throw new Error(`无法克隆价格记忆仓库（${cfg.url} #${cfg.branch}）：${(clone.stderr || clone.stdout || '').trim() || clone.code}`)
      }
      const hasBranch = await git(['rev-parse', '--verify', `refs/heads/${cfg.branch}`], {cwd: cfg.dir})
      if (hasBranch.code !== 0) {
        await git(['checkout', '--orphan', cfg.branch], {cwd: cfg.dir})
        await clearWorkingTreeExceptGit(cfg.dir)
      }
    }
  }
  const fetchRef = await git(['config', '--get-all', 'remote.origin.fetch'], {cwd: cfg.dir})
  if (!fetchRef.stdout.trim()) {
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], {cwd: cfg.dir})
  }
  const branchNow = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {cwd: cfg.dir})
  if (branchNow.code !== 0 || branchNow.stdout.trim() !== cfg.branch) {
    const local = await git(['rev-parse', '--verify', `refs/heads/${cfg.branch}`], {cwd: cfg.dir})
    if (local.code === 0) {
      await git(['checkout', cfg.branch], {cwd: cfg.dir})
    } else {
      await git(['fetch', 'origin', `+refs/heads/${cfg.branch}:refs/remotes/origin/${cfg.branch}`], {
        cwd: cfg.dir,
        timeout: 120000,
      }).catch(() => null)
      const remote = await git(['rev-parse', '--verify', `refs/remotes/origin/${cfg.branch}`], {cwd: cfg.dir})
      if (remote.code === 0) {
        await git(['checkout', '-B', cfg.branch, `refs/remotes/origin/${cfg.branch}`], {cwd: cfg.dir})
      } else {
        await git(['checkout', '--orphan', cfg.branch], {cwd: cfg.dir})
        await clearWorkingTreeExceptGit(cfg.dir)
      }
    }
  }
  await fsp.mkdir(path.join(cfg.dir, 'search'), {recursive: true})
  await fsp.mkdir(path.join(cfg.dir, 'offer'), {recursive: true})
  if (!fs.existsSync(path.join(cfg.dir, 'README.md'))) await fsp.writeFile(path.join(cfg.dir, 'README.md'), MEMORY_README, 'utf8')
  const head = await git(['rev-parse', '--verify', 'HEAD'], {cwd: cfg.dir})
  if (head.code !== 0) {
    await commitAll(cfg, 'chore: init price-memory branch')
    await pushOnce(cfg, {allowPullRetry: false})
  } else {
    const status = await git(['status', '--porcelain'], {cwd: cfg.dir})
    if (status.stdout.trim()) {
      await commitAll(cfg, 'chore: init price-memory layout')
      await pushOnce(cfg, {allowPullRetry: false})
    }
  }
  return {kind: 'git', dir: cfg.dir, cfg, degraded: null}
}

async function initLocalStore(cfg, degraded, requestedBackend) {
  const dir = cfg.mirrorDir
  await fsp.mkdir(path.join(dir, 'search'), {recursive: true})
  await fsp.mkdir(path.join(dir, 'offer'), {recursive: true})
  if (!fs.existsSync(path.join(dir, 'README.md'))) await fsp.writeFile(path.join(dir, 'README.md'), MEMORY_README, 'utf8')
  return {kind: 'dir', dir, cfg, degraded: degraded ?? null, requestedBackend: requestedBackend ?? 'dir'}
}

async function openStore(cfg) {
  if (!cfg.enabled) return {kind: 'disabled', dir: null, cfg, degraded: null}
  if (cfg.backend === 'dir') return initLocalStore(cfg, null, 'dir')
  const key = `${cfg.dir}|${cfg.url}|${cfg.branch}`
  if (storeCache.has(key)) return storeCache.get(key)
  const promise = (async () => {
    try {
      return await ensureGitRepo(cfg)
    } catch (error) {
      return initLocalStore(cfg, String(error?.message ?? error), 'git')
    }
  })()
  storeCache.set(key, promise)
  return promise
}

function enqueue(store, task) {
  const previous = writeQueues.get(store.dir) ?? Promise.resolve()
  const next = previous.then(task, task)
  writeQueues.set(store.dir, next.catch(() => null))
  return next
}

async function readEntryFile(store, kind, key) {
  const file = path.join(store.dir, entryRelativePath(kind, key))
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const entry = JSON.parse(raw)
    if (!entry || entry.schemaVersion !== MEMORY_SCHEMA_VERSION || entry.kind !== kind || entry.key !== key) {
      return {entry: null, issue: 'invalid_entry', file}
    }
    return {entry, file}
  } catch (error) {
    if (error?.code === 'ENOENT') return {entry: null, file}
    return {entry: null, issue: 'corrupt_entry', file}
  }
}

async function writeEntry(store, kind, key, entry, {maxAgeDays} = {}) {
  const relative = entryRelativePath(kind, key)
  const file = path.join(store.dir, relative)
  await fsp.mkdir(path.dirname(file), {recursive: true})
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  await fsp.writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, file)
  let push = null
  if (store.kind === 'git') {
    const committed = await commitAll(store.cfg, `memory: ${kind} ${key}`)
    if (committed.committed) push = await enqueuePush(store.cfg)
    else push = {pushed: false, reason: 'no_change'}
  }
  return {stored: true, file, push, ageDays: ageDaysOf(entry, Date.now())}
}

async function enqueuePush(cfg) {
  const diag = diagOf(cfg)
  const now = Date.now()
  const interval = Number.isFinite(cfg.pushIntervalMs) ? cfg.pushIntervalMs : DEFAULT_PUSH_INTERVAL_MS
  if (now - diag.lastPushAt < interval) return {pushed: false, throttled: true, nextPushAt: new Date(diag.lastPushAt + interval).toISOString()}
  const result = await pushOnce(cfg)
  diag.lastPushResult = {...result, at: new Date().toISOString()}
  diag.lastError = result.error ?? null
  if (result.pushed) diag.lastPushAt = now
  return result
}

async function countEntries(store) {
  const counts = {search: 0, offer: 0, total: 0}
  for (const kind of ['search', 'offer']) {
    try {
      const files = await fsp.readdir(path.join(store.dir, kind))
      counts[kind] = files.filter(name => name.endsWith('.json')).length
    } catch {
      counts[kind] = 0
    }
  }
  counts.total = counts.search + counts.offer
  return counts
}

async function pendingPushCount(cfg) {
  const remote = await git(['rev-parse', '--verify', `refs/remotes/origin/${cfg.branch}`], {cwd: cfg.dir})
  if (remote.code !== 0) {
    const count = await git(['rev-list', '--count', 'HEAD'], {cwd: cfg.dir})
    return Number(count.stdout.trim()) || 0
  }
  const count = await git(['rev-list', '--count', `refs/remotes/origin/${cfg.branch}..HEAD`], {cwd: cfg.dir})
  return Number(count.stdout.trim()) || 0
}

/** 缓存判定：只缓存真实成功、非空、非拦截结果。 */
export function isCacheableSearchResult(result) {
  return Boolean(
    result &&
      !result.blocked &&
      Array.isArray(result.candidates) &&
      result.candidates.length > 0 &&
      !result.error,
  )
}

export function isCacheableOfferResult(result) {
  return Boolean(
    result &&
      !result.blocked &&
      !result.error &&
      Array.isArray(result.offers) &&
      result.offers.length > 0 &&
      typeof result.url === 'string' &&
      /detail\.1688\.com\/offer\/\d+\.html/i.test(result.url),
  )
}

/**
 * 读取搜索记忆：
 * 返回 {hit, reason, entry, ageDays, key, backend, dir, ttlDays}。
 * 过期记录 hit=false、reason='expired'，调用方必须重新抓取。
 */
export async function getSearchMemory(options = {}) {
  if (options.useMemory === false) return {hit: false, reason: 'disabled_by_param'}
  if (!memoryEnabled()) return {hit: false, reason: 'memory_disabled'}
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {hit: false, reason: 'memory_disabled'}
  const method = options.method === 'image' ? 'image' : 'keyword'
  let imageBuffer
  if (method === 'image') {
    try {
      imageBuffer = await fsp.readFile(path.resolve(options.imagePath))
    } catch (error) {
      return {hit: false, reason: `image_unreadable: ${error?.message ?? error}`}
    }
  }
  const key = memoryKeyForSearch({method, keywords: options.keywords, imageBuffer})
  const store = await openStore(cfg)
  if (store.kind === 'disabled') return {hit: false, reason: 'memory_disabled'}
  if (store.kind === 'git') await pullGit(cfg).catch(() => null)
  const {entry, issue} = await readEntryFile(store, 'search', key)
  const ttlDays = resolveTtlDays(options.maxAgeDays ?? cfg.ttlDays)
  if (!entry) return {hit: false, reason: issue ?? 'miss', key, backend: store.kind, dir: store.dir, ttlDays}
  const ageDays = ageDaysOf(entry, Date.now())
  if (ageDays > ttlDays) return {hit: false, reason: 'expired', key, entry, ageDays: round2(ageDays), ttlDays, backend: store.kind, dir: store.dir}
  return {hit: true, key, entry, ageDays: round2(ageDays), ttlDays, backend: store.kind, dir: store.dir, degraded: store.degraded ?? null}
}

/** 写入搜索记忆（仅成功且非空的结果）。 */
export async function rememberSearch(options = {}) {
  if (!memoryEnabled()) return {stored: false, reason: 'memory_disabled'}
  const result = options.result
  if (!isCacheableSearchResult(result)) return {stored: false, reason: 'not_cacheable'}
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {stored: false, reason: 'memory_disabled'}
  const method = options.method === 'image' ? 'image' : 'keyword'
  let imageBuffer
  if (method === 'image') {
    try {
      imageBuffer = await fsp.readFile(path.resolve(options.imagePath))
    } catch (error) {
      return {stored: false, reason: `image_unreadable: ${error?.message ?? error}`}
    }
  }
  const key = memoryKeyForSearch({method, keywords: options.keywords, imageBuffer})
  const store = await openStore(cfg)
  if (store.kind !== 'git' && store.kind !== 'dir') return {stored: false, reason: 'memory_disabled'}
  const capturedAt = result.searchedAt ?? result.capturedAt ?? nowIso()
  const entry = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'search',
    key,
    capturedAt,
    storedAt: nowIso(),
    source: {
      method,
      keyword: options.keywords ?? result.keyword ?? null,
      imagePath: method === 'image' ? path.resolve(options.imagePath) : null,
      limit: result.candidates.length,
      sameSpecOnly: options.sameSpecOnly === true,
      backend: store.kind,
    },
    payload: {
      method: result.method ?? method,
      keyword: result.keyword ?? options.keywords ?? null,
      imagePath: method === 'image' ? path.resolve(options.imagePath) : null,
      searchedAt: capturedAt,
      candidates: result.candidates.slice(0, 20),
      nearMisses: Array.isArray(result.nearMisses) ? result.nearMisses.slice(0, 10) : [],
      rawCount: result.rawCount ?? result.candidates.length,
      note: result.note ?? null,
      url: result.url ?? null,
      limit: result.candidates.length,
      sameSpecOnly: options.sameSpecOnly === true,
    },
  }
  const written = await enqueue(store, () => writeEntry(store, 'search', key, entry, {maxAgeDays: cfg.ttlDays}))
  return {stored: true, key, file: written.file, push: written.push, backend: store.kind, dir: store.dir}
}

/** 读取详情记忆；命中后由调用方用当前 skuHint 重新标注 selectedSku。 */
export async function getOfferMemory(options = {}) {
  if (options.useMemory === false) return {hit: false, reason: 'disabled_by_param'}
  if (!memoryEnabled()) return {hit: false, reason: 'memory_disabled'}
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {hit: false, reason: 'memory_disabled'}
  let key
  try {
    key = memoryKeyForOffer(options.url)
  } catch (error) {
    return {hit: false, reason: String(error?.message ?? error)}
  }
  const store = await openStore(cfg)
  if (store.kind === 'disabled') return {hit: false, reason: 'memory_disabled'}
  if (store.kind === 'git') await pullGit(cfg).catch(() => null)
  const {entry, issue} = await readEntryFile(store, 'offer', key)
  const ttlDays = resolveTtlDays(options.maxAgeDays ?? cfg.ttlDays)
  if (!entry) return {hit: false, reason: issue ?? 'miss', key, backend: store.kind, dir: store.dir, ttlDays}
  const ageDays = ageDaysOf(entry, Date.now())
  if (ageDays > ttlDays) return {hit: false, reason: 'expired', key, entry, ageDays: round2(ageDays), ttlDays, backend: store.kind, dir: store.dir}
  return {hit: true, key, entry, ageDays: round2(ageDays), ttlDays, backend: store.kind, dir: store.dir, degraded: store.degraded ?? null}
}

/** 写入详情记忆（仅真实成功、有 SKU/价格的结果）。 */
export async function rememberOffer(options = {}) {
  if (!memoryEnabled()) return {stored: false, reason: 'memory_disabled'}
  const result = options.result
  if (!isCacheableOfferResult(result)) return {stored: false, reason: 'not_cacheable'}
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {stored: false, reason: 'memory_disabled'}
  const key = memoryKeyForOffer(result.url)
  const store = await openStore(cfg)
  if (store.kind !== 'git' && store.kind !== 'dir') return {stored: false, reason: 'memory_disabled'}
  const capturedAt = result.capturedAt ?? nowIso()
  const entry = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'offer',
    key,
    capturedAt,
    storedAt: nowIso(),
    source: {method: 'offer', url: result.url, skuHint: result.specHint ?? null, backend: store.kind},
    payload: {
      url: result.url,
      title: result.title ?? null,
      company: result.company ?? null,
      unit: result.unit ?? null,
      saleNum: result.saleNum ?? null,
      beginNum: result.beginNum ?? null,
      tiers: result.tiers ?? [],
      props: result.props ?? [],
      offers: (result.offers ?? []).slice(0, 80),
      capturedAt,
      domNotes: result.domNotes ?? null,
      source: result.source ?? null,
      specHint: result.specHint ?? null,
    },
  }
  const written = await enqueue(store, () => writeEntry(store, 'offer', key, entry, {maxAgeDays: cfg.ttlDays}))
  return {stored: true, key, file: written.file, push: written.push, backend: store.kind, dir: store.dir}
}

/** 记忆状态：后端、目录、条目数、待推送 commit、降级原因。 */
export async function statusMemory(options = {}) {
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {enabled: false, backend: 'disabled', ttlDays: cfg.ttlDays, stateDir: cfg.stateDir}
  const store = await openStore(cfg)
  const counts = store.kind === 'disabled' ? {search: 0, offer: 0, total: 0} : await countEntries(store)
  const diag = diagOf(cfg)
  let pendingPush = null
  if (store.kind === 'git') {
    try {
      pendingPush = await pendingPushCount(cfg)
    } catch {
      pendingPush = null
    }
  }
  return {
    enabled: true,
    backend: store.kind === 'git' ? 'git' : store.requestedBackend === 'git' ? 'local-fallback' : 'dir',
    requestedBackend: cfg.backend,
    dir: store.dir,
    mirrorDir: cfg.mirrorDir ?? null,
    git: cfg.backend === 'git' ? {url: cfg.url, branch: cfg.branch} : null,
    ttlDays: resolveTtlDays(options.maxAgeDays ?? cfg.ttlDays),
    entries: counts,
    pendingPush,
    degraded: store.degraded ?? null,
    lastPullAt: diag.lastPullResult?.at ?? null,
    lastPushAt: diag.lastPushResult?.at ?? null,
    lastPushResult: diag.lastPushResult ?? null,
    lastError: diag.lastError ?? null,
    checkedAt: nowIso(),
  }
}

/** 列出记忆条目（新→旧），summary 只含轻量字段，不回传整段 payload。 */
export async function listMemory(options = {}) {
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {enabled: false, items: [], ttlDays: cfg.ttlDays}
  const store = await openStore(cfg)
  const kinds = options.kind && options.kind !== 'all' ? [options.kind] : ['search', 'offer']
  const items = []
  for (const kind of kinds) {
    let files = []
    try {
      files = await fsp.readdir(path.join(store.dir, kind))
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.endsWith('.json')) continue
      try {
        const entry = JSON.parse(await fsp.readFile(path.join(store.dir, kind, name), 'utf8'))
        const ageDays = ageDaysOf(entry, Date.now())
        const payload = entry.payload ?? {}
        items.push(
          kind === 'search'
            ? {
                kind,
                key: entry.key,
                capturedAt: entry.capturedAt,
                storedAt: entry.storedAt,
                ageDays: round2(ageDays),
                method: payload.method ?? null,
                keyword: payload.keyword ?? null,
                imagePath: payload.imagePath ?? null,
                candidateCount: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
              }
            : {
                kind,
                key: entry.key,
                capturedAt: entry.capturedAt,
                storedAt: entry.storedAt,
                ageDays: round2(ageDays),
                url: payload.url ?? null,
                title: payload.title ?? null,
                company: payload.company ?? null,
                offerCount: Array.isArray(payload.offers) ? payload.offers.length : 0,
              },
        )
      } catch {
        items.push({kind, key: null, file: name, corrupt: true})
      }
    }
  }
  items.sort((a, b) => String(b.capturedAt ?? '').localeCompare(String(a.capturedAt ?? '')))
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50
  return {
    enabled: true,
    backend: store.kind,
    dir: store.dir,
    ttlDays: resolveTtlDays(options.maxAgeDays ?? cfg.ttlDays),
    total: items.length,
    items: items.slice(0, limit),
  }
}

async function removeEntryFiles(store, files) {
  for (const file of files) {
    try {
      await fsp.unlink(file)
    } catch {}
  }
  let push = null
  if (store.kind === 'git' && files.length > 0) {
    const committed = await commitAll(store.cfg, `memory: prune ${files.length} entr${files.length === 1 ? 'y' : 'ies'}`)
    if (committed.committed) push = await enqueuePush(store.cfg)
  }
  return push
}

/** 删除单条记忆：kind + key（或 url/keywords/imagePath 便捷解析）。 */
export async function forgetMemory(options = {}) {
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {removed: false, reason: 'memory_disabled'}
  let key = options.key
  if (!key && options.url) key = memoryKeyForOffer(options.url)
  if (!key && options.imagePath) {
    const buffer = await fsp.readFile(path.resolve(options.imagePath))
    key = memoryKeyForSearch({method: 'image', imageBuffer: buffer})
  }
  if (!key && options.keywords) key = memoryKeyForSearch({method: 'keyword', keywords: options.keywords})
  if (!key) throw new Error('forget 需要 key，或 url / keywords / imagePath 之一。')
  const kind = options.kind === 'offer' || String(key).startsWith('offer:') ? 'offer' : 'search'
  const store = await openStore(cfg)
  const file = path.join(store.dir, entryRelativePath(kind, key))
  let exists = false
  try {
    await fsp.access(file)
    exists = true
  } catch {}
  if (!exists) return {removed: false, reason: 'not_found', key, kind}
  const push = await enqueue(store, () => removeEntryFiles(store, [file]))
  return {removed: true, key, kind, file, push}
}

/** 清理超过 TTL 的记录。 */
export async function pruneMemory(options = {}) {
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {removed: 0, reason: 'memory_disabled'}
  const store = await openStore(cfg)
  const ttlDays = resolveTtlDays(options.maxAgeDays ?? cfg.ttlDays)
  const expired = []
  const kept = []
  for (const kind of ['search', 'offer']) {
    let files = []
    try {
      files = await fsp.readdir(path.join(store.dir, kind))
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.endsWith('.json')) continue
      const file = path.join(store.dir, kind, name)
      try {
        const entry = JSON.parse(await fsp.readFile(file, 'utf8'))
        if (ageDaysOf(entry, Date.now()) > ttlDays) expired.push(file)
        else kept.push(file)
      } catch {
        expired.push(file)
      }
    }
  }
  const push = await enqueue(store, () => removeEntryFiles(store, expired))
  return {removed: expired.length, kept: kept.length, ttlDays, push, dir: store.dir}
}

/** 清空全部记忆（必须 confirm:true）。 */
export async function clearMemory(options = {}) {
  if (options.confirm !== true) throw new Error('clear 会删除全部价格记忆；确实要清空请传 confirm:true。')
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {removed: 0, reason: 'memory_disabled'}
  const store = await openStore(cfg)
  const files = []
  for (const kind of ['search', 'offer']) {
    try {
      const names = await fsp.readdir(path.join(store.dir, kind))
      for (const name of names) if (name.endsWith('.json')) files.push(path.join(store.dir, kind, name))
    } catch {}
  }
  const push = await enqueue(store, () => removeEntryFiles(store, files))
  return {removed: files.length, push, dir: store.dir}
}

/** 立即 pull + 推送待推 commit（跨机器共用的手动同步入口）。 */
export async function syncMemory(options = {}) {
  const cfg = resolveMemoryConfig(options)
  if (!cfg.enabled) return {enabled: false, reason: 'memory_disabled'}
  const store = await openStore(cfg)
  if (store.kind !== 'git') {
    return {enabled: true, backend: store.kind, synced: false, reason: store.degraded ?? '当前为本地目录后端，无需 git 同步'}
  }
  if (store.degraded) return {enabled: true, backend: 'local-fallback', synced: false, reason: store.degraded}
  const pull = await pullGit(cfg, {force: true})
  const diag = diagOf(cfg)
  let push = {pushed: false, reason: 'nothing_to_push'}
  const pending = await pendingPushCount(cfg).catch(() => 0)
  if (pending > 0) {
    diag.lastPushAt = 0
    push = await pushOnce(cfg)
    diag.lastPushResult = {...push, at: nowIso()}
    if (!push.pushed) diag.lastError = push.error ?? null
  }
  return {
    enabled: true,
    backend: 'git',
    synced: pull.pulled !== false || push.pushed === true,
    pull,
    push,
    pendingPush: await pendingPushCount(cfg).catch(() => null),
    dir: store.dir,
    git: {url: cfg.url, branch: cfg.branch},
  }
}

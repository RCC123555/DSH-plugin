// 零依赖 Chrome DevTools Protocol 客户端。
//
// 只使用 Node 24 内置模块（全局 WebSocket / fetch / node:child_process）。
// 设计目标：让 hardware-quote 插件自己驱动本机 Chrome —— 持久用户目录、复用登录态、
// 新建/导航标签页、页面内求值、截图、轮询等待，全部通过 CDP 完成，不依赖宿主浏览器工具。
import {spawn} from 'node:child_process';
import {closeSync, openSync} from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const DEFAULT_DEBUG_PORT = 19222;

export class CdpError extends Error {
  constructor(message, code = 'cdp_error', details) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function defaultStateDir() {
  const override = process.env.HWQ_STATE_DIR;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), '.dsh', 'hardware-quote');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isInteger = value => Number.isInteger(value) && value > 0 && value < 65536;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

async function httpJson(port, pathname, {method = 'GET', timeout = 2500} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {method, signal: controller.signal});
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${method} ${pathname}`);
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

// Chrome 的 /json/version 只有在调试端口真的可用时才返回带 webSocketDebuggerUrl 的 JSON。
async function probeVersion(port, timeout = 1500) {
  try {
    const version = await httpJson(port, '/json/version', {timeout});
    if (version && typeof version.webSocketDebuggerUrl === 'string') return version;
    return null;
  } catch {
    return null;
  }
}

async function portFree(port, timeout = 500) {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.connect({port, host: '127.0.0.1'});
    const finish = free => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
  });
}

// 调试端口是全局资源：优先用显式端口，其次用上次状态文件里的端口，最后默认端口+顺延。
async function pickPort(preferred) {
  for (let port = preferred; port < preferred + 20; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new CdpError(`调试端口 ${preferred}..${preferred + 19} 全部被占用，无法启动 Chrome`, 'no_free_port');
}

function launchChrome({chromePath, port, userDataDir, extraArgs = []}) {
  const stateDir = path.dirname(userDataDir);
  const logPath = path.join(stateDir, 'chrome-launch.log');
  let stderr = 'ignore';
  let logFd = null;
  try {
    // spawn 的 stdio 需要同步打开的 fd（WriteStream 此刻 fd 还是 null）。
    logFd = openSync(logPath, 'a');
    stderr = logFd;
  } catch {
    stderr = 'ignore';
  }
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(chromePath, args, {detached: true, stdio: ['ignore', stderr, stderr]});
  if (typeof logFd === 'number') {
    try {
      closeSync(logFd);
    } catch {}
  }
  child.unref();
  return {pid: child.pid, logPath, args};
}

/**
 * 启动或复用本机 Chrome 调试实例。
 * @param {{port?:number,userDataDir?:string,chromePath?:string,stateDir?:string,extraArgs?:string[],timeoutMs?:number}} [options]
 * @returns {Promise<{port:number,wsUrl:string,launched:boolean,userDataDir:string,stateDir:string,pid?:number}>}
 */
export async function ensureBrowser(options = {}) {
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : defaultStateDir();
  const userDataDir = options.userDataDir
    ? path.resolve(options.userDataDir)
    : path.join(stateDir, 'chrome-profile');
  const chromePath = options.chromePath || process.env.HWQ_CHROME || DEFAULT_CHROME_PATH;
  const stateFile = path.join(stateDir, 'browser.json');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;
  await fs.mkdir(stateDir, {recursive: true});

  const saved = await readJson(stateFile);
  const tried = new Set();
  const candidates = [options.port, saved?.port, DEFAULT_DEBUG_PORT].filter(isInteger);
  for (const port of candidates) {
    if (tried.has(port)) continue;
    tried.add(port);
    const version = await probeVersion(port);
    if (!version) continue;
    const record = {
      port,
      wsUrl: version.webSocketDebuggerUrl,
      launched: false,
      userDataDir: saved?.port === port && saved?.userDataDir ? saved.userDataDir : userDataDir,
      stateDir,
      chromePath,
      browser: version.Browser,
      reusedAt: new Date().toISOString(),
      launchedAt: saved?.port === port ? saved.launchedAt : undefined,
    };
    await writeJson(stateFile, record);
    return record;
  }

  let port;
  if (isInteger(options.port)) {
    if (!(await portFree(options.port))) {
      throw new CdpError(`指定调试端口 ${options.port} 已被非 Chrome 进程占用`, 'port_in_use');
    }
    port = options.port;
  } else {
    port = await pickPort(saved?.port && isInteger(saved.port) ? saved.port : DEFAULT_DEBUG_PORT);
  }

  const started = launchChrome({chromePath, port, userDataDir, extraArgs: options.extraArgs});
  const deadline = Date.now() + timeoutMs;
  let version = null;
  while (Date.now() < deadline) {
    version = await probeVersion(port);
    if (version) break;
    await sleep(250);
  }
  if (!version) {
    throw new CdpError(
      `Chrome 启动后 ${timeoutMs}ms 内未开放调试端口 ${port}；启动日志：${started.logPath}`,
      'launch_failed',
      {chromePath, userDataDir, args: started.args},
    );
  }
  const record = {
    port,
    wsUrl: version.webSocketDebuggerUrl,
    launched: true,
    userDataDir,
    stateDir,
    chromePath,
    pid: started.pid,
    browser: version.Browser,
    launchedAt: new Date().toISOString(),
  };
  await writeJson(stateFile, record);
  return record;
}

// ---------------------------------------------------------------------------
// CDP 连接
// ---------------------------------------------------------------------------

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.listeners = new Map();
    this.closeHandlers = [];
    ws.addEventListener('message', event => this.#onMessage(event));
    ws.addEventListener('close', () => this.#onClose());
    ws.addEventListener('error', () => {});
  }

  static async connect(wsUrl, {timeout = 10000} = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new CdpError(`连接 CDP WebSocket 超时：${wsUrl}`, 'connect_timeout'));
      }, timeout);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        {once: true},
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new CdpError(`连接 CDP WebSocket 失败：${wsUrl}`, 'connect_failed'));
        },
        {once: true},
      );
    });
    return new Connection(ws);
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new CdpError(`CDP ${pending.method} 失败：${message.error.message}`, message.error.code ?? 'cdp_error', message.error),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      const group = this.listeners.get(message.method);
      if (!group) return;
      for (const listener of [...group]) {
        try {
          listener(message.params ?? {}, message);
        } catch {}
      }
    }
  }

  #onClose() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError(`CDP 连接已关闭（${pending.method} 未返回）`, 'connection_closed'));
    }
    this.pending.clear();
    for (const handler of this.closeHandlers.splice(0)) {
      try {
        handler();
      } catch {}
    }
    this.listeners.clear();
  }

  send(method, params = {}, {timeout = 30000} = {}) {
    if (this.closed) return Promise.reject(new CdpError(`CDP 连接已关闭，无法发送 ${method}`, 'connection_closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP ${method} 超时（${timeout}ms）`, 'timeout'));
      }, timeout);
      this.pending.set(id, {resolve, reject, timer, method});
      try {
        this.ws.send(JSON.stringify({id, method, params}));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`发送 CDP ${method} 失败：${error.message}`, 'send_failed'));
      }
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  onClose(handler) {
    this.closeHandlers.push(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const pageConnections = new Map();

/**
 * 断开本进程缓存的全部页面 WebSocket（不关闭浏览器）。
 * 供脚本/测试收尾，避免 Node 事件循环被调试连接挂住无法退出。
 */
export function disconnectAll() {
  for (const [key, connection] of pageConnections) {
    try {
      connection.close();
    } catch {}
    pageConnections.delete(key);
  }
  return {closed: true};
}

async function findTarget(port, targetId) {
  const list = await httpJson(port, '/json/list');
  if (!Array.isArray(list)) return null;
  return list.find(item => item.id === targetId) ?? null;
}

/** 获取（并缓存）某个标签页的 CDP 连接，供低层 sendCommand / 事件订阅使用。 */
export async function getConnection(port, targetId) {
  const key = `${port}:${targetId}`;
  const cached = pageConnections.get(key);
  if (cached && !cached.closed) return cached;
  const target = await findTarget(port, targetId);
  if (!target) throw new CdpError(`找不到调试目标 ${targetId}（标签页可能已关闭）`, 'target_not_found');
  if (!target.webSocketDebuggerUrl) throw new CdpError(`目标 ${targetId} 没有 webSocketDebuggerUrl`, 'target_not_found');
  const connection = await Connection.connect(target.webSocketDebuggerUrl);
  connection.onClose(() => {
    if (pageConnections.get(key) === connection) pageConnections.delete(key);
  });
  pageConnections.set(key, connection);
  return connection;
}

async function evaluateOn(connection, expression, {timeout = 30000, awaitPromise = true} = {}) {
  const result = await connection.send(
    'Runtime.evaluate',
    {
      expression: `(() => (${expression}))()`,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    },
    {timeout},
  );
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const text = details.exception?.description ?? details.text ?? '未知页面异常';
    throw new CdpError(`页面执行异常：${text}`, 'evaluate_exception', {
      expression: String(expression).slice(0, 300),
    });
  }
  return result.result?.value;
}

/** 列出当前所有标签页（page 类型）。 */
export async function listTargets(port) {
  const list = await httpJson(port, '/json/list');
  if (!Array.isArray(list)) return [];
  return list
    .filter(item => item.type === 'page')
    .map(item => ({targetId: item.id, url: item.url, title: item.title, wsUrl: item.webSocketDebuggerUrl}));
}

/** 打开一个新标签页；返回 {targetId,url,wsUrl}。 */
export async function openTarget(port, url = 'about:blank') {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  let response;
  try {
    // 新版 Chrome 要求 PUT；老版本只支持 GET，这里两种都试。
    response = await fetch(endpoint, {method: 'PUT', signal: AbortSignal.timeout(5000)});
    if (response.status === 404 || response.status === 405) {
      response = await fetch(endpoint, {signal: AbortSignal.timeout(5000)});
    }
  } catch (error) {
    throw new CdpError(`打开标签页失败（${port}）：${error.message}`, 'open_target_failed');
  }
  if (!response.ok) {
    throw new CdpError(`打开标签页失败：HTTP ${response.status} ${url}`, 'open_target_failed');
  }
  const target = await response.json();
  if (!target?.id) throw new CdpError(`打开标签页失败：返回缺少 id（${url}）`, 'open_target_failed');
  return {targetId: target.id, url: target.url ?? url, wsUrl: target.webSocketDebuggerUrl};
}

/** 关闭标签页（容错：已关闭视为成功）。 */
export async function closeTarget(port, targetId) {
  try {
    await httpJson(port, `/json/close/${targetId}`, {timeout: 5000});
    pageConnections.get(`${port}:${targetId}`)?.close();
    pageConnections.delete(`${port}:${targetId}`);
    return {closed: true, targetId};
  } catch {
    return {closed: false, targetId};
  }
}

/** 在页面上下文执行表达式并返回可序列化值。会等待异步表达式结果。 */
export async function evaluate(port, targetId, expression, options = {}) {
  const connection = await getConnection(port, targetId);
  return evaluateOn(connection, expression, options);
}

/** 发送任意 CDP 命令（给高级调用方/事件订阅使用）。 */
export async function sendCommand(port, targetId, method, params = {}, options = {}) {
  const connection = await getConnection(port, targetId);
  return connection.send(method, params, options);
}

async function waitDocumentReady(connection, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const state = await evaluateOn(connection, `({href: location.href, state: document.readyState})`);
      last = state;
      if (state && state.href && state.href !== 'about:blank' && (state.state === 'complete' || state.state === 'interactive')) {
        return state;
      }
    } catch {
      // 导航过程中执行上下文会被销毁，重试即可。
    }
    await sleep(200);
  }
  return last ?? {href: '', state: 'unknown'};
}

/** 导航并等待文档就绪；返回 {url,title,readyState}。 */
export async function navigate(port, targetId, url, {timeout = 30000, settleMs = 250} = {}) {
  const connection = await getConnection(port, targetId);
  try {
    await connection.send('Page.enable', {}, {timeout: 5000});
  } catch {}
  const result = await connection.send('Page.navigate', {url}, {timeout: 10000});
  if (result.errorText) {
    throw new CdpError(`导航失败（${url}）：${result.errorText}`, 'navigate_failed');
  }
  await waitDocumentReady(connection, timeout);
  if (settleMs > 0) await sleep(settleMs);
  return pageInfo(port, targetId);
}

/** 读取当前页面的 url / title / readyState。 */
export async function pageInfo(port, targetId) {
  const value = await evaluate(port, targetId, `({href: location.href, title: document.title, readyState: document.readyState})`);
  return {
    url: typeof value?.href === 'string' ? value.href : '',
    title: typeof value?.title === 'string' ? value.title : '',
    readyState: typeof value?.readyState === 'string' ? value.readyState : '',
  };
}

/** 导航 + 读取页面信息 + 可选截图，返回可写入证据的观察记录。 */
export async function captureNavigate(port, targetId, url, {timeout = 30000, screenshotPath = null} = {}) {
  await navigate(port, targetId, url, {timeout});
  const info = await pageInfo(port, targetId);
  const capturedAt = new Date().toISOString();
  let shot = null;
  if (screenshotPath) {
    await screenshot(port, targetId, screenshotPath);
    shot = screenshotPath;
  }
  return {...info, capturedAt, screenshot: shot};
}

/** 轮询等待页面表达式首次返回真值；超时抛错。 */
export async function waitFor(port, targetId, expression, {timeout = 15000, interval = 300} = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(port, targetId, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new CdpError(`waitFor 超时（${timeout}ms）：${String(expression).slice(0, 200)}`, 'wait_timeout', {
    lastError: lastError?.message,
  });
}

/** 截取当前可视区域到 PNG 文件。 */
export async function screenshot(port, targetId, filePath) {
  const result = await sendCommand(port, targetId, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (!result?.data) throw new CdpError('截图失败：CDP 未返回图像数据', 'screenshot_failed');
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, Buffer.from(result.data, 'base64'));
  return filePath;
}

/** 读取标签页可见的 Cookie 元数据（调用方只能看域名/名称，不得导出值）。 */
export async function getCookies(port, targetId, urls) {
  const params = Array.isArray(urls) && urls.length ? {urls} : {};
  const result = await sendCommand(port, targetId, 'Network.getCookies', params);
  return Array.isArray(result?.cookies) ? result.cookies : [];
}

/** 关闭由 ensureBrowser 启动/复用的 Chrome，并清理状态文件。 */
export async function closeBrowser(port, options = {}) {
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : defaultStateDir();
  const stateFile = path.join(stateDir, 'browser.json');
  const saved = await readJson(stateFile);
  const targetPort = Number.isInteger(port) ? port : saved?.port;
  if (!Number.isInteger(targetPort)) return {closed: false, reason: 'unknown_port'};

  const version = await probeVersion(targetPort);
  if (version?.webSocketDebuggerUrl) {
    try {
      const connection = await Connection.connect(version.webSocketDebuggerUrl, {timeout: 5000});
      try {
        await connection.send('Browser.close', {}, {timeout: 3000});
      } catch {
        // Browser.close 常常在关闭前不返回响应，属正常。
      } finally {
        connection.close();
      }
    } catch {
      // 连接失败时继续等待端口消失即可。
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!(await probeVersion(targetPort))) break;
      await sleep(200);
    }
  }
  if (saved?.port === targetPort) {
    try {
      await fs.unlink(stateFile);
    } catch {}
  }
  for (const key of [...pageConnections.keys()]) {
    if (key.startsWith(`${targetPort}:`)) {
      pageConnections.get(key)?.close();
      pageConnections.delete(key);
    }
  }
  const stillRunning = Boolean(await probeVersion(targetPort));
  return {closed: !stillRunning, port: targetPort, stillRunning};
}

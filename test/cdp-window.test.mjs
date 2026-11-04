// hardware-quote · 后台窗口策略测试
//
// 覆盖纯逻辑：窗口模式解析、后台启动参数、空闲阈值判定、PowerShell 输出解析；
// 以及 Windows 上的真实 GetLastInputInfo 集成（失败只允许返回 null，不抛）。
// 不启动浏览器，不改变当前 Chrome 窗口状态。
//
// 跑法：
//   node --test test/cdp-window.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WINDOW_MODES,
  DEFAULT_SURFACE_IDLE_MS,
  resolveWindowMode,
  resolveIdleThreshold,
  windowLaunchArgs,
  parseIdleMs,
  shouldSurfaceWindow,
  getIdleMs,
} from '../lib/cdp.mjs';

const withEnv = (name, value, fn) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
};

test('windowLaunchArgs：后台/自动模式加最小化与防降频参数，visible 不加窗口参数', () => {
  for (const mode of ['background', 'auto']) {
    const args = windowLaunchArgs(mode);
    assert.ok(args.includes('--window-position=-32000,-32000'), `${mode} 应屏外启动`);
    assert.ok(args.includes('--window-size=1280,900'));
    assert.ok(args.includes('--start-minimized'));
    assert.ok(args.includes('--disable-backgrounding-occluded-windows'));
    assert.ok(args.includes('--disable-renderer-backgrounding'));
    assert.ok(args.includes('--disable-background-timer-throttling'));
  }
  assert.deepEqual(windowLaunchArgs('visible'), []);
});

test('windowLaunchArgs：未知模式按 auto 处理，绝不会静默变成可见', () => {
  assert.deepEqual(windowLaunchArgs('nonsense'), windowLaunchArgs('auto'));
});

test('resolveWindowMode：默认 auto，大小写/空格容错，非法值回 auto，HWQ_WINDOW 可覆盖', () => {
  withEnv('HWQ_WINDOW', undefined, () => {
    assert.equal(resolveWindowMode(), 'auto');
    assert.equal(resolveWindowMode(''), 'auto');
    assert.equal(resolveWindowMode(' VISIBLE '), 'visible');
    assert.equal(resolveWindowMode('Background'), 'background');
    assert.equal(resolveWindowMode('nonsense'), 'auto');
    assert.equal(resolveWindowMode(undefined), 'auto');
  });
  withEnv('HWQ_WINDOW', 'background', () => {
    assert.equal(resolveWindowMode(), 'background');
    assert.equal(resolveWindowMode('visible'), 'visible', '显式参数优先于环境变量');
  });
  assert.deepEqual(WINDOW_MODES, ['auto', 'background', 'visible']);
});

test('resolveIdleThreshold：默认 120s，env 与显式值可调，非法值回默认', () => {
  withEnv('HWQ_SURFACE_IDLE_MS', undefined, () => {
    assert.equal(resolveIdleThreshold(), DEFAULT_SURFACE_IDLE_MS);
    assert.equal(resolveIdleThreshold(5000), 5000);
    assert.equal(resolveIdleThreshold(0), 0);
    assert.equal(resolveIdleThreshold('abc'), DEFAULT_SURFACE_IDLE_MS);
    assert.equal(resolveIdleThreshold(-1), DEFAULT_SURFACE_IDLE_MS);
  });
  withEnv('HWQ_SURFACE_IDLE_MS', '3000', () => {
    assert.equal(resolveIdleThreshold(), 3000);
    assert.equal(resolveIdleThreshold(4000), 4000);
  });
});

test('parseIdleMs：只接受非负整数开头，其余一律 null', () => {
  assert.equal(parseIdleMs('16359\r\n'), 16359);
  assert.equal(parseIdleMs(' 203 '), 203);
  assert.equal(parseIdleMs('0'), 0);
  assert.equal(parseIdleMs(''), null);
  assert.equal(parseIdleMs('   '), null);
  assert.equal(parseIdleMs('abc'), null);
  assert.equal(parseIdleMs('-5'), null);
  assert.equal(parseIdleMs(null), null);
  assert.equal(parseIdleMs(undefined), null);
});

test('shouldSurfaceWindow：用户正在用时绝不置前，读不到空闲时间也不置前', () => {
  withEnv('HWQ_SURFACE_IDLE_MS', undefined, () => {
    assert.equal(shouldSurfaceWindow('auto', 0), false);
    assert.equal(shouldSurfaceWindow('auto', 1000), false);
    assert.equal(shouldSurfaceWindow('auto', DEFAULT_SURFACE_IDLE_MS - 1), false);
    assert.equal(shouldSurfaceWindow('auto', DEFAULT_SURFACE_IDLE_MS), true);
    assert.equal(shouldSurfaceWindow('auto', 130000), true);
    assert.equal(shouldSurfaceWindow('auto', null), false);
    assert.equal(shouldSurfaceWindow('auto', undefined), false);
    assert.equal(shouldSurfaceWindow('auto', Number.NaN), false);
  });
  withEnv('HWQ_SURFACE_IDLE_MS', undefined, () => {
    assert.equal(shouldSurfaceWindow('background', 9999999), false);
    assert.equal(shouldSurfaceWindow('visible', 0), true);
    assert.equal(shouldSurfaceWindow('visible', null), true, 'visible 模式由用户显式选择，允许直接置前');
    assert.equal(shouldSurfaceWindow('auto', 6000, 5000), true);
    assert.equal(shouldSurfaceWindow('auto', 4000, 5000), false);
  });
  withEnv('HWQ_SURFACE_IDLE_MS', '2000', () => {
    assert.equal(shouldSurfaceWindow('auto', 2500), true, 'env 阈值应生效');
  });
});

test('getIdleMs：非负毫秒数或 null（不抛错）', {skip: process.platform !== 'win32'}, async () => {
  const idle = await getIdleMs({maxAgeMs: 0, timeoutMs: 8000});
  assert.ok(idle === null || (Number.isFinite(idle) && idle >= 0), `getIdleMs 应返回非负毫秒数或 null，实际 ${idle}`);
  if (idle !== null) assert.ok(idle < 7 * 24 * 3600 * 1000, `空闲时间不应超过一周，实际 ${idle}`);
});

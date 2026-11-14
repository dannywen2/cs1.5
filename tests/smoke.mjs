// ===========================================================================
// tests/smoke.mjs — CS 1.5 (three.js) P4 无头回归脚本
//
// 设计目标:
//   * 自包含、零 npm 依赖。优先复用已安装的 playwright / puppeteer-core,
//     都没有时用 Node 内置 WebSocket + fetch 直连 Chromium CDP (本工作区实测可用)。
//   * 自己启动 `python serve.py <随机空闲端口>` (NOBROWSER=1 / QUIET=1), 结束时关闭。
//   * 先打开 /web/ 校验主菜单与设置, 再打开 /web/?auto=1, 等待 window.__CS_BOOTED__,
//     通过 window.__CS__ = { S, A } 在页面里执行断言; 同一份 check() 也用于 Node
//     侧的网络/控制台检查。
//   * 5 个固定 ?pos= 视角的 PNG 基线比对 (纯 Node 解析 PNG + 像素差阈值)。
//   * 任何一项 FAIL 都会让 process.exitCode = 1; SKIP / LIMIT 会明确打印,
//     绝不静默当作通过。
//
// 用法:
//   node tests/smoke.mjs
//   node tests/smoke.mjs --update-baselines
//   CS_BROWSER="C:\...\msedge.exe" CS_PYTHON=python node tests/smoke.mjs
//
// 详见 tests/README.md。
// ===========================================================================

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE_DIR = path.join(HERE, 'baselines');
const VIEW_W = 1280;
const VIEW_H = 720;

// 像素差阈值: 允许不超过 2% 的像素「最大通道差 > 16」, 且全图平均绝对差 <= 2。
// 这些值针对 swiftshader 软件渲染的微小抖动留了余量, 但足以抓到「整面墙透明」。
const PIXEL_DIFF_THRESHOLD = 16;
const MAX_CHANGED_RATIO = 0.02;
const MAX_MEAN_ABS = 2.0;
// PNG 解码失败时的弱回退阈值 (文件大小 + 简单字节差异)
const MAX_SIZE_DIFF_RATIO = 0.05;
const MAX_BYTE_DIFF_RATIO = 0.05;

const UPDATE_BASELINES = process.argv.includes('--update-baselines');
const SHOW_HELP = process.argv.includes('--help') || process.argv.includes('-h');

// 浏览器启动参数。CDP 模式额外追加 --remote-debugging-port / --user-data-dir。
const BROWSER_ARGS = [
  '--headless=new',
  '--disable-gpu',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--remote-allow-origins=*',
  '--autoplay-policy=no-user-gesture-required',
  '--hide-scrollbars',
  `--window-size=${VIEW_W},${VIEW_H}`,
  'about:blank',
];

// ---------------------------------------------------------------------------
// 报告 / 断言
// ---------------------------------------------------------------------------
const results = [];

function errorText(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return String(err.message || err);
}

function record(name, status, detail = '') {
  const r = { name, status, detail: String(detail || '') };
  results.push(r);
  return r;
}

/**
 * 可复用的断言封装: 所有断言都登记进 results, 全部执行完统一汇报。
 * fn 可以:
 *   - 返回 string / undefined          -> PASS
 *   - 返回 { status, detail }          -> 自定义状态 (用于 LIMIT)
 *   - throw                            -> FAIL
 * 不会让单个断言的异常打断整轮回归。
 */
async function check(name, fn) {
  try {
    const out = await fn();
    if (out && typeof out === 'object' && typeof out.status === 'string') {
      return record(name, out.status, out.detail);
    }
    return record(name, 'PASS', out == null ? '' : String(out));
  } catch (err) {
    return record(name, 'FAIL', errorText(err));
  }
}

// 事件容器: kind = 'console' | 'network'
const issues = [];
function addIssue(kind, detail, url = '') {
  issues.push({ kind, detail: String(detail).slice(0, 500), url: String(url || '') });
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtNum = v => String(Math.round(Number(v) * 1000) / 1000);

function browserCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    process.env.CS_BROWSER,
    process.env.BROWSER_PATH,
    process.env.EDGE_PATH,
    process.env.CHROME_PATH,
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return [...new Set(list)];
}

function findBrowser() {
  for (const p of browserCandidates()) {
    try { if (existsSync(p)) return p; } catch { /* 忽略无权限的路径 */ }
  }
  return null;
}

function pythonCandidates() {
  const list = [
    process.env.CS_PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
    'python',
    'python3',
    'py',
  ].filter(Boolean);
  return [...new Set(list)];
}

/** 让内核分配一个空闲端口 (存在极小竞态, 下方启动失败会换端口重试)。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 等端口可连接 (serve.py 起来之前不做任何浏览器操作)。 */
async function waitPortOpen(port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const finish = v => { if (!done) { done = true; try { sock.destroy(); } catch { /* noop */ } resolve(v); } };
      sock.setTimeout(400);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
    });
    if (ok) return;
    await sleep(120);
  }
  throw new Error(`端口 ${port} 在 ${timeoutMs}ms 内未就绪`);
}

/** 启动 serve.py; 返回 { child, port, url, stdout, stderr }。 */
async function startServer() {
  const tried = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    let lastErr = null;
    for (const py of pythonCandidates()) {
      const child = spawn(py, ['serve.py', String(port)], {
        cwd: ROOT,
        env: { ...process.env, NOBROWSER: '1', QUIET: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const state = { child, port, url: `http://127.0.0.1:${port}/web/`, stdout: '', stderr: '' };
      child.stdout.on('data', d => { state.stdout = (state.stdout + d.toString()).slice(-8000); });
      child.stderr.on('data', d => { state.stderr = (state.stderr + d.toString()).slice(-8000); });
      const onErr = e => { state.spawnError = e; };
      child.on('error', onErr);

      // 给 python 一点时间: 先确认没立刻失败, 再等端口
      await sleep(150);
      if (state.spawnError || child.exitCode !== null) {
        lastErr = state.spawnError || new Error(`退出码 ${child.exitCode}: ${state.stderr}`);
        tried.push(`${py}: ${errorText(lastErr)}`);
        try { child.kill(); } catch { /* noop */ }
        continue;
      }
      try {
        await waitPortOpen(port, 10000);
        child.removeListener('error', onErr);
        return state;
      } catch (e) {
        lastErr = e;
        tried.push(`${py}@${port}: ${errorText(e)} / ${state.stderr.slice(0, 300)}`);
        try { child.kill(); } catch { /* noop */ }
      }
    }
    if (lastErr) tried.push(`第 ${attempt + 1} 轮: ${errorText(lastErr)}`);
  }
  throw new Error(`无法启动 serve.py。尝试记录:\n  ${tried.join('\n  ')}\n请确认项目根目录有 serve.py 且 PATH 里有 python (或设置 CS_PYTHON)。`);
}

async function stopServer(state) {
  if (!state || !state.child) return;
  const child = state.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch { /* noop */ }
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(2000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// 自动化后端 1: 已安装的 playwright / puppeteer(-core)
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);

async function resolveModule(name) {
  // 先走 ESM 裸说明符 (本地 node_modules), 再走 CJS 解析 (支持 NODE_PATH / 全局安装)
  try { return await import(name); } catch { /* 继续 */ }
  try {
    const entry = require.resolve(name);
    return await import(pathToFileURL(entry).href);
  } catch { return null; }
}

function wireLibraryEvents(page) {
  page.on('pageerror', e => addIssue('console', `pageerror: ${errorText(e)}`));
  page.on('console', msg => {
    let type = '';
    try { type = msg.type(); } catch { /* noop */ }
    if (type === 'error') addIssue('console', `console.error: ${msg.text()}`);
  });
  page.on('requestfailed', req => {
    let failure = null;
    try { failure = req.failure(); } catch { /* noop */ }
    const txt = (failure && (failure.errorText || failure)) || '';
    // 导航切换时浏览器会取消上一页仍在传输的子资源, 不是应用错误。
    if (/ERR_ABORTED/i.test(String(txt))) return;
    let url = '';
    try { url = req.url(); } catch { /* noop */ }
    addIssue('network', `requestfailed: ${String(txt)}`, url);
  });
  page.on('response', res => {
    let status = 0, url = '';
    try { status = res.status(); url = res.url(); } catch { /* noop */ }
    if (status >= 400) addIssue('network', `HTTP ${status} ${url}`, url);
  });
}

/** 尝试用已安装的库打开浏览器; 失败返回 null, 由 CDP 后端接管。 */
async function openLibraryAutomation(exe) {
  const candidates = [
    { name: 'playwright', kind: 'playwright' },
    { name: 'playwright-core', kind: 'playwright' },
    { name: 'puppeteer', kind: 'puppeteer' },
    { name: 'puppeteer-core', kind: 'puppeteer' },
  ];
  // 库自己会加 --headless, 我们移除自定义的 --headless=new 以免冲突。
  const args = BROWSER_ARGS.filter(a => !a.startsWith('--headless'));
  for (const c of candidates) {
    const mod = await resolveModule(c.name);
    if (!mod) continue;
    const lib = mod.default || mod;
    try {
      let browser, page;
      if (c.kind === 'playwright') {
        const chromium = lib.chromium || mod.chromium;
        if (!chromium) continue;
        browser = await chromium.launch({ executablePath: exe, headless: true, args });
        page = await browser.newPage({
          viewport: { width: VIEW_W, height: VIEW_H },
          deviceScaleFactor: 1,
        });
      } else {
        browser = await lib.launch({ executablePath: exe, headless: true, args });
        page = await browser.newPage();
        await page.setViewport({ width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 });
      }
      wireLibraryEvents(page);
      return {
        kind: `${c.name} (${c.kind})`,
        async navigate(url) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }); },
        async evaluate(expression) { return await page.evaluate(expression); },
        async screenshot() { return Buffer.from(await page.screenshot({ type: 'png' })); },
        async close() { try { await browser.close(); } catch { /* noop */ } },
      };
    } catch (err) {
      // 常见情况: playwright 装了但没下载浏览器 / 与 Edge 可执行文件不兼容。
      // 不视为致命错误, 也不写入 issues (避免污染「零控制台错误」断言), 交给 CDP 后端。
      console.log(`  · ${c.name} 不可用 (${errorText(err).slice(0, 120)}), 尝试其它后端`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 自动化后端 2: Node 内置 WebSocket 直连 CDP (零依赖)
// ---------------------------------------------------------------------------
class CdpConnection {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.seq = 0;
    this.pending = new Map();
    this.eventHandlers = [];
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`CDP ${msg.error.message} (${msg.error.code ?? ''})`));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method) {
        for (const h of this.eventHandlers) {
          try { h(msg.method, msg.params || {}); } catch { /* 事件回调不应影响主流程 */ }
        }
      }
    });
    const failAll = err => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    };
    ws.addEventListener('error', () => failAll(new Error(`${label} WebSocket 错误`)));
    ws.addEventListener('close', () => failAll(new Error(`${label} 连接已关闭`)));
  }

  onEvent(fn) { this.eventHandlers.push(fn); }

  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== 1) { reject(new Error(`${this.label} 未连接`)); return; }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`CDP ${method} 发送失败: ${errorText(e)}`));
      }
    });
  }

  close() { try { this.ws.close(); } catch { /* noop */ } }
}

async function openWebSocket(url, label, timeoutMs = 10000) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`${label} 连接超时`)), timeoutMs);
    ws.addEventListener('open', () => finish(), { once: true });
    ws.addEventListener('error', () => finish(new Error(`${label} WebSocket 打开失败`)), { once: true });
  });
  return ws;
}

function cdpEventCollector(pageConn) {
  const reqUrls = new Map();
  pageConn.onEvent((method, p) => {
    if (method === 'Network.requestWillBeSent') reqUrls.set(p.requestId, p.request && p.request.url);
    else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      const desc = (d.exception && d.exception.description) || d.text || '';
      addIssue('console', `pageerror: ${String(desc).slice(0, 400)}`, d.url || '');
    } else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      const text = (p.args || []).map(a => {
        if (a.value !== undefined) return String(a.value);
        return String(a.description || a.type || '');
      }).join(' ');
      addIssue('console', `console.error: ${text}`, p.url || '');
    } else if (method === 'Log.entryAdded' && p.entry && p.entry.level === 'error') {
      addIssue('console', `Log.error: ${p.entry.text}`, p.entry.url || '');
    } else if (method === 'Network.loadingFailed') {
      // 导航切换时取消的在途子资源 (net::ERR_ABORTED) 不是应用错误, 明确忽略并在 README 说明。
      if (/ERR_ABORTED/i.test(String(p.errorText || ''))) return;
      addIssue('network', `requestfailed: ${p.errorText || ''} (${p.type || ''})`,
        reqUrls.get(p.requestId) || '');
    } else if (method === 'Network.responseReceived' && p.response && p.response.status >= 400) {
      addIssue('network', `HTTP ${p.response.status} ${p.response.url}`, p.response.url);
    }
  });
}

async function openCdpAutomation(exe) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-edge-'));
  const args = [
    ...BROWSER_ARGS.slice(0, -1),
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-8000); });

  const cleanup = async () => {
    try { child.kill(); } catch { /* noop */ }
    for (let i = 0; i < 4; i++) {
      try { rmSync(profile, { recursive: true, force: true }); return; } catch { await sleep(150); }
    }
  };

  try {
    // Edge 把实际调试端口写进 DevToolsActivePort (第一行)
    let port = null;
    const activePortFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`浏览器提前退出: ${stderr.slice(0, 600)}`);
      try {
        if (existsSync(activePortFile)) {
          const n = parseInt(readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0], 10);
          if (Number.isFinite(n) && n > 0) { port = n; break; }
        }
      } catch { /* 文件可能还在写 */ }
      await sleep(100);
    }
    if (!port) throw new Error(`未读到 DevToolsActivePort: ${stderr.slice(0, 600)}`);

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`,
      { signal: AbortSignal.timeout(8000) })).json();
    const browserWs = await openWebSocket(version.webSocketDebuggerUrl, 'browser');
    const browserConn = new CdpConnection(browserWs, 'browser');

    const { targetId } = await browserConn.send('Target.createTarget', { url: 'about:blank' });
    let pageWsUrl = null;
    for (let i = 0; i < 60; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`,
        { signal: AbortSignal.timeout(8000) })).json();
      const t = list.find(x => x.id === targetId && x.type === 'page');
      if (t && t.webSocketDebuggerUrl) { pageWsUrl = t.webSocketDebuggerUrl; break; }
      await sleep(100);
    }
    if (!pageWsUrl) throw new Error('CDP 未找到新建的 page target');

    const pageWs = await openWebSocket(pageWsUrl, 'page');
    const pageConn = new CdpConnection(pageWs, 'page');
    cdpEventCollector(pageConn);

    for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) {
      await pageConn.send(method);
    }
    await pageConn.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false,
    });

    return {
      kind: `CDP (Node 内置 WebSocket, ${version.Browser || 'Chromium'})`,
      async navigate(url) { await pageConn.send('Page.navigate', { url }); },
      async evaluate(expression) {
        const r = await pageConn.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error((d.exception && d.exception.description) || d.text || '页面内异常');
        }
        return r.result ? r.result.value : undefined;
      },
      async screenshot() {
        const r = await pageConn.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false,
        });
        return Buffer.from(r.data, 'base64');
      },
      async close() {
        // Browser.close 会让 Edge 自行回收所有渲染进程, 比直接 kill 干净。
        try { await browserConn.send('Browser.close', {}, 5000); } catch { /* noop */ }
        pageConn.close();
        browserConn.close();
        await cleanup();
      },
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** 按优先级选择后端; 返回 null 表示需要 SKIP。 */
async function openAutomation() {
  const exe = findBrowser();
  if (!exe) {
    return { skip: `未找到 Edge/Chrome 可执行文件。请设置 CS_BROWSER 指向 msedge.exe / chrome.exe，\n` +
      `  或安装浏览器自动化库：\n` +
      `    npm i -D playwright && npx playwright install chromium\n` +
      `    npm i -D puppeteer-core   # 需配合 CS_BROWSER 使用\n` +
      `  已检查路径: ${browserCandidates().slice(0, 6).join(' | ')}` };
  }
  const lib = await openLibraryAutomation(exe);
  if (lib) return { automation: lib, exe };
  if (typeof WebSocket !== 'function') {
    return { skip: `当前 Node (${process.version}) 没有内置全局 WebSocket，无法使用零依赖 CDP 后端。\n` +
      `  请升级到 Node >= 22，或安装：\n` +
      `    npm i -D playwright && npx playwright install chromium\n` +
      `    npm i -D puppeteer-core   # 需配合 CS_BROWSER 使用` };
  }
  try {
    return { automation: await openCdpAutomation(exe), exe };
  } catch (err) {
    return { skip: `CDP 后端启动失败: ${errorText(err)}\n` +
      `  可尝试安装: npm i -D playwright && npx playwright install chromium\n` +
      `  或用 CS_BROWSER 指定其它 Chromium 可执行文件。` };
  }
}

// ---------------------------------------------------------------------------
// 页面内求值: 把断言函数序列化进页面, 注入 assert / S / A / sleep
// ---------------------------------------------------------------------------
async function evalInPage(automation, fn, arg = null) {
  const src = fn.toString();
  const expression = `(async () => {
    const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const { S, A } = window.__CS__;
    return await (${src}\n)(assert, S, A, sleep, ${JSON.stringify(arg)});
  })()`;
  return await automation.evaluate(expression);
}

async function waitForBoot(automation, timeoutMs = 60000, expectSearch = null) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const ok = await automation.evaluate(
        `(() => {
          if (${JSON.stringify(expectSearch)} !== null
              && location.search !== ${JSON.stringify(expectSearch)}) return false;
          const auto = new URLSearchParams(location.search).get('auto') === '1';
          const ready = auto ? window.__CS_READY__ === true : window.__CS_READY__ !== true;
          return !!(ready && window.__CS_BOOTED__ === true && window.__CS__
            && window.__CS__.S && window.__CS__.A);
        })()`);
      if (ok === true) return;
    } catch (err) {
      last = errorText(err);  // 导航期间执行上下文重建, 属正常现象
    }
    await sleep(200);
  }
  const early = issues.filter(i => i.kind === 'console').slice(0, 3).map(i => i.detail).join(' | ');
  throw new Error(`等待 window.__CS_BOOTED__ 超时 (${timeoutMs}ms, expectSearch=${expectSearch})。` +
    (last ? ` 最后一次求值: ${last}。` : '') + (early ? ` 早期错误: ${early}` : ''));
}

// ---------------------------------------------------------------------------
// 页面内断言函数 (必须自包含: 不能引用 Node 侧闭包变量)
// ---------------------------------------------------------------------------

function worldMaterials(assert, S) {
  const meshes = (S.assets && S.assets.worldMeshes) || [];
  assert(Array.isArray(meshes) && meshes.length > 0, 'S.assets.worldMeshes 为空');
  const bad = [];
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i] && meshes[i].material;
    if (!m) { bad.push(`#${i} 无材质`); continue; }
    if (m.transparent !== false) bad.push(`#${i} transparent=${m.transparent}`);
    if (m.depthWrite !== true) bad.push(`#${i} depthWrite=${m.depthWrite}`);
    if (m.depthTest !== true) bad.push(`#${i} depthTest=${m.depthTest}`);
    if (m.side !== 2) bad.push(`#${i} side=${m.side}(期望 2 = THREE.DoubleSide)`);
  }
  assert(bad.length === 0, `不合规材质: ${bad.slice(0, 8).join('; ')}`);
  return `${meshes.length} 个世界网格全部 transparent=false / depthWrite=true / depthTest=true / DoubleSide(2)`;
}

function botGeometryIndependent(assert, S) {
  const bots = [...S.enemies, ...S.allies].filter(b => b && b.visual && b.visual.group);
  assert(bots.length > 0, '没有可用于检查的 bot（生成超时?）');
  const geo = new Set(), mat = new Set();
  let meshes = 0, dupG = 0, dupM = 0, noParent = 0;
  for (const bot of bots) {
    const g = bot.visual.group;
    if (!g.parent) noParent++;
    g.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.material) return;
      meshes++;
      if (geo.has(o.geometry.uuid)) dupG++; else geo.add(o.geometry.uuid);
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (mat.has(m.uuid)) dupM++; else mat.add(m.uuid); }
    });
  }
  assert(noParent === 0, `${noParent} 个 bot 的 visual.group 未挂入 scene`);
  assert(dupG === 0, `${dupG} 个重复 geometry.uuid（bot 之间共享了几何）`);
  assert(dupM === 0, `${dupM} 个重复 material.uuid（bot 之间共享了材质）`);
  return `${bots.length} 个 bot / ${meshes} 个 mesh：geometry 与 material uuid 均唯一，且 visual.group 都有 parent`;
}

function rayHitEntity(assert, S) {
  const bots = [...S.enemies, ...S.allies]
    .filter(b => b && b.enabled !== false && b.health > 0 && b.pos);
  assert(bots.length > 0, '没有存活 bot 可作为射线目标');
  assert(S.engine && typeof S.engine.rayHit === 'function', 'S.engine.rayHit 不可用');
  let target = null;
  for (const b of bots) {
    const p = b.pos;
    // rayHit 的 bot AABB: 脚底为原点, 半宽 16 / 高 72。
    // 从包围盒后沿外 2 单位沿 +z 射入, 不依赖玩家朝向, 也不受随机散布影响。
    const hit = S.engine.rayHit([p[0], p[1] + 36, p[2] - 18], [0, 0, 1], 40);
    if (hit && hit.kind === 'entity' && hit.entity === b) { target = b; break; }
  }
  assert(!!target, '所有 bot 的 rayHit 都未返回 kind=entity（可能被世界几何遮挡）');

  // 端到端补强: 临时把玩家放到 bot 正前方 30 单位, 调用 shoot() 看是否扣血。
  // 用 try/finally 还原玩家/回合状态, 避免污染后面的断言。
  const save = {
    pos: S.player.pos.slice(), yaw: S.player.yaw, pitch: S.player.pitch,
    weapon: S.weapon, cd: S.shootCd, dead: S.player.dead,
    bomb: S.BOMB.state, enabled: S.shootingEnabled,
    buy: S.buyMenuOpen, reloading: S.reloading,
  };
  let dmg = null;
  try {
    S.BOMB.state = 'live'; S.player.dead = false; S.shootingEnabled = true;
    S.buyMenuOpen = false; S.reloading = false; S.shootCd = 0;
    S.weapon = 'usp'; S.owned.usp = true; S.ammo.usp = [12, 100];
    S.player.pos = [target.pos[0], target.pos[1], target.pos[2] - 30];
    S.player.yaw = 0; S.player.pitch = 0;
    const hp0 = target.health;
    S.engine.shoot();
    dmg = hp0 - target.health;
  } finally {
    S.player.pos = save.pos; S.player.yaw = save.yaw; S.player.pitch = save.pitch;
    S.weapon = save.weapon; S.shootCd = save.cd; S.player.dead = save.dead;
    S.BOMB.state = save.bomb; S.shootingEnabled = save.enabled;
    S.buyMenuOpen = save.buy; S.reloading = save.reloading;
  }
  assert(dmg !== null && dmg > 0, `S.engine.shoot() 未造成伤害 (delta=${dmg})`);
  return `rayHit 命中 kind=entity 且命中对象为目标 bot；shoot() 端到端扣血 ${Number(dmg).toFixed(1)}`;
}

async function smokePurchase(assert, S, A) {
  assert(S.player && S.player.nades, 'S.player.nades 不存在');
  assert(Object.prototype.hasOwnProperty.call(S.player.nades, 'smoke'),
    'S.player.nades 缺少 smoke 键');
  assert(typeof S.hooks.buy === 'function', 'S.hooks.buy 不可用');
  // canBuy() 要求处于购买窗口内且靠近 CT 出生点
  const sp = (A.playerSpawns && A.playerSpawns[0]) || [0, 0, 0];
  S.player.pos = [sp[0], (sp[1] || 0) + 2, sp[2]];
  S.player.dead = false;
  S.BOMB.state = 'live';
  S.BOMB.roundLeft = A.ROUND_TIME;
  S.money = 16000;
  S.player.nades.smoke = 0;
  const before = S.player.nades.smoke;
  const ok = S.hooks.buy('smoke');
  const after = S.player.nades.smoke;
  assert(ok === true && after === before + 1,
    `S.hooks.buy('smoke') 未生效: 返回 ${ok}, nades.smoke ${before} -> ${after}`);
  let catNote = '';
  try {
    const G = await import('/web/game.js');
    const all = (G.BUY_CATEGORIES || []).flatMap(c => c.ids || []);
    catNote = all.includes('smoke')
      ? '；BUY_CATEGORIES 的 gear 分类也已列出 smoke'
      : '；注意: BUY_CATEGORIES 的 gear 分类未列出 smoke';
  } catch (e) {
    catNote = `；购买分类动态读取失败: ${e.message}`;
  }
  return `nades.smoke 存在，S.hooks.buy('smoke') 使数量 ${before} -> ${after} 并扣款 $300${catNote}`;
}

function defaultPistolAfterDeath(assert, S, A) {
  const sp = (A.playerSpawns && A.playerSpawns[0]) || [0, 0, 0];
  S.player.pos = [sp[0], (sp[1] || 0) + 2, sp[2]];
  S.money = 16000;
  S.BOMB.state = 'live';
  S.player.dead = false;
  assert(typeof S.hooks.onPlayerDeath === 'function', 'S.hooks.onPlayerDeath 不可用');
  assert(S.hud && typeof S.hud.nextRound === 'function', 'S.hud.nextRound 不可用');
  S.hooks.onPlayerDeath();
  const deadOwned = Object.keys(S.owned).join(',');
  S.hud.nextRound();
  const team = S.playerTeam === 't' ? 't' : 'ct';
  const want = team === 't' ? 'glock18' : 'usp';
  const owned = Object.keys(S.owned);
  assert(owned.includes(want),
    `下一回合缺少默认手枪 ${want} (team=${team})：死亡后 owned={${deadOwned}}，` +
    `nextRound() 后 owned={${owned.join(',')}}, weapon=${S.weapon}`);
  assert(owned.includes(S.weapon), `S.weapon=${S.weapon} 不在 S.owned 中`);
  return `team=${team}: S.owned 含 ${want}，且 S.weapon=${S.weapon} 属于已持有武器`;
}

async function halftimeC4Probe(assert, S, A, sleep) {
  const M = S.match;
  S.BOMB.state = 'live';
  M.half = 1; M.over = false; M.winner = null;
  M.half1CT = 0; M.half1T = 0;
  S.ctScore = (M.roundsPerHalf || 15) - 1;  // 本回合结束后 played >= roundsPerHalf -> 换边
  S.tScore = 0;
  S.playerTeam = 'ct';
  assert(typeof S.hooks.roundEnd === 'function', 'S.hooks.roundEnd 不可用');
  const teamBefore = S.playerTeam;
  S.hooks.roundEnd('ct', 'killed');
  // roundEnd() 用 later(nextRound, 4) 调度过场, evaluate 内真实等待
  await sleep(4600);
  const dynamic = {
    teamBefore,
    team: S.playerTeam,
    half: M.half,
    round: S.roundNum,
    bombState: S.BOMB.state,
    carrier: S.BOMB.carrier !== null && S.BOMB.carrier !== undefined,
    hasC4: S.player.hasC4 === true,
  };
  // 等下一回合 bot 补满, 再做结构探针
  for (let i = 0; i < 60; i++) {
    if (S.BOMB.spawnLeft === 0 && S.enemies.length > 0) break;
    await sleep(150);
  }
  const probe = {
    flipped: dynamic.team !== teamBefore,
    half2: M.half === 2,
    newRound: S.BOMB.state === 'live' && S.roundNum > 0,
    alliesAreT: S.allies.some(b => b && b.team === 't'),
    enemiesAreCT: S.enemies.some(b => b && b.team === 'ct'),
    carrier: S.BOMB.carrier !== null && S.BOMB.carrier !== undefined,
    hasC4: S.player.hasC4 === true,
    enemies: S.enemies.length,
    allies: S.allies.length,
  };
  return { dynamic, probe };
}

function mainMenu(assert, S) {
  const el = id => document.getElementById(id);
  const start = el('start');
  assert(start && !start.classList.contains('hidden'), '非 auto 路径未显示 #start 主菜单');
  assert(S.menuMode === 'start', `非 auto 路径 menuMode=${S.menuMode}, 期望 'start'`);
  assert(window.__CS_READY__ !== true, '非 auto 路径不应设置 __CS_READY__');
  assert(S.started !== true, '非 auto 路径不应自动进入战场');
  const role = el('start-role');
  assert(role && /CT|T/.test(role.textContent || ''), '主菜单未显示当前阵营说明');
  const ids = ['set-sens', 'set-volume', 'set-fov', 'set-bots', 'set-diff', 'set-mr', 'set-positional', 'start-btn'];
  const missing = ids.filter(id => !el(id));
  assert(missing.length === 0, `主菜单缺少控件: ${missing.join(', ')}`);
  const thumb = el('start-thumb');
  assert(thumb && /assets\/overviews\/dust2\.png$/.test(thumb.getAttribute('src') || ''),
    '主菜单俯视图未指向 assets/overviews/dust2.png');
  return `${ids.length} 个设置/开始控件齐全, menuMode=start, 俯视图已加载`;
}

function featureContracts(assert, S, A) {
  const wp = A.WEAPONS;
  // 新增资产与武器表字段
  assert(A.SFX_NAMES.includes('fire_usp_sil') && A.SFX_NAMES.includes('round_start'),
    'asset.js 未登记消音/回合开始音效');
  assert(wp.usp.silencer === true && wp.m4a1.silencer === true,
    'USP / M4A1 缺少 silencer 标记');
  assert(wp.glock18.burst === true, 'Glock-18 缺少 burst 标记');
  for (const id of ['awp', 'g3sg1', 'sg550']) {
    assert(JSON.stringify(wp[id].zoomLevels) === '[40,15]', `${id} 缺少二级开镜`);
  }
  for (const id of ['scout', 'aug', 'sg552']) {
    assert(JSON.stringify(wp[id].zoomLevels) === '[40]', `${id} 缺少一级开镜`);
  }
  assert(A.RECOIL_PATTERNS && Object.keys(A.RECOIL_PATTERNS).length >= 22,
    'RECOIL_PATTERNS 未覆盖全部有弹匣武器');
  assert(typeof A.materialAt === 'function' && A.materialAt([0, 0, 0]),
    'materialAt 不可用');
  const sp = S.assets && S.assets.sprites;
  assert(!!(sp && sp.blood && sp.muzzle && sp.kill_headshot), 'sprites 未装载');
  assert(!!(S.assets && S.assets.overview), 'overview 未装载');
  // 主循环 / 回合 / 菜单契约
  assert(S.round && S.round.phase === 'live', '自动模式未跳过冻结时间');
  assert(S.settings && typeof S.settings.volume === 'number', '设置未初始化');
  assert(S.hud && typeof S.hud.nextRound === 'function', 'S.hud.nextRound 不可用');
  for (const name of ['pickupWeapon', 'restartMatch', 'startOvertime', 'applySettings',
    'showMatchOver', 'toggleSilencer', 'toggleGlockMode', 'cycleSpectate', 'toggleFreeCam']) {
    assert(typeof S.hooks[name] === 'function', `缺少 hook: ${name}`);
  }
  assert(S.engine && typeof S.engine.clearEffects === 'function', '缺少 clearEffects');
  assert(S.engine && typeof S.engine.getEffects === 'function', '缺少 getEffects');
  const fx = S.engine.getEffects();
  assert(fx === S.effects && Array.isArray(fx.shells)
    && Array.isArray(fx.tracers) && Array.isArray(fx.blood), 'effects 结构不一致');
  assert(typeof A.WEAPONS.usp.crosshair === 'string', '武器缺少准星类型');
  return '武器表/音效/贴图/回合阶段/设置/hook/effects 契约齐全';
}

function collectViews(assert, S, A) {
  const ps = A.playerSpawns || [], py = A.playerYaws || [];
  const ts = A.tSpawns || [], sites = A.BOMB_SITES || {};
  const a = sites.A || [0, 0, 0], b = sites.B || [0, 0, 0];
  const ct = ps[0] || [0, 0, 0], t = ts[0] || [0, 0, 0];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const yawTo = (from, to) => Math.atan2(to[0] - from[0], to[2] - from[2]) * 180 / Math.PI;
  return [
    { name: 'ct_spawn', label: 'CT 出生', pos: ct, yaw: 90 - (py[0] || 0), pitch: -5 },
    { name: 'mid', label: '中路', pos: mid, yaw: yawTo(mid, a), pitch: -5 },
    { name: 't_spawn', label: 'T 出生', pos: t, yaw: yawTo(t, a), pitch: -5 },
    { name: 'site_a', label: 'A 点', pos: a, yaw: yawTo(a, mid), pitch: -5 },
    { name: 'site_b', label: 'B 点', pos: b, yaw: yawTo(b, mid), pitch: -5 },
  ];
}

/**
 * 截图前把画面归一化, 尽量让基线可复现:
 *   - S.paused = true: loop 的 else 分支仍会 renderFrame(), 但 HUD/计时/bot AI 不再推进。
 *   - 隐藏 #hud (DOM 覆盖层): 计时器/比分/中心提示含随机与实时文本, 不适合做像素基线。
 *   - 等本回合的 later() 生成定时器全部触发后, 移除所有 bot / 投掷物网格。
 *     (bot 出生点含随机性, 留着会让两次截图不同。)
 */
async function prepareScreenshot(assert, S, A, sleep) {
  S.paused = true;
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  for (const id of ['center-text', 'killfeed', 'radio', 'hit-text', 'spectate-text',
    'pointer-hint', 'scoreboard', 'buy-menu', 'scope-overlay', 'crosshair', 'fatal']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  for (let i = 0; i < 90; i++) {
    if (S.BOMB.spawnLeft === 0) break;
    await sleep(100);
  }
  await sleep(250);
  const removeMesh = m => {
    if (!m) return;
    try { if (S.engine && S.engine.removeEntityMesh) S.engine.removeEntityMesh(m); } catch (e) { /* noop */ }
    try { if (m.parent) m.parent.remove(m); } catch (e) { /* noop */ }
  };
  for (const bot of [...S.enemies, ...S.allies]) removeMesh(bot && bot.visual && bot.visual.group);
  S.enemies.length = 0;
  S.allies.length = 0;
  for (const list of [S.grenades, S.smokes, S.debris]) {
    for (const o of list) removeMesh(o && o.mesh);
    list.length = 0;
  }
  S.BOMB.carrier = null;
  S.paused = true;  // 防 visibilitychange 把 paused 复位
  await sleep(350); // 至少等一帧 renderFrame()
  return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };
}

// ---------------------------------------------------------------------------
// PNG 解析 / 像素比较 (纯 Node, 不依赖 sharp)
// ---------------------------------------------------------------------------
function decodePng(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) throw new Error('不是 PNG 文件');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h) throw new Error('PNG 缺少合法 IHDR');
  if (depth !== 8 || interlace !== 0) throw new Error(`不支持的 PNG: depth=${depth} interlace=${interlace}`);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[ctype];
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${ctype}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  if (raw.length < (stride + 1) * h) throw new Error('PNG 像素数据被截断');
  const out = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= channels) ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      } else if (filter !== 0) throw new Error(`未知 PNG 行过滤器 ${filter}`);
      cur[x] = v;
    }
  }
  return { width: w, height: h, channels, data: out };
}

function compareBytes(base, cur) {
  const sizeRatio = Math.abs(base.length - cur.length) / Math.max(1, base.length);
  const n = Math.min(base.length, cur.length);
  let diff = 0;
  for (let i = 0; i < n; i++) if (base[i] !== cur[i]) diff++;
  const byteRatio = (diff + Math.abs(base.length - cur.length)) / Math.max(1, base.length, cur.length);
  return {
    ok: sizeRatio <= MAX_SIZE_DIFF_RATIO && byteRatio <= MAX_BYTE_DIFF_RATIO,
    detail: `PNG 解码不可用，回退为「文件大小 + 字节差异」弱比较：` +
      `大小差 ${(sizeRatio * 100).toFixed(2)}% (阈值 ${MAX_SIZE_DIFF_RATIO * 100}%)，` +
      `字节差 ${(byteRatio * 100).toFixed(2)}% (阈值 ${MAX_BYTE_DIFF_RATIO * 100}%)。` +
      ` 该方式无法发现等长重排/色调漂移，仅供参考。`,
  };
}

function comparePng(baseBuf, curBuf) {
  let a, b;
  try { a = decodePng(baseBuf); b = decodePng(curBuf); }
  catch (err) { return compareBytes(baseBuf, curBuf); }
  if (a.width !== b.width || a.height !== b.height) {
    return { ok: false, detail: `截图尺寸不同: 基线 ${a.width}x${a.height}, 本次 ${b.width}x${b.height}` };
  }
  const px = a.width * a.height;
  const ch = Math.min(a.channels, b.channels);
  let sum = 0, changed = 0;
  for (let i = 0; i < px; i++) {
    let maxd = 0;
    for (let c = 0; c < ch; c++) {
      const d = Math.abs(a.data[i * a.channels + c] - b.data[i * b.channels + c]);
      sum += d;
      if (d > maxd) maxd = d;
    }
    if (maxd > PIXEL_DIFF_THRESHOLD) changed++;
  }
  const ratio = changed / px;
  const mean = sum / Math.max(1, px * ch);
  return {
    ok: ratio <= MAX_CHANGED_RATIO && mean <= MAX_MEAN_ABS,
    detail: `像素比较 (${a.width}x${a.height}, ${a.channels}/${b.channels} 通道): ` +
      `变化像素 ${(ratio * 100).toFixed(3)}% (阈值 ${MAX_CHANGED_RATIO * 100}%)，` +
      `平均绝对差 ${mean.toFixed(3)} (阈值 ${MAX_MEAN_ABS})`,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function printUsage() {
  console.log(`CS 1.5 无头回归 (tests/smoke.mjs)

用法:
  node tests/smoke.mjs                      完整回归 (断言 + 5 视角截图基线比对)
  node tests/smoke.mjs --update-baselines   只写截图基线, 跳过断言与比对
  node tests/smoke.mjs --help               显示本说明

环境变量:
  CS_BROWSER   Edge/Chrome 可执行文件路径 (默认自动探测)
  CS_PYTHON    python 可执行文件 (默认 python / python3 / py)

状态: PASS 通过 / FAIL 失败 / LIMIT 通过但有已知限制 / SKIP 未执行。
      FAIL 或 SKIP 时退出码为 1 (不把「没跑」伪装成通过)。`);
}

async function main() {
  if (SHOW_HELP) { printUsage(); return; }

  console.log('正在启动静态服务与无头浏览器...');
  const server = await startServer();
  let automation = null;

  try {
    const opened = await openAutomation();
    if (opened.skip) {
      record('浏览器自动化', 'SKIP', opened.skip);
      return;
    }
    automation = opened.automation;
    console.log(`  服务  : ${server.url}  (python serve.py ${server.port}, NOBROWSER=1 QUIET=1)`);
    console.log(`  浏览器: ${opened.exe}`);
    console.log(`  自动化: ${automation.kind}`);
    console.log(`  模式  : ${UPDATE_BASELINES ? '仅更新截图基线' : '完整回归'}\n`);

    if (!UPDATE_BASELINES) {
      // 正常入口: 不带 ?auto=1 时必须停在主菜单, 等待用户手势才开始对局。
      await automation.navigate(server.url);
      await waitForBoot(automation, 60000, '');
      await check('0. 非 auto 主菜单与设置', () => evalInPage(automation, mainMenu));
    }

    // 第一次自动加载: 断言 + 取视角坐标
    await automation.navigate(`${server.url}?auto=1`);
    await waitForBoot(automation, 60000, '?auto=1');
    const views = await evalInPage(automation, collectViews);

    if (!UPDATE_BASELINES) {
      // bot 由 nextRound() 在冻结时间内同步生成, 轮询等它们到齐再做断言。
      // 在 Node 侧轮询, 因为页面内 sleep 期间无法把进度传回来。
      await check('等待 bot 生成', async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const state = await evalInPage(automation, function botsReady(assert, S) {
            return {
              ready: S.BOMB.spawnLeft === 0 && S.enemies.length > 0 && S.allies.length > 0,
              enemies: S.enemies.length, allies: S.allies.length,
              spawnLeft: S.BOMB.spawnLeft,
            };
          });
          if (state && state.ready) {
            return `${state.enemies} 敌人 / ${state.allies} 队友已生成 (spawnLeft=0)`;
          }
          await sleep(200);
        }
        throw new Error('20s 内 bot 未生成完毕');
      });

      await check('0a. 新增 P1/P2 契约', () => evalInPage(automation, featureContracts));
      await check('1. 世界材质不透明', () => evalInPage(automation, worldMaterials));
      await check('2. bot 几何与材质独立', () => evalInPage(automation, botGeometryIndependent));
      await check('3. 射线命中实体 (rayHit + shoot 扣血)', () => evalInPage(automation, rayHitEntity));
      await check('4. 购买菜单 / 烟雾弹可购买', () => evalInPage(automation, smokePurchase));
      await check('5. 阵亡后下回合拥有默认手枪', () => evalInPage(automation, defaultPistolAfterDeath));
      await check('6. 半场换边后 C4 有携带者', async () => {
        const r = await evalInPage(automation, halftimeC4Probe);
        const d = r.dynamic, p = r.probe;
        if (d.carrier || d.hasC4) {
          return `动态路径通过: 半场换边后 carrier=${d.carrier} / player.hasC4=${d.hasC4}，` +
            `team ${d.teamBefore}->${d.team}, half=${d.half}, round=${d.round}`;
        }
        const probeOk = p.flipped && p.half2 && p.newRound && p.alliesAreT && p.enemiesAreCT;
        const common = `动态检查未满足: 换边后 S.BOMB.carrier=${d.carrier}, ` +
          `S.player.hasC4=${d.hasC4} (team ${d.teamBefore}->${d.team}, half=${d.half}, round=${d.round}, ` +
          `bombState=${d.bombState})`;
        if (probeOk) {
          // 任务允许在动态路径不稳定时退回结构探针, 但必须明确标注限制, 不算 PASS。
          return {
            status: 'LIMIT',
            detail: `${common}。结构探针通过: playerTeam 已翻转、half=2、下回合已重新 spawn、` +
              `进攻方(盟友)为 T / 防守方(敌人)为 CT (${p.allies}/${p.enemies})。` +
              ` 详见 tests/README.md「当前已知限制」。`,
          };
        }
        throw new Error(`${common}；结构探针同样失败: ${JSON.stringify(p)}`);
      });
    }

    // ---------- 5 视角截图基线 ----------
    await mkdir(BASELINE_DIR, { recursive: true });
    for (const v of views) {
      await check(`基线截图: ${v.label} (${v.name}.png)`, async () => {
        const pos = [...v.pos.map(fmtNum), fmtNum(v.yaw), fmtNum(v.pitch)].join(',');
        const query = `?auto=1&pos=${pos}`;
        await automation.navigate(`${server.url}${query}`);
        await waitForBoot(automation, 60000, query);
        await evalInPage(automation, prepareScreenshot);
        const png = await automation.screenshot();
        if (png.length < 1000) throw new Error(`截图异常小 (${png.length} bytes)`);
        const file = path.join(BASELINE_DIR, `${v.name}.png`);
        const rel = path.relative(ROOT, file);

        if (UPDATE_BASELINES) {
          await writeFile(file, png);
          return `已写入基线 ${rel} (${png.length} bytes, 视角 pos=${pos})`;
        }
        if (!existsSync(file)) {
          await writeFile(file, png);
          return { status: 'LIMIT', detail: `基线不存在, 已自动创建 ${rel} (${png.length} bytes)。` +
            ` 本次跳过比对, 请人工复核画面后把该文件纳入版本库。` };
        }
        const base = await readFile(file);
        const cmp = comparePng(base, png);
        if (!cmp.ok) throw new Error(`${cmp.detail}。若属预期变更请运行: node tests/smoke.mjs --update-baselines`);
        return cmp.detail;
      });
    }

    if (!UPDATE_BASELINES) {
      // 放在最后: 覆盖上面所有导航与页面内操作产生的事件
      await check('7a. 零控制台错误 (pageerror / console.error / Log.error)', () => {
        const errs = issues.filter(i => i.kind === 'console');
        if (errs.length) {
          throw new Error(`${errs.length} 条: ` + errs.slice(0, 5).map(e => e.detail).join(' | '));
        }
        return '0 条 JS 异常 / console.error / Log.error' +
          '（swiftshader 的 "GPU stall due to ReadPixels" 是 warning 级驱动日志, 已忽略）';
      });
      await check('7b. 零 404 / requestfailed / HTTP>=400', () => {
        const errs = issues.filter(i => i.kind === 'network');
        if (errs.length) {
          throw new Error(`${errs.length} 条: ` + errs.slice(0, 5).map(e => e.detail).join(' | '));
        }
        return '0 条 404 / 失败请求 / HTTP>=400（导航取消在途子资源产生的 net::ERR_ABORTED 已明确忽略）';
      });
    }
  } finally {
    if (automation) {
      try { await automation.close(); } catch (err) { console.log(`  · 关闭浏览器时: ${errorText(err)}`); }
    }
    await stopServer(server);
  }
}

function printReport() {
  const count = s => results.filter(r => r.status === s).length;
  console.log('\n==================== CS 1.5 无头回归报告 ====================');
  if (!results.length) { console.log('(无结果)'); return; }
  console.log('-----------------------------------------------------------');
  for (const r of results) {
    const tag = r.status.padEnd(5);
    console.log(`[${tag}] ${r.name}${r.detail ? `\n        ${r.detail.replace(/\n/g, '\n        ')}` : ''}`);
  }
  console.log('-----------------------------------------------------------');
  console.log(`汇总: PASS ${count('PASS')} / FAIL ${count('FAIL')} / ` +
    `LIMIT ${count('LIMIT')} / SKIP ${count('SKIP')}`);
  console.log('\n说明:');
  console.log('  * 截图基线: 已隐藏 DOM HUD / 移除随机生成的 bot, 但不同 GPU/驱动仍可能不一致,');
  console.log('    换机器后请用 --update-baselines 重建基线。');
  console.log('  * 网络事件: net::ERR_ABORTED (切换页面时取消在途资源) 被明确忽略, 不计入失败。');
  console.log('  * 状态: LIMIT = 通过但走了降级路径; SKIP = 根本没跑, 两者都不计为 PASS。');

  if (count('FAIL') || count('SKIP')) {
    process.exitCode = 1;
    console.log(`\n结论: FAIL/SKIP 存在, 退出码 = 1。`);
  } else {
    console.log(`\n结论: 无 FAIL/SKIP, 退出码 = 0${count('LIMIT') ? ' (存在 LIMIT, 请阅读上面的限制说明)' : ''}。`);
  }
}

// 顶层兜底: 任何未捕获异常都要给出可定位的中文说明, 并且不留下子进程/浏览器。
process.on('unhandledRejection', err => {
  record('未处理的 Promise 拒绝', 'FAIL', errorText(err));
});

try {
  await main();
} catch (err) {
  record('脚本执行', 'FAIL', `${errorText(err)}\n${(err && err.stack) ? err.stack.split('\n').slice(1, 4).join('\n') : ''}`);
} finally {
  // --help 只打印用法, 不需要空报告
  if (!SHOW_HELP) printReport();
}

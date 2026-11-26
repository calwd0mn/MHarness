import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const playwright = process.argv[2];
if (!playwright) throw new Error('请传入已安装的 playwright-core 包目录');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fromRepo = (path) => import(pathToFileURL(resolve(repo, path)));
const { chromium } = await import(pathToFileURL(resolve(playwright, 'index.mjs')));
const { createServer } = await fromRepo('apps/web/node_modules/vite/dist/node/index.js');
const { createEventSessionApp } = await fromRepo('apps/server/src/app.ts');
const { createModelTurnDriver } = await fromRepo('apps/server/src/agent/model-turn.ts');
const { LlmRuntime } = await fromRepo('apps/server/src/model/runtime.ts');
const { SqliteSessionPersistence } = await fromRepo('packages/session/src/server.ts');

const directory = '/api/session-directory/events';
const sessions = '/api/sessions';
const key = 'mharness.sessions.current';
const follow = (id) => sessions + '/' + id + '/follow';
const draft = '最后一批草稿';
const answer = draft + '已正式结算';
const dir = await mkdtemp(join(tmpdir(), 'mharness-directory-browser-'));
let holdNextModel = false;
let holdNextCreation = false;
const modelGate = Promise.withResolvers();
const createGate = Promise.withResolvers();
const verifyGate = Promise.withResolvers();
const originalCreate = SqliteSessionPersistence.prototype.create;
const frames = [];
const requests = [];
const streams = new Set();
const blocks = new Map();
let app, web, browser, base;
const failures = [];
let frameError;

function log(label, value) {
  console.log(label + ' ' + JSON.stringify(value));
}

async function wait(label, read, timeout = 10000) {
  const signal = AbortSignal.timeout(timeout);
  const deadline = new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
  while (!signal.aborted) {
    if (frameError) throw frameError;
    let value;
    try { value = await Promise.race([read(signal), deadline]); }
    catch (error) {
      if (signal.aborted && error === signal.reason) break;
      throw error;
    }
    if (value) return value;
    await delay(30);
  }
  throw new Error('等待超时：' + label);
}

function assertEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
}

// 挂住下一次请求可保留自动重连预算，并让另外三个 SSE 连接继续工作。
function block(window, path, otherStreams) {
  const name = window + ' ' + path;
  assert.equal(blocks.has(name), false);
  const gate = Promise.withResolvers();
  const current = [...streams].filter((entry) => entry.name === name);
  assert.equal(current.length, 1, '应关闭一条现有真实 SSE ' + name);
  const peers = otherStreams.map(([peer, route]) => {
    const existing = [...streams].filter((entry) => entry.name === peer + ' ' + route);
    assert.equal(existing.length, 1, '预期另一条 SSE 已打开 ' + peer + ' ' + route);
    return { peer, route, entry: existing[0] };
  });
  const firstClosedRequest = requests.length;
  const state = {
    blockedAttempts: 0,
    release: () => { blocks.delete(name); gate.resolve(); },
    wait: gate.promise,
    assertPeersConnected(omitPath) {
      for (const { peer, route, entry } of peers) {
        if (route === omitPath) continue;
        assert.ok(streams.has(entry), '其他 SSE 意外关闭 ' + entry.name);
        assert.equal(requests.slice(firstClosedRequest).some(({ window, path }) => window === peer && path === route),
          false, '其他 SSE 意外重连 ' + entry.name);
      }
    },
  };
  blocks.set(name, state);
  for (const entry of current) {
    entry.proxyResponse.destroy();
    entry.response.destroy();
  }
  return state;
}

function observe(proxy) {
  proxy.on('proxyRes', (proxyResponse, request, response) => {
    const window = request.headers['x-mharness-acceptance-window'];
    const path = request.url;
    if (!window || !String(proxyResponse.headers['content-type']).includes('text/event-stream')) return;
    const entry = { name: window + ' ' + path, proxyResponse, response };
    streams.add(entry);
    const remove = () => streams.delete(entry);
    response.once('close', remove);
    proxyResponse.once('close', remove);
    proxyResponse.setEncoding('utf8');
    let pending = '';
    proxyResponse.on('data', (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
        const data = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data.startsWith('data: ')) {
          try {
            frames.push({ window, path, frame: JSON.parse(data.slice(6)) });
          } catch (error) {
            // 流回调中的异常必须交给主流程，才能在报告失败前关闭连接和数据库。
            frameError ??= new Error('无法读取 SSE 帧 ' + window + ' ' + path, { cause: error });
          }
        }
      }
    });
  });
}

async function json(path, method = 'GET', body, expected = 200, signal = AbortSignal.timeout(10000)) {
  const response = await fetch(base + path, {
    method,
    signal,
    ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}

async function history(id, turns) {
  return wait('已提交历史 ' + id, async (signal) => {
    const { records } = await json(sessions + '/' + id, 'GET', undefined, 200, signal);
    const events = records.map(({ event }) => event);
    return events.filter((event) => event.type === 'turn/end' && event.data.reason.kind === 'completed').length === turns && events;
  });
}

async function seed(text) {
  const { sessionId } = await json(sessions, 'POST', {}, 201);
  await json(sessions + '/' + sessionId + '/messages', 'POST', { requestId: randomUUID(), content: [{ type: 'text', text }] }, 202);
  await history(sessionId, 1);
  return sessionId;
}

const row = (page, id) => page.locator('nav button small').filter({ hasText: id });
const selection = (page) => page.locator('nav [aria-current="page"] small').allTextContents();
async function evaluate(page, fn, arg) {
  const { value } = await wait('浏览器脚本执行', async () => ({ value: await page.evaluate(fn, arg) }));
  return value;
}
const storage = (page) => evaluate(page, (name) => localStorage.getItem(name), key);
const writes = (page) => evaluate(page, () => window.selectionWrites);
const selected = (page, id) => wait('选中 ' + id, async () => {
  const selectedIds = await selection(page);
  return id ? selectedIds.length === 1 && selectedIds[0] === id : selectedIds.length === 0;
});
const assertSelection = async (page, id, label) => assertEqual(await selection(page), id ? [id] : [], label);
const hint = (id) => JSON.stringify(id ? { sessionId: id } : {});

async function choose(page, id) {
  await row(page, id).click();
  await selected(page, id);
  await wait('共享键更新为 ' + id, async () => await storage(page) === hint(id));
}

async function create(page) {
  const [result] = await Promise.all([
    page.waitForResponse((item) => new URL(item.url()).pathname === sessions && item.request().method() === 'POST'),
    page.getByRole('button', { name: '新建会话' }).click(),
  ]);
  assert.equal(result.status(), 201);
  const { sessionId } = await result.json();
  await selected(page, sessionId);
  await wait('共享键保存新会话', async () => await storage(page) === hint(sessionId));
  return sessionId;
}

async function send(page, id, text) {
  await page.getByLabel('消息', { exact: true }).fill(text);
  const [response] = await Promise.all([
    page.waitForResponse((item) => new URL(item.url()).pathname === sessions + '/' + id + '/messages' && item.request().method() === 'POST'),
    page.getByRole('button', { name: '发送', exact: true }).click(),
  ]);
  assert.equal(response.status(), 202);
}

async function directoryLoad(page, action) {
  const [response] = await Promise.all([
    page.waitForResponse((item) => new URL(item.url()).pathname === sessions && item.request().method() === 'GET'),
    action(),
  ]);
  assert.equal(response.status(), 200);
}

async function setupWindow(page, name) {
  await page.setExtraHTTPHeaders({ 'x-mharness-acceptance-window': name });
  page.setDefaultTimeout(10000);
}

async function installInstrumentation(context) {
  await context.addInitScript((name) => {
    window.selectionWrites = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === name) window.selectionWrites.push(value);
      return setItem.call(this, key, value);
    };
  }, key);
}

try {
  // 首次 flush 要晚于真实 added 帧，才能验证两个窗口收到同一临时会话的撤回。
  SqliteSessionPersistence.prototype.create = async function (...args) {
    const handle = await originalCreate.apply(this, args);
    if (holdNextCreation) {
      holdNextCreation = false;
      handle.flush = async () => { await createGate.promise; throw new Error('验收注入的首次 SQLite 提交失败'); };
      const verify = handle.creationVerifier();
      let firstCheck = true;
      handle.creationVerifier = () => async () => {
        if (firstCheck) {
          firstCheck = false;
          return 'unknown';
        }
        await verifyGate.promise;
        return verify();
      };
    }
    return handle;
  };

  const runtime = new LlmRuntime({ mock: {
    async *generate() {
      const held = holdNextModel;
      holdNextModel = false;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      if (held) {
        yield { type: 'text-delta', index: 0, text: draft };
        await modelGate.promise;
        yield { type: 'text-delta', index: 0, text: '已正式结算' };
      } else {
        yield { type: 'text-delta', index: 0, text: '普通模拟回答' };
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: held ? answer : '普通模拟回答' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  } });
  const driver = createModelTurnDriver({ runtime, config: () => ({ provider: 'mock', model: 'test-model' }), systemPrompt: () => '' });
  app = await createEventSessionApp(join(dir, 'events.sqlite'), false, driver);
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  web = await createServer({
    root: resolve(repo, 'apps/web'),
    configFile: resolve(repo, 'apps/web/vite.config.ts'),
    cacheDir: join(dir, 'vite-cache'),
    logLevel: 'warn',
    plugins: [{
      name: 'mharness-final-browser-wire',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const window = request.headers['x-mharness-acceptance-window'];
          if (!window || !request.url.startsWith('/api/')) return next();
          requests.push({ window, method: request.method, path: request.url });
          const active = blocks.get(window + ' ' + request.url);
          if (!active) return next();
          active.blockedAttempts++;
          void active.wait.then(() => { if (!response.destroyed) next(); });
        });
      },
    }],
    server: { strictPort: false, proxy: { '/api': { target: base, configure: observe } } },
  });
  await web.listen();
  const address = web.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'https://127.0.0.1:' + address.port;

  const x = await seed('会话 X 初始消息');
  const z = await seed('会话 Z 初始消息');
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await installInstrumentation(context);
  const a = await context.newPage();
  await setupWindow(a, 'A');
  await directoryLoad(a, () => a.goto(origin));
  await row(a, x).waitFor();
  const [b] = await Promise.all([
    a.waitForEvent('popup'),
    evaluate(a, () => { window.open('about:blank', 'mharness-b', 'popup,width=900,height=700'); }),
  ]);
  await setupWindow(b, 'B');
  await directoryLoad(b, () => b.goto(origin));
  await row(b, z).waitFor();

  const windowId = async (page) => {
    const session = await context.newCDPSession(page);
    try { return (await session.send('Browser.getWindowForTarget')).windowId; }
    finally { await session.detach(); }
  };
  const windowIds = await Promise.all([windowId(a), windowId(b)]);
  assert.notEqual(windowIds[0], windowIds[1]);
  const protocol = await evaluate(a, () => performance.getEntriesByType('navigation')[0].nextHopProtocol);
  assert.equal(protocol, 'h2');
  log('两个独立 Chromium 窗口', { windowIds, protocol });

  await choose(a, x);
  await choose(b, z);
  await assertSelection(a, x, 'B 改选不应改写 A 本页选择');
  const baselineWrites = await Promise.all([writes(a), writes(b)]);
  const busyStart = frames.length;
  await send(a, x, '另一窗口提示保持');
  await history(x, 2);
  await wait('两窗收到运行、活动和空闲通知', () => ['A', 'B'].every((window) => {
    const updates = frames.slice(busyStart).filter((entry) => entry.window === window && entry.path === directory && entry.frame.sessionId === x);
    return updates.some(({ frame }) => frame.type === 'api-session/status' && frame.running)
      && updates.some(({ frame }) => frame.type === 'api-session/activity')
      && updates.some(({ frame }) => frame.type === 'api-session/status' && !frame.running);
  }));
  await a.getByText('另一窗口提示保持', { exact: true }).waitFor();
  await wait('A 侧栏已按 X 的最新活动重排', async () =>
    await a.locator('nav button small').first().textContent() === x);
  const afterIdle = await seed('确认两个窗口已应用前一轮目录更新');
  await wait('两个窗口已处理空闲之后的可见目录项', async () => {
    const firstRows = await Promise.all([a, b].map((page) => page.locator('nav button small').first().textContent()));
    return firstRows.every((id) => id === afterIdle);
  });
  await evaluate(a, (name) => navigator.locks.request(name, () => {}), key);
  await assertSelection(a, x, '普通更新保留 A 选择');
  await assertSelection(b, z, '普通更新保留 B 选择');
  assertEqual(await storage(a), hint(z), '共享键保留 B 选择');
  assertEqual(await Promise.all([writes(a), writes(b)]), baselineWrites, '普通更新不得写共享键');
  log('独立选择和普通更新不回写', { selectionA: x, selectionB: z, writes: baselineWrites.map((items) => items.length) });

  const yMarker = frames.length;
  const y = await create(b);
  await wait('A 收到 Y 的空会话实时新增', () => frames.slice(yMarker).some(({ window, path, frame }) =>
    window === 'A' && path === directory && frame.type === 'api-session/added' && frame.summary.sessionId === y && frame.summary.blank));
  await json(sessions + '/' + z + '/messages', 'POST', {
    requestId: randomUUID(), content: [{ type: 'text', text: '验证 Y 新增后的目录消费顺序' }],
  }, 202);
  await history(z, 2);
  await wait('A 侧栏已消费 Y 新增之后的 Z 活动重排', async () =>
    await a.locator('nav button small').first().textContent() === z);
  assert.equal(await row(a, y).count(), 0);
  await assertSelection(a, x, 'B 新建保持 A 原选中');
  const emptyFollowStart = frames.length;
  await directoryLoad(a, () => a.reload());
  await selected(a, y);
  assert.equal(await row(a, y).count(), 1);
  await wait('A 收到恢复空会话的 follow 快照', () => frames.slice(emptyFollowStart).some(({ window, path, frame }) =>
    window === 'A' && path === follow(y) && frame.type === 'snapshot' && frame.records.length === 0));
  await a.locator('.conversation-header').getByText('已连接', { exact: true }).waitFor();
  assertEqual(await writes(a), [], '恢复同一提示不得回写');

  await choose(a, x);
  await directoryLoad(a, () => a.reload());
  await selected(a, x);
  assert.equal(await row(a, y).count(), 0);
  await assertSelection(b, y, 'A 改选后 B 保持 Y');
  await a.getByRole('button', { name: '关闭会话' }).click();
  await wait('明确清除共享选择', async () => await storage(a) === hint());
  await directoryLoad(a, () => a.reload());
  await row(a, x).waitFor();
  await assertSelection(a, null, '清空提示后刷新');
  assert.equal(await row(a, y).count(), 0);
  await assertSelection(b, y, 'A 清空后 B 保持 Y');
  assertEqual(await writes(a), [], '空提示刷新不得回写');

  await choose(a, x);
  const incognito = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const privatePage = await incognito.newPage();
    await setupWindow(privatePage, 'private');
    await directoryLoad(privatePage, () => privatePage.goto(origin));
    await row(privatePage, x).waitFor();
    await assertSelection(privatePage, null, '无痕启动无选中');
    assert.equal(await row(privatePage, y).count(), 0);
    assert.equal(await storage(privatePage), null);
    assert.equal(requests.some(({ window, path }) => window === 'private' && path.endsWith('/follow')), false);
    assertEqual(await storage(a), hint(x), '无痕不改变常规上下文');
  } finally { await incognito.close(); }

  const firstTurn = frames.length;
  await send(b, y, 'Y 的首次消息');
  await wait('A 收到 Y 首次 Turn 帧', () => frames.slice(firstTurn).some(({ window, path, frame }) =>
    window === 'A' && path === directory && frame.type === 'api-session/updated' && frame.sessionId === y && frame.blank === false && frame.seq === 0));
  const firstTurnFrames = frames.slice(firstTurn).filter(({ window, path, frame }) =>
    window === 'A' && path === directory && frame.sessionId === y).map(({ frame }) => frame);
  const started = firstTurnFrames.findIndex((frame) => frame.type === 'api-session/status' && frame.running);
  const revealed = firstTurnFrames.findIndex((frame) => frame.type === 'api-session/updated');
  assert.ok(started >= 0 && started < revealed, '运行通知必须早于首次 Turn 更新');
  await row(a, y).waitFor();
  assert.equal(await row(a, y).count(), 1);
  await assertSelection(a, x, '首次 Turn 不改变 A 选择');
  await history(y, 1);
  log('空会话过滤、三种刷新、无痕和首次 Turn', { y, firstTurnSeq: 0 });

  holdNextCreation = true;
  const createMarker = frames.length;
  const errorResponse = b.waitForResponse((item) => new URL(item.url()).pathname === sessions && item.request().method() === 'POST');
  // 先等两窗看到临时项才释放待确认响应。提前观察拒绝，避免超时跳过 finally。
  void errorResponse.catch(() => {});
  await b.getByRole('button', { name: '新建会话' }).click();
  const failedAdded = await wait('双窗口均收到待提交新增', () => {
    const additions = frames.slice(createMarker).filter(({ path, frame }) => path === directory && frame.type === 'api-session/added');
    const left = additions.find(({ window }) => window === 'A')?.frame;
    const right = additions.find(({ window }) => window === 'B')?.frame;
    if (!left || !right) return;
    assertEqual(left, right, '两窗应收到同一个临时项');
    assert.equal(left.summary.blank, true);
    return left;
  });
  const failedId = failedAdded.summary.sessionId;
  assert.ok((await json(sessions)).sessions.some((entry) => entry.sessionId === failedId && entry.blank));
  createGate.resolve();
  const failed = await errorResponse;
  assert.equal(failed.status(), 503);
  assertEqual(await failed.json(), { code: 'session_creation_unknown', sessionId: failedId });
  const pending = b.getByText('创建结果未知，暂未确认。', { exact: true });
  await pending.waitFor();
  const withdrawalContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const withdrawalPage = await withdrawalContext.newPage();
  await setupWindow(withdrawalPage, 'withdrawal');
  await withdrawalPage.addInitScript(([name, value]) => localStorage.setItem(name, value), [key, hint(failedId)]);
  await directoryLoad(withdrawalPage, () => withdrawalPage.goto(origin));
  await selected(withdrawalPage, failedId);
  await row(withdrawalPage, failedId).waitFor();
  const withdrawalStart = requests.length;
  verifyGate.resolve();
  await wait('双窗口均收到同一 ID 的撤回', () => ['A', 'B'].every((window) => frames.slice(createMarker).some((entry) =>
    entry.window === window && entry.path === directory && entry.frame.type === 'api-session/removed' &&
    entry.frame.reason === 'creation-failed' && entry.frame.sessionId === failedId)));
  await b.getByText('创建会话失败，请重试。', { exact: true }).waitFor();
  await pending.waitFor({ state: 'hidden' });
  await row(withdrawalPage, failedId).waitFor({ state: 'hidden' });
  await assertSelection(withdrawalPage, null, '撤回清除已选临时项');
  await wait('撤回清除临时项的恢复提示', async () => await storage(withdrawalPage) === hint());
  assert.equal(requests.slice(withdrawalStart).some(({ window, method, path }) =>
    (window === 'B' || window === 'withdrawal') && method === 'GET' && path === sessions), false, '撤回反馈应通过现有 SSE 更新');
  await withdrawalContext.close();
  assert.equal((await json(sessions)).sessions.some((entry) => entry.sessionId === failedId), false);
  assert.equal(await row(a, failedId).count(), 0);
  assert.equal(await row(b, failedId).count(), 0);
  await assertSelection(a, x, '撤回保留 A 选择');
  await assertSelection(b, y, '撤回保留 B 选择');
  assertEqual(await storage(a), hint(x), '撤回保留共享提示');
  log('首次提交失败撤回', { failedId, status: failed.status(), addedRevision: failedAdded.revision });

  const previousRows = await a.locator('nav button small').allTextContents();
  const directoryBlock = block('A', directory, [['A', follow(x)], ['B', directory], ['B', follow(y)]]);
  await wait('A 目录请求已断开并尝试重连', () => directoryBlock.blockedAttempts === 1);
  directoryBlock.assertPeersConnected();
  const missedMarker = frames.length;
  const missed = await create(b);
  await send(b, missed, '断线期间的新会话');
  await history(missed, 1);
  directoryBlock.assertPeersConnected(follow(y));
  assertEqual(await a.locator('nav button small').allTextContents(), previousRows, '断线期间保留既有侧栏');
  await assertSelection(a, x, '断线期间保留 A 选择');
  assert.equal(await row(a, missed).count(), 0);
  assert.equal(frames.slice(missedMarker).some(({ window, path, frame }) => window === 'A' && path === directory &&
    (frame.sessionId === missed || frame.summary?.sessionId === missed)), false);
  const beforeDirectoryGet = requests.filter(({ window, method, path }) => window === 'A' && method === 'GET' && path === sessions).length;
  await directoryLoad(a, async () => directoryBlock.release());
  await row(a, missed).waitFor();
  assert.equal(await row(a, missed).count(), 1);
  await assertSelection(a, x, '重连快照保留 A 选择');
  assertEqual(await storage(a), hint(missed), '重连快照保留 B 写入的提示');
  assert.equal(requests.filter(({ window, method, path }) => window === 'A' && method === 'GET' && path === sessions).length, beforeDirectoryGet + 1);
  log('目录断线快照补齐', { missed, snapshots: 1, blockedAttempts: directoryBlock.blockedAttempts });

  const streaming = await create(b);
  await directoryLoad(a, () => a.reload());
  await selected(a, streaming);
  await wait('两个窗口已收到初始 follow 快照', () => ['A', 'B'].every((peer) =>
    frames.some(({ window, path, frame }) => window === peer && path === follow(streaming) && frame.type === 'snapshot')));
  holdNextModel = true;
  const marker = frames.length;
  await send(b, streaming, '刷新及断线恢复草稿');
  for (const page of [a, b]) {
    await page.locator('article.assistant').getByText(draft, { exact: true }).waitFor();
    await page.getByText('正在生成', { exact: true }).waitFor();
  }
  const start = await wait('A 收到草稿 Attempt', () => frames.slice(marker).find(({ window, path, frame }) =>
    window === 'A' && path === follow(streaming) && frame.type === 'assistant-stream' && frame.frame.type === 'start'));
  const refreshStart = frames.length;
  await directoryLoad(a, () => a.reload());
  await selected(a, streaming);
  await a.locator('article.assistant').getByText(draft, { exact: true }).waitFor();
  await a.getByText('正在生成', { exact: true }).waitFor();
  const snapshot = await wait('刷新 follow 快照', () => frames.slice(refreshStart).find(({ window, path, frame }) =>
    window === 'A' && path === follow(streaming) && frame.type === 'snapshot'));
  assert.equal(snapshot.frame.assistantStream.activeAttempt.attemptId, start.frame.frame.attemptId);

  const followBlock = block('A', follow(streaming), [['A', directory], ['B', directory], ['B', follow(streaming)]]);
  await wait('A follow 已断开且开始下一次连接', () => followBlock.blockedAttempts === 1);
  followBlock.assertPeersConnected();
  modelGate.resolve();
  await b.locator('article.assistant').getByText(answer, { exact: true }).waitFor();
  const records = await history(streaming, 1);
  assert.equal(records.filter(({ type }) => type === 'assistant/message').length, 1);
  assert.equal(records.filter(({ type }) => type === 'turn/end').length, 1);
  assert.equal(await a.getByText(answer, { exact: true }).count(), 0);
  followBlock.assertPeersConnected();
  followBlock.release();

  async function formalOnce(page) {
    await page.locator('article.assistant').getByText(answer, { exact: true }).waitFor();
    await page.getByText('本轮结束：completed', { exact: true }).waitFor();
    assert.equal(await page.locator('article.assistant').count(), 1);
    assert.equal(await page.getByText('正在生成', { exact: true }).count(), 0);
  }

  await formalOnce(a);
  await formalOnce(b);
  await directoryLoad(a, () => a.reload());
  await formalOnce(a);
  log('生成中刷新、follow 断线后完成与正式回答去重', {
    streaming, attemptId: start.frame.frame.attemptId,
    assistantMessages: 1, completed: 1, followReconnects: followBlock.blockedAttempts,
  });
  log('Chromium', { version: browser.version() });
} catch (error) {
  failures.push(error);
} finally {
  createGate.resolve();
  verifyGate.resolve();
  modelGate.resolve();
  for (const state of blocks.values()) state.release();
  for (const { proxyResponse, response } of streams) { proxyResponse.destroy(); response.destroy(); }
  const closed = await Promise.allSettled([browser?.close(), web?.close(), app?.close()]);
  SqliteSessionPersistence.prototype.create = originalCreate;
  const removed = await Promise.allSettled([rm(dir, { recursive: true, force: true })]);
  for (const result of [...closed, ...removed]) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (frameError && !failures.includes(frameError)) failures.push(frameError);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, '浏览器验收或资源清理失败');
}
log('PASS', {});

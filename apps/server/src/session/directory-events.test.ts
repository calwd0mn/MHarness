import assert from "node:assert/strict";
import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { SessionDirectoryFrame } from "@mharness/session/contracts";
import Fastify from "fastify";
import { SessionDirectory } from "./directory.ts";
import { registerDirectoryEvents, streamDirectoryEvents } from "./directory-events.ts";

const ready = 'data: {"type":"api-session/ready"}\n\n';
const status = { type: "api-session/status", revision: 1, sessionId: "s", running: true } as const;

test("订阅期间同步发生变更时仍先发送就绪，等待中的取消会退订", async () => {
  const controller = new AbortController();
  let unsubscribeCount = 0;
  const source = {
    onObservation(listener: (frame: SessionDirectoryFrame) => void) {
      listener(status);
      return () => { unsubscribeCount++; };
    },
  };
  const events = streamDirectoryEvents(source, controller.signal);
  try {
    assert.equal((await events.next()).value, ready);
    assert.equal((await events.next()).value, `data: ${JSON.stringify(status)}\n\n`);
    const pending = events.next();
    controller.abort();
    assert.equal((await pending).done, true);
  } finally {
    controller.abort();
    await events.return(undefined);
  }
  assert.equal(unsubscribeCount, 1);
});

test("空闲连接发送心跳注释", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const controller = new AbortController();
  const events = streamDirectoryEvents({ onObservation: () => () => {} }, controller.signal);
  try {
    assert.equal((await events.next()).value, ready);
    const pending = events.next();
    t.mock.timers.tick(15_000);
    assert.equal((await pending).value, ": heartbeat\n\n");
  } finally {
    controller.abort();
    await events.return(undefined);
  }
});

test("慢连接超过缓冲上限后结束并退订", async () => {
  const controller = new AbortController();
  let publish: ((frame: SessionDirectoryFrame) => void) | undefined;
  let unsubscribed = false;
  const events = streamDirectoryEvents({
    onObservation(listener) {
      publish = listener;
      return () => { unsubscribed = true; };
    },
  }, controller.signal);
  try {
    assert.equal((await events.next()).value, ready);
    assert.ok(publish);
    publish({ type: "api-session/error", sessionId: "s", message: "错".repeat(400_000) });
    assert.equal((await events.next()).done, true);
    assert.equal(unsubscribed, true);
  } finally {
    controller.abort();
    await events.return(undefined);
  }
});

test("HTTP 客户端持续暂停时缓冲溢出主动断开并退订", { timeout: 8_000 }, async (t) => {
  const app = Fastify();
  const directory = new SessionDirectory();
  let publish: ((frame: SessionDirectoryFrame) => void) | undefined;
  let unsubscribed = 0;
  t.mock.method(directory, "onObservation", (listener: (frame: SessionDirectoryFrame) => void) => {
    publish = listener;
    return () => { unsubscribed++; };
  });
  registerDirectoryEvents(app, "/events", () => directory);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  let serverSocket: Socket | undefined;
  app.server.once("connection", (socket) => { serverSocket = socket; });
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, t.signal]);
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(`${address}/events`, { agent: false, signal }, resolve);
      request.on("error", reject);
    });
    assert.equal(response.statusCode, 200);
    const [chunk] = await once(response, "data", { signal });
    response.pause();
    assert.equal(String(chunk), ready);
    assert.equal(response.isPaused(), true);
    assert.ok(publish);
    const frame = { type: "api-session/error", sessionId: "s", message: "x".repeat(500_000) } as const;
    // 让写入先填满内核缓冲，后续消息才能形成服务端队列积压。
    for (let index = 0; index < 40 && unsubscribed === 0; index++) {
      publish(frame);
      await setImmediate();
    }
    assert.equal(unsubscribed, 1, "客户端保持暂停时应主动退订");
    assert.ok(serverSocket);
    if (!serverSocket.closed) await once(serverSocket, "close", { signal });
    assert.equal(response.isPaused(), true);
  } finally {
    controller.abort();
    await app.close();
  }
});

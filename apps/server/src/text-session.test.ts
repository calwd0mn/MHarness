import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "node:net";
import { once } from "node:events";
import { createSessionResponseSchema, followFrameSchema } from "@mharness/session/contracts";
import { createEventSessionApp } from "./app.ts";
import { createModelTurnDriver } from "./agent/model-turn.ts";
import { createMockAdapter } from "./model/providers/mock.ts";
import { LlmRuntime } from "./model/runtime.ts";

async function* decodedFrames(response: Response) {
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  try {
    for (;;) {
      const split = buffered.indexOf("\n\n");
      if (split < 0) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += value;
        continue;
      }
      const data = buffered.slice(0, split);
      buffered = buffered.slice(split + 2);
      if (data.startsWith("data: ")) {
        const value: unknown = JSON.parse(data.slice(6));
        yield followFrameSchema.parse(value);
      }
    }
  } finally {
    await reader.cancel();
  }
}

test("创建会话拒绝 JSON null 正文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-null-"));
  const app = await createEventSessionApp(join(dir, "events.sqlite"));
  try {
    const response = await app.inject({
      method: "POST", url: "/api/sessions",
      headers: { "Content-Type": "application/json" }, payload: "null",
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("关闭应用主动释放停止读取的 SSE 连接及会话写入权", { timeout: 8_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-slow-"));
  const app = await createEventSessionApp(join(dir, "events.sqlite"));
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(origin).port) });
  const connected = once(socket, "connect");
  try {
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = createSessionResponseSchema.parse(created.json());
    await connected;
    socket.write(`GET /api/sessions/${sessionId}/follow HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    await once(socket, "data");
    socket.pause();
    await app.close();
    const reopened = await createEventSessionApp(join(dir, "events.sqlite"));
    await reopened.close();
  } finally {
    socket.destroy();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("会话从只读快照切入在线 Turn，重发不产生第二条消息，重连恢复正式回答", { timeout: 8_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-text-"));
  const app = await createEventSessionApp(join(dir, "events.sqlite"));
  const signal = new AbortController();
  const post = (url: string, payload?: object) => app.inject({ method: "POST", url, payload });
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const session = await post("/api/sessions");
    const { sessionId } = createSessionResponseSchema.parse(session.json());
    const url = `/api/sessions/${sessionId}`;
    const open = async () => {
      const response = await fetch(origin + url + "/follow", { signal: signal.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.ok(response.body);
      return response.body.pipeThrough(new TextDecoderStream()).getReader();
    };
    const reader = await open();
    let buffered = "";
    const next = async () => {
      for (;;) {
        const split = buffered.indexOf("\n\n");
        if (split >= 0) {
          const item = buffered.slice(0, split);
          buffered = buffered.slice(split + 2);
          if (!item.startsWith("data: ")) continue;
          const data: unknown = JSON.parse(item.slice(6));
          return followFrameSchema.parse(data);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("实时流提前关闭");
        buffered += value;
      }
    };
    assert.deepEqual(await next(), {
      type: "snapshot", sessionId, inheritedEventCount: 0, cursor: -1, records: [],
      assistantStream: { revision: 0 },
    });
    const unmounted = await post(url + "/cancel");
    assert.equal(unmounted.statusCode, 404);
    assert.deepEqual(unmounted.json(), { code: "session/not-found" });

    const request = { requestId: "retry", content: [{ type: "text", text: "你好" }] };
    const responses = await Promise.all([post(url + "/messages", request), post(url + "/messages", request)]);
    for (const response of responses) {
      assert.equal(response.statusCode, 202);
      assert.deepEqual(response.json(), { accepted: true });
    }
    const records = [];
    let completed = false;
    for (let index = 0; index < 24 && !completed; index++) {
      const frame = await next();
      assert.notEqual(frame.type, "error");
      if (frame.type === "event") {
        records.push(frame.event);
        completed = frame.event.type === "turn/end";
      }
    }
    assert.equal(completed, true);
    assert.deepEqual(records.map((event) => event.seq), records.map((_, index) => index));
    assert.equal(records.filter((event) => event.type === "user/message").length, 1);
    assert.equal(records.filter((event) => event.type === "assistant/message").length, 1);
    assert.equal(records.filter((event) => event.type === "turn/start").length, 1);
    const idle = await post(url + "/cancel");
    assert.deepEqual(idle.json(), { accept: true });

    await reader.cancel();
    const reconnect = await open();
    const snapshot = await reconnect.read();
    assert.match(snapshot.value ?? "", /"type":"assistant\/message"/);
    await reconnect.cancel();
  } finally {
    signal.abort();
    try {
      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("检查点失败经真实 SSE 发布安全错误及失败终态，不调用模型", { timeout: 8_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-checkpoint-"));
  let calls = 0;
  const driver = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => {
      calls++;
      return [{ chunk: { type: "finish", reason: { kind: "stop" } } }];
    }) }),
    config: () => ({ provider: "mock", model: "test" }),
    systemPrompt: () => "",
  });
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, async (context) => {
    const checkpoint = context.session.flush;
    context.session.flush = async () => { throw new Error("private-storage-error"); };
    try {
      await driver(context);
    } finally {
      context.session.flush = checkpoint;
    }
  });
  const controller = new AbortController();
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = createSessionResponseSchema.parse(created.json());
    const url = `/api/sessions/${sessionId}`;
    const stream = decodedFrames(await fetch(origin + url + "/follow", { signal: controller.signal }));
    assert.equal((await stream.next()).value?.type, "snapshot");
    const submit = await app.inject({ method: "POST", url: url + "/messages", payload: {
      requestId: "failure", content: [{ type: "text", text: "test" }],
    } });
    assert.equal(submit.statusCode, 202);
    let error = false;
    let ended = false;
    for await (const frame of stream) {
      assert.notEqual(frame.type, "error");
      assert.doesNotMatch(JSON.stringify(frame), /private-storage-error/);
      if (frame.type === "agent/error") error = true;
      if (frame.type === "event" && frame.event.type === "turn/end") {
        assert.equal(frame.event.data.reason.kind, "error");
        ended = true;
        break;
      }
    }
    assert.equal(calls, 0);
    assert.equal(error, true);
    assert.equal(ended, true);
    const blocked = await app.inject({ method: "POST", url: url + "/messages", payload: {
      requestId: "new", content: [{ type: "text", text: "test" }],
    } });
    assert.equal(blocked.statusCode, 503);
  } finally {
    controller.abort();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("断开 follow 后继续运行，按会话取消保存部分输出并只结算一次", { timeout: 8_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-cancel-"));
  const driver = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => [
      { chunk: { type: "text", delta: "部分输出" } },
      { delayMs: 5_000, chunk: { type: "finish", reason: { kind: "stop" } } },
    ]) }),
    config: () => ({ provider: "mock", model: "test" }),
    systemPrompt: () => "",
  });
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, driver);
  const controller = new AbortController();
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = createSessionResponseSchema.parse(created.json());
    const url = `/api/sessions/${sessionId}`;
    const stream = decodedFrames(await fetch(origin + url + "/follow", { signal: controller.signal }));
    await stream.next();
    const payload = { requestId: "cancel", content: [{ type: "text", text: "test" }] };
    await app.inject({ method: "POST", url: url + "/messages", payload });
    for await (const frame of stream) {
      if (frame.type === "assistant-stream" && frame.frame.type === "chunk") break;
    }
    const busy = await app.inject({ method: "POST", url: url + "/messages", payload: { ...payload, requestId: "other" } });
    assert.equal(busy.statusCode, 409);
    const reconnect = decodedFrames(await fetch(origin + url + "/follow", { signal: controller.signal }));
    const snapshot = (await reconnect.next()).value;
    assert.equal(snapshot?.type, "snapshot");
    assert.ok(snapshot?.type === "snapshot" && snapshot.assistantStream.activeAttempt);
    const cancelled = await app.inject({ method: "POST", url: url + "/cancel" });
    assert.deepEqual(cancelled.json(), { accept: true });
    let attempts = 0;
    for await (const frame of reconnect) {
      if (frame.type === "event" && frame.event.type === "assistant/attempt") {
        attempts++;
        assert.equal(frame.event.data.outcome, "cancelled");
        assert.equal(frame.event.data.text, "部分输出");
      }
      if (frame.type === "event" && frame.event.type === "turn/end") {
        assert.equal(frame.event.data.reason.kind, "aborted");
        break;
      }
    }
    assert.equal(attempts, 1);
  } finally {
    controller.abort();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

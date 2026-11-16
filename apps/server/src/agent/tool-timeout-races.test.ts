import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Session } from "@mharness/session/server";
import { createEventSessionApp } from "../app.ts";
import { createModelTurnDriver } from "./model-turn.ts";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { defineLocalTool, ToolRegistry } from "../tools/registry.ts";
import { defineLocalToolOutput } from "../tools/result.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const scenario of ["timeout-cleanup", "cancel-cleanup", "late-resolve", "late-reject", "before-deadline"] as const) {
  test(`HTTP 与 SQLite 保留工具竞态终态：${scenario}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "tool-race-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "events.sqlite");
    const entered = deferred<void>();
    const work = deferred<number>();
    const finished = [deferred<void>(), deferred<void>()];
    let session: Session | undefined;
    const observed: ReturnType<Session["snapshot"]>["events"][number][] = [];
    let observedFrom = 0;
    let requests = 0;
    let effects = 0;
    let renders = 0;
    let receivedSignal: AbortSignal | undefined;
    const cooperative = scenario.endsWith("cleanup");
    const registry = new ToolRegistry();
    const input = z.strictObject({});
    registry.register(defineLocalTool<typeof input, Promise<number>>({ name: "write", version: "1", description: "write", input,
      sideEffect: "side-effect", approvalPolicy: "allow", cancellationGuarantee: cooperative ? "cooperative-exit" : "none", timeoutMs: 10,
      output: defineLocalToolOutput({ schema: z.number(), render: (_args, value) => { renders++; return [{ type: "text", text: String(value) }]; } }),
      handler: (_args, signal) => { effects++; receivedSignal = signal; entered.resolve(); return work.promise; } }));
    const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => {
      requests++;
      if (requests > 1) return [{ chunk: { type: "finish", reason: { kind: "stop" } } }];
      return [
        { chunk: { type: "tool_call", index: 0, callId: "first", name: "write", argumentsDelta: "{}" } },
        { chunk: { type: "tool_call", index: 1, callId: "tail", name: "write", argumentsDelta: "{}" } },
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ];
    }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
    const app = await createEventSessionApp(path, false, async (context) => {
      session = context.session;
      if (context.turn === 1) {
        observedFrom = session.snapshot().events.length;
        session.on("session/event", (event) => observed.push(event));
      }
      await drive(context);
      await context.session.flush();
      finished[context.turn - 1]?.resolve();
    });
    await app.ready();
    const id: string = (await app.inject({ method: "POST", url: "/api/sessions" })).json().sessionId;
    const url = `/api/sessions/${id}`;
    const prompt = (requestId: string) => app.inject({ method: "POST", url: `${url}/messages`, payload: { requestId, content: [{ type: "text", text: "hello" }] } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      assert.equal((await prompt("one")).statusCode, 202);
      await entered.promise;
      assert.ok(session);
      if (scenario === "before-deadline") {
        work.resolve(7);
      } else if (scenario === "cancel-cleanup") {
        assert.equal((await app.inject({ method: "POST", url: `${url}/cancel` })).statusCode, 202);
      } else {
        t.mock.timers.tick(10);
      }
      if (cooperative) {
        assert.equal(receivedSignal?.aborted, true);
        assert.equal(session.snapshot().events.some((event) => event.type === "turn/end"), false);
        const busy = await prompt("busy");
        assert.equal(busy.statusCode, 409);
        assert.deepEqual(busy.json(), { code: "agent_busy" });
        work.resolve(7);
      }
      await finished[0]!.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const live = session.snapshot().events;
      assert.deepEqual(observed, live.slice(observedFrom));
      const results = live.filter((event) => event.type === "tool/result");
      if (scenario === "before-deadline") {
        assert.deepEqual(results.map((event) => event.data.error?.code), [undefined, undefined]);
        assert.equal(effects, 2);
        assert.equal(renders, 2);
      } else {
        assert.deepEqual(results.map((event) => event.data.error?.code), [scenario === "cancel-cleanup" ? undefined : "TOOL_TIMEOUT", scenario === "cancel-cleanup" ? "ABORTED_BEFORE_DISPATCH" : "TOOL_NOT_STARTED"]);
        assert.equal(effects, 1);
        assert.equal(renders, scenario === "cancel-cleanup" ? 1 : 0);
      }
      assert.deepEqual(results.map((event) => event.data.message.source.callId), ["first", "tail"]);
      for (const result of results) {
        const call = live.find((event) => event.type === "tool/call" && event.data.callId === result.data.message.source.callId);
        assert.equal(Boolean(call), result.data.message.source.callId === "first" || scenario === "before-deadline");
        const declaration = live.find((event) => event.type === "assistant/message" && event.data.message.content.some((part) => part.type === "tool-call" && part.id === result.data.message.source.callId));
        assert.ok(call ?? declaration);
        assert.deepEqual(result.sourceEventSeqs, [(call ?? declaration)!.seq]);
      }
      if (scenario === "before-deadline") {
        assert.deepEqual(results.map((result) => result.data.message.content[0].content), [[{ type: "text", text: "7" }], [{ type: "text", text: "7" }]]);
      }
      assert.equal(live.some((event) => event.type === "user/message" && "requestId" in event.data && event.data.requestId === "busy"), false);
      const history = (await app.inject({ method: "GET", url })).json().records.map((record: { event: unknown }) => record.event);
      assert.deepEqual(history, live);
      if (scenario === "late-resolve") work.resolve(7);
      if (scenario === "late-reject") work.reject(new Error("late"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(session.snapshot().events, live);
      assert.equal(requests, scenario === "before-deadline" ? 2 : 1);
      assert.equal((await prompt("next")).statusCode, 202);
      await finished[1]!.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(requests, scenario === "before-deadline" ? 3 : 2);
      assert.equal(effects, scenario === "before-deadline" ? 2 : 1);
      const finalLive = session.snapshot().events;
      assert.deepEqual((await app.inject({ method: "GET", url })).json().records.map((record: { event: unknown }) => record.event), finalLive);
      await app.close();
      const reopened = await createEventSessionApp(path);
      try {
        assert.deepEqual((await reopened.inject({ method: "GET", url })).json().records.map((record: { event: unknown }) => record.event), finalLive);
      } finally { await reopened.close(); }
    } finally { work.resolve(7); await app.close(); }
  });
}

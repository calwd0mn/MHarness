// @vitest-environment node
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:http2";
import { once } from "node:events";
import { createServer as createViteServer, resolveConfig } from "vite";
import { expect, test } from "vitest";

const within = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} 超时`)), 5000);
  timer.unref();
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

test("开发入口通过 HTTP/2 复用六条 SSE 和普通请求", async () => {
  const upstreamStreams = [];
  const upstream = createHttpServer((request, response) => {
    if (request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { response.writeHead(202, { "content-type": "application/json" }); response.end(JSON.stringify({ body })); });
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.write("data: ready\n\n");
    upstreamStreams.push(response);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  let vite; let client; const streams = [];
  try {
    vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0, strictPort: false, proxy: { "/api": `http://127.0.0.1:${upstreamPort}` } } });
    await vite.listen();
    const port = vite.httpServer.address().port;
    client = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    await within(once(client, "connect"), "TLS 连接");
    expect(client.socket.alpnProtocol).toBe("h2");
    const firstFrames = [];
    for (let index = 0; index < 6; index++) {
      const path = index < 3 ? "/api/session-directory/events" : `/api/sessions/${index}/follow`;
      const stream = client.request({ ":method": "GET", ":path": path });
      streams.push(stream);
      let text = "";
      firstFrames.push(within(new Promise((resolve, reject) => {
        stream.on("error", reject);
        stream.on("data", (chunk) => { text += chunk; if (text.includes("data: ready\n\n")) resolve(); });
      }), `SSE ${index} 首帧`));
    }
    await Promise.all(firstFrames);
    expect(upstreamStreams).toHaveLength(6);
    const nextFrames = streams.map((stream, index) => within(new Promise((resolve, reject) => {
      let text = ""; stream.on("error", reject); stream.on("data", (chunk) => { text += chunk; if (text.includes("data: next\n\n")) resolve(); });
    }), `SSE ${index} 后续帧`));
    const post = client.request({ ":method": "POST", ":path": "/api/sessions/1/messages", "content-type": "application/json" });
    const responseHeaders = within(once(post, "response"), "POST 响应");
    let body = ""; post.setEncoding("utf8"); post.on("data", (chunk) => { body += chunk; });
    const ended = within(once(post, "end"), "POST 正文");
    post.end('{"content":"hello"}');
    const [headers] = await responseHeaders; await ended;
    expect(headers[":status"]).toBe(202);
    expect(JSON.parse(body)).toEqual({ body: '{"content":"hello"}' });
    for (const stream of upstreamStreams) stream.write("data: next\n\n");
    await Promise.all(nextFrames);
  } finally {
    for (const stream of streams) stream.close();
    client?.destroy();
    for (const response of upstreamStreams) response.destroy();
    await vite?.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
}, 15000);

test("本地开发证书不改变 Vite 预览入口", async () => {
  const config = await resolveConfig({ configFile: "vite.config.ts" }, "serve", "production", "production", true);
  expect(config.preview.https !== undefined).toBe(false);
});

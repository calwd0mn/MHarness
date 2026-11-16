import { startMockMcp } from "./server.ts";

const port = Number(process.env.MHARNESS_MOCK_MCP_PORT ?? 3101);
const server = await startMockMcp(port);
process.stdout.write(`模拟 MCP 服务：${server.url}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.close(); });

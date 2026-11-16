import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockMcp } from "./server.ts";

const port = Number(process.env.MHARNESS_MOCK_MCP_PORT ?? 3101);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const databasePath = resolve(repository, process.env.MHARNESS_MOCK_MCP_DB_PATH ?? "data/mock-mcp.sqlite");
await mkdir(dirname(databasePath), { recursive: true });
const server = await startMockMcp(port, databasePath);
process.stdout.write(`模拟 MCP 服务：${server.url}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.close(); });

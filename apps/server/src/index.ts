import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localConfig } from "../../../config/local.ts";
import { createEventSessionApp } from "./app.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { connectMcpTools } from "./tools/mcp.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const configuredPath = process.env[localConfig.sessionDatabasePathVariable];
if (configuredPath !== undefined && !configuredPath.trim()) {
  throw new Error(`${localConfig.sessionDatabasePathVariable} 需要非空的新版数据库路径`);
}
const databasePath = resolve(repository, configuredPath ?? "data/mharness-events.sqlite");
await mkdir(dirname(databasePath), { recursive: true });
const endpoint = process.env.MHARNESS_MCP_ENDPOINT;
const registry = endpoint ? new ToolRegistry() : undefined;
const mcp = endpoint && registry ? await connectMcpTools(registry, endpoint) : undefined;
let app: Awaited<ReturnType<typeof createEventSessionApp>>;
try {
  app = await createEventSessionApp(databasePath, true, undefined, { toolRegistry: registry });
} catch (error) {
  await mcp?.close();
  throw error;
}
if (mcp) app.addHook("onClose", async () => { await mcp.close(); });

function shutdown() {
  void app.close().catch((error: unknown) => {
    app.log.error(error);
    process.exitCode = 1;
  });
}

try {
  await app.listen(localConfig.server);
} catch (error) {
  await app.close();
  throw error;
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

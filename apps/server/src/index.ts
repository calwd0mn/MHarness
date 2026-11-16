import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localConfig } from "../../../config/local.ts";
import { createEventSessionApp } from "./app.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const configuredPath = process.env[localConfig.sessionDatabasePathVariable];
if (configuredPath !== undefined && !configuredPath.trim()) {
  throw new Error(`${localConfig.sessionDatabasePathVariable} 需要非空的新版数据库路径`);
}
const databasePath = resolve(repository, configuredPath ?? "data/mharness-events.sqlite");
await mkdir(dirname(databasePath), { recursive: true });
const app = await createEventSessionApp(databasePath, true);

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

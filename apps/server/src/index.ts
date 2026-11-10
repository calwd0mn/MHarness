import { SessionStore } from "@mharness/session/server";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { localConfig } from "../../../config/local.ts";
import { createApp } from "./app.ts";

const dataDirectory = new URL("../../../data/", import.meta.url);
mkdirSync(dataDirectory, { recursive: true });
const store = new SessionStore(fileURLToPath(new URL("mharness.sqlite", dataDirectory)));
const app = createApp(store, true);

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

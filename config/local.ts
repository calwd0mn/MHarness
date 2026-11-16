export const localConfig = {
  apiPrefix: "/api",
  server: { host: "127.0.0.1", port: 3000 },
  web: { host: "127.0.0.1", port: 5173 },
  sessionDatabasePathVariable: "MHARNESS_SESSION_DB_PATH",
  model: { requestTimeoutMs: 30_000, idleTimeoutMs: 15_000, maxSteps: 8 },
} as const;

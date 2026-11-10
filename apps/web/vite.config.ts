import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localConfig } from "../../config/local.ts";

export default defineConfig({
  plugins: [react()],
  server: {
    ...localConfig.web,
    strictPort: true,
    proxy: {
      [localConfig.apiPrefix]: `http://${localConfig.server.host}:${localConfig.server.port}`,
    },
  },
});

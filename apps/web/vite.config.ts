import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";
import { localConfig } from "../../config/local.ts";

export default defineConfig(({ command, isPreview }) => ({
  plugins: [react(), ...(command === "serve" && !isPreview ? [basicSsl()] : [])],
  server: {
    ...localConfig.web,
    strictPort: true,
    proxy: {
      [localConfig.apiPrefix]: `http://${localConfig.server.host}:${localConfig.server.port}`,
    },
  },
}));

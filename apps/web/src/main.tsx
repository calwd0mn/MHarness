import { healthPath, healthResponseSchema } from "@mharness/protocol";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { localConfig } from "../../../config/local.ts";

function App() {
  const [status, setStatus] = useState("正在检查后端连接…");

  useEffect(() => {
    const controller = new AbortController();

    async function checkConnection() {
      try {
        const response = await fetch(`${localConfig.apiPrefix}${healthPath}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        healthResponseSchema.parse(await response.json());
        setStatus("后端已连接");
      } catch {
        if (!controller.signal.aborted) {
          setStatus("后端连接失败");
        }
      }
    }

    void checkConnection();
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>MHarness</h1>
      <p role="status">{status}</p>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("缺少应用挂载节点");
}
createRoot(container).render(<App />);

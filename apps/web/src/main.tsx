import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./style.css";

const container = document.getElementById("root");
if (!container) throw new Error("缺少应用挂载节点");
createRoot(container).render(<App />);

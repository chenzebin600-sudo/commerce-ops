import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import App from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Growth Radar V2 root element was not found.");
}

createRoot(root).render(<App />);

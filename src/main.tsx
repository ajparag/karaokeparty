import { Buffer } from 'buffer';
// Polyfill Buffer for @gradio/client (uses Node.js Buffer API)
(window as any).Buffer = Buffer;

import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);

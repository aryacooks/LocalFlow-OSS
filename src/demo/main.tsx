// Entry for the website's live demo (see mock.ts). Same App as the real thing,
// on a fake backend, always in the oil theme, with the Theme switch hidden.
import React from "react";
import ReactDOM from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { installDemoBackend } from "./mock";
import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import "../styles/globals.css";
import "../styles/oil.css";
import "./demo.css";

try { localStorage.setItem("localflow-look", "oil"); } catch { /* private mode */ }
document.documentElement.classList.add("oil", "is-demo");
installDemoBackend();

// Import after the fake backend is in place: the store starts calling it on load.
const { default: App } = await import("../App");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MemoryRouter>
      <Routes>
        <Route path="/*" element={<App />} />
      </Routes>
    </MemoryRouter>
  </React.StrictMode>,
);

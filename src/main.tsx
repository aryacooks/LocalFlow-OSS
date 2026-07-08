import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import MicBubble from "./windows/MicBubble";
import "@fontsource-variable/geist";
import "./styles/globals.css";

if (window.location.pathname === "/bubble") {
  document.documentElement.classList.add("bubble-document");
  document.body.classList.add("bubble-body");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/bubble" element={<MicBubble />} />
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import MicBubble from "./windows/MicBubble";
import Placer from "./windows/Placer";
import PasteCard from "./windows/PasteCard";
import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import "./styles/globals.css";
import "./styles/oil.css";

if (window.location.pathname === "/bubble" || window.location.pathname === "/placer" || window.location.pathname === "/card") {
  document.documentElement.classList.add("bubble-document");
  document.body.classList.add("bubble-body");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/bubble" element={<MicBubble />} />
        <Route path="/placer" element={<Placer />} />
        <Route path="/card" element={<PasteCard />} />
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);

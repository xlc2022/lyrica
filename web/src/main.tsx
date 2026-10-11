import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// IBM Plex, self-hosted in the build (web/public/OFL.txt is its licence); the Latin faces only.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./app.css";

// iOS Safari ignores `interactive-widget`: size the app to the visual viewport,
// so the composer stays above the on-screen keyboard.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    if (vv.offsetTop) scrollTo(0, 0);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

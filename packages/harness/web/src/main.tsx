import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

// The shell is viewport-locked (html/body overflow:hidden) — page scroll is
// never legitimate. overflow:hidden stops user scrolling but NOT the
// browser's internal scroll-focused-element-into-view (e.g. xterm's hidden
// helper textarea deep in scrollback), which moves scroll position
// programmatically. Snap back whenever anything manages to move it.
window.addEventListener(
  "scroll",
  () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  },
  { passive: true },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

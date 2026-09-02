import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { agentMapDemoFixtureEnabled } from "./lib/agent-map-demo.js";
import { interceptMockTrack } from "./lib/api.js";
import { observeWindowFocus } from "./lib/window-focus.js";
import { appFrameFromSearch } from "./lib/window-frame.js";
import "./styles.css";
import "./styles/refine.css";

// In mock mode, intercept /api/track calls so Playwright tests can assert
// that track() events fire without a real server. No-op in real mode.
interceptMockTrack();

// The window frame the desktop host handed off (macOS = frameless, traffic
// lights inset into the rail's top line). Set on the root so the window-chrome
// CSS can scope the header padding + drag region to it; a browser stays "web"
// and never pays for either.
document.documentElement.dataset.windowFrame = appFrameFromSearch();

// Frameless macOS hides the traffic lights while the window is blurred, so the
// rail toggle next to them needs its own surface in that state (styles.css).
observeWindowFocus();

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

// A file dropped anywhere the terminal isn't listening must do nothing — the
// browser's default is to NAVIGATE to the file, replacing the whole SPA (and
// in the desktop app, will-navigate hands the file to the OS). Cancelling the
// default here doesn't interfere with real drop targets: their own handlers
// still run first.
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});

const root = createRoot(document.getElementById("root")!);

// Experiment seam: both gates are load-bearing. The Agent Map fixture is a
// browser-only concept surface and must never replace the ordinary Harness in
// a real build or merely because a query string was carried into one.
if (
  import.meta.env.VITE_MOCK === "1" &&
  agentMapDemoFixtureEnabled(import.meta.env.VITE_MOCK, window.location.search)
) {
  void Promise.all([
    import("./components/AgentMapDemo.js"),
    import("./styles/agent-map-demo.css"),
  ]).then(([{ AgentMapDemo }]) => {
    root.render(
      <StrictMode>
        <AgentMapDemo />
      </StrictMode>,
    );
  });
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

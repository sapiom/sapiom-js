---
"@sapiom/harness-desktop": patch
---

Studio: animated rail, back/forward hardening, and dark-mode + control polish

- **Rail collapse/expand now animates** — the left workspace panel slides open/closed (0.22s ease) instead of snapping. It stays resizable and still reflows to its minimum width under space pressure, and it's inert once collapsed.
- **Back/forward navigation** gained unit coverage for the visit-stack reducers, and a fix for a case where replaying a Back/Forward visit whose derived place had since changed kind (e.g. a session whose live CLI has exited) silently truncated the forward stack.
- **Frameless macOS header**: the "sapiom agent.studio" lockup now sits a uniform gap below the window tools instead of a wide chasm under the traffic lights.
- **Icon-only action controls** (Test / Deploy / globe when the bar is narrow) are square rather than wide rectangles.
- **Command palette**: the selected row is legible in dark mode again — it was drawn with the on-green ink colour over a neutral highlight, which made it all but invisible.

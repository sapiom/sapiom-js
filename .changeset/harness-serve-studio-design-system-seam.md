---
"@sapiom/harness": patch
---

Serve the harness web UI from the package build and harden the design-system seam:

- `pnpm build` emits the web app to `dist/web` and the harness server serves it as the SPA (index.html, hashed assets, and client-side deep-route fallback), so `start` and `npx @sapiom/harness` launch the full UI against the real server. Adds a regression test pinning the build → serve path.
- The design system resolves to the real package when it's installed and falls back to a committed neutral, unbranded token set otherwise — so a public build renders legibly out of the box, with no theme source required. The stylesheet only bridges variable names onto tokens; it never redefines a token.

No behavioral or API changes to the harness server.

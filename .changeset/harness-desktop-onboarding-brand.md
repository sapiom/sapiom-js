---
"@sapiom/harness-desktop": patch
---

Rebrand the desktop onboarding window to the new Sapiom identity

The setup window now leads with the real Sapiom wordmark + `agent.studio` lockup — an inlined `currentColor` SVG, identical to the SPA's `BrandLogotype` — instead of a plain-text label, themed to ink in both light and dark.

- **macOS chrome:** the window is borderless (`titleBarStyle: "hiddenInset"`) — no grey title bar, traffic lights kept — and the window itself is the card (paints `--s1` edge to edge; the OS rounds it and adds a shadow). Windows/Linux keep their native frame.
- **CTA:** Continue / Retry use the design system's neutral ink button (`--btn`/`--btn-ink`), never green; the consent checkbox is ink too. Green stays reserved for semantic state.
- **Copy:** the boot status reads "Starting…" (the wordmark already says Sapiom), the consent screen drops the redundant question line (the checkbox is the ask), any detail line that merely echoed the status is suppressed, and the error message is centered.
- The window pre-paints in `--s1` so it no longer flashes before its stylesheet loads.

Contract tests pin the inlined logo, the pre-paint background, and the design-system wiring against silent drift.

---
"@sapiom/harness": patch
---

Studio UI fixes from design review:

- **Canvas chat input**: the "Ask about this agent/step" field is now a clean, boxless single row — no border, padding box, or separator hairline — that auto-grows upward up to five lines (then scrolls) with the Ask button bottom-anchored.
- **Canvas overview card**: no longer repeats the step/exit count or the entry/step/terminal legend that the canvas board already shows; the card focuses on the description, Describe-with-AI, notes, and per-step detail.
- **Rail brand header (frameless macOS)**: the Sapiom wordmark drops off the traffic-light line and reads inline as "sapiom agent.studio"; only the theme/collapse tools ride the lights' line.
- **Account menu**: opening the account menu now collapses the settings card (and vice-versa) so the two never stack; the Workspaces ⋯ menu's Past-sessions sub-card also collapses when a grouping/sort choice is clicked.
- **"Create new"**: promoted above Search as the primary affirmative action, restyled to the app's solid ink-button CTA (the Deploy treatment) with the reserved brand-green plus; the empty-rail state keeps a brand halo.
- **Rail spacing**: top-level rail rows share one icon size, icon–text gap, and left inset.
- **Sign-out**: removed the duplicate Disconnect from the settings panel — signing out now lives once in the account menu, below "Check for updates" and only when signed in.

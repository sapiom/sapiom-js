---
"@sapiom/harness": minor
---

Studio (web app) redesign to match the new brand — Phase 1.

Adopt the shared design-system's named `sapiom-studio` preset in the web app, vendored into the committed public `ds-neutral` fallback so open-source builds and the packaged desktop app both render the new design with no private-registry dependency. This brings Geist typography, compact IDE control/type density, a scarce green brand (green now signals only live/success/on/confirmed), and neutral ink-based focus and selection chrome (previously green-tinted).

The rail brand lockup is now the Sapiom wordmark + `agent.studio` (lowercase mono), matching a new terminal masthead (pixel mark + wordmark + working-directory / status facts) that replaces the old status bar.

The shell reads as three flat blocks — a grey workspace rail, the grey terminal shell, and the raised white graph pane — with no permanent dividers or raised header bands (a header boundary is a lie until content scrolls under it). The affirmative CTA is the theme's ink button, not a green fill; green appears only on genuine state (live, deployed, on, entry/active step, activity).

Main panel: the session bar, tab lane, and action row merge into ONE header. The active session is a title dropdown (copy path, rename, open in editor, end session); the focused agent's other live sessions sit beside it as side-scrollable switch chips with a trailing `+`. The agent actions are Prod (globe) · Test · Run · Deploy, right-anchored, the primary CTA following state (Deploy for a draft, Run for a deployed agent); Draft/Deployed status shows once, in the graph pane's header, never duplicated in the bar.

Rail: Search and Templates are labelled destination rows (Search carries a right-aligned ⌘K / Ctrl+K, not a boxed field), and agent rows drop their leading glyph — indentation carries the nesting under the workspace folder. The `⋯` menu files the explorer by Workspace or Deployment and orders it by recent activity or name, with past sessions opening in a sub-card beside the menu rather than a scrolling list inside it. The footer is one continuous block: a plan summary (demo fixture only; live mode shows none) above the account row, no divider.

Floating menus and dialogs paint an opaque surface (a portaled popover that inherited a translucent inset wash let the rail bleed through it); the canvas board is navigated only by its own zoom/fit/pan controls and never shows native scrollbars; and the canvas resize splitter stays welded to the board's edge at every window width.

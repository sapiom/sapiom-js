---
"@sapiom/harness": minor
---

Studio (web app) redesign to match the new brand — Phase 1.

Adopt the shared design-system's named `sapiom-studio` preset in the web app, vendored into the committed public `ds-neutral` fallback so open-source builds and the packaged desktop app both render the new design with no private-registry dependency. This brings Geist typography, compact IDE control/type density, a scarce green brand (green now signals only live/success/on/confirmed), and neutral ink-based focus and selection chrome (previously green-tinted).

The rail brand lockup is now the Sapiom wordmark + `agent.studio` (lowercase mono), matching the terminal masthead's voice; the S mark is no longer paired with the wordmark.

The shell reads as one continuous surface: the rail and header rows drop their raised bands and permanent underlines (a header boundary is a lie until content scrolls under it), and the affirmative CTA is now the theme's ink button rather than a green fill — green appears only on genuine state (live, deployed, on, entry/active step, activity). The Claude Code harness mark renders in Claude's brand orange.

Rail navigation: Search and Templates are labelled destination rows (Search unboxed with a right-aligned ⌘K / Ctrl+K shortcut, not a boxed field), and agent rows drop their leading glyph — indentation carries the nesting under the workspace folder.

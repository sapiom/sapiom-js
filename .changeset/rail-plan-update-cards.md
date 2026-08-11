---
"@sapiom/harness": minor
"@sapiom/harness-desktop": patch
---

Rail footer: live plan & balance card, and an "Update now" card for a downloaded desktop update

The rail's footer gains two shaded cards above the account row.

- **Plan & balance card** (both hosts): the harness server relays core reads at
  `GET /api/account/plan` — the API key never reaches the page — showing the
  org's plan name and one honest money line: daily spend against the org's
  spend-limit rule (the same "$used / $cap" pair the dashboard renders),
  falling back to the prepaid available balance, else nothing. An Upgrade pill
  and a ⋮ menu deep-link to billing/usage on the dashboard (checkout is
  dashboard-session-only). Signed-out or unreachable hides the card — it never
  invents a number.
- **"Update now" card** (desktop only): when an update has finished
  downloading, the main process pushes state over a new receive-only
  `onUpdateState` bridge member (re-pushed on page load, buffered in the
  preload so a reload can't drop it) and the card appears with the target
  version. Clicking it goes through the existing `checkForUpdates()` — the
  pending branch re-raises the update window — so there is still no
  page-reachable install channel. It outlives "Later"; "Skip this version"
  suppresses and retracts it (and now also disarms auto-install-on-quit for a
  skipped build that was already staged).

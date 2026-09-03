# Studio browser storage: what may live in an origin, and what may not

Audit produced alongside SAP-2991 ("the first-run explainer reappears on every
desktop launch"). It is a list, not a plan: it says which of Studio's
`localStorage` writes hold a fact that must outlive a browser origin, and which
are genuine per-viewer arrangement that is fine where it is.

## The hazard, once

`localStorage` is keyed by ORIGIN, and an origin includes the port. The desktop
app asks the OS for an ephemeral port on every boot
(`packages/harness-desktop/src/main/boot.ts`, `srv.listen(0, "127.0.0.1", …)`),
so launch N is `http://127.0.0.1:52431`, launch N+1 is `http://127.0.0.1:61208`,
and the second one has never seen anything the first one stored.

Two consequences, and the second is easy to miss:

1. **Nothing in `localStorage` survives a desktop restart.** Not "usually" —
   never.
2. **The desktop app and a browser tab pointed at the same server are two
   stores over one server.** Anything stored client-side diverges between them
   even within a single launch.

So the test is not "is this small?" but "is this a fact about the INSTALL, or
about this viewport?" Install facts belong in `~/.sapiom/harness/settings.json`
behind `GET`/`PATCH /api/settings`, or in the project's own
`.sapiom/studio-rail.json`. Viewport arrangement can stay in the origin.

## Install-level facts still in `localStorage`

| Fact | Where it lives | Why it is install-level | Status |
| --- | --- | --- | --- |
| First-run explainer seen | was `sapiom-harness-help-seen` | "I have already been told what a project is" is true of the person, not the port | **Fixed** — now `HarnessSettings.helpSeen` (SAP-2991) |
| Removal tombstones | `ui-prefs.closedProjects` | A project the user REMOVED from the rail comes straight back on the next launch, wearing the cwd of a session that already ended. Two halves (`recentDirs` server-side, the tombstone client-side), two places, two lifetimes | **Open** — tracked separately, and the highest-value remaining case. Needs a server endpoint rather than a settings field: it is per-project |
| Session renames | `ui-prefs.sessionNames` | The session is a server record that outlives the page; its name is the user's word for that record. A rename made in the desktop app is invisible in a browser tab on the same server, and gone next launch | **Open** — the field's own comment says it is parked there because "the server has no rename endpoint yet" |
| Preferred agent for new sessions | `ui-prefs.preferredHarness` | A default, not a layout. Resets to the built-in default every desktop launch | **Open** — small; a `HarnessSettings` field |
| Theme | `sapiom-harness-theme` | An explicit light/dark choice is a preference. With nothing stored the app defaults to light, so on desktop a user who selects dark loses it every launch | **Open** — the awkward one: `web/index.html` reads this key in an inline script before any module loads, to avoid a flash of the wrong theme, and a server round-trip cannot happen that early. Fixing it means the boot HTML carrying the stored value, not just moving the key |

## Genuine per-viewer arrangement — leave it

These are about this window on this screen. Losing them on a new launch is
mildly annoying at worst, and none of them is a claim about the install.

- `ui-prefs.railCollapsed`, `rightCollapsed`, `rightTab` — which panes are open.
- `ui-prefs.collapsedKeys` — which rows are folded.
- `ui-prefs.railAxis`, `railSort` — how the explorer is filed and ordered.
- `ui-prefs.canvasInspectorHeight` — a dragged panel height.
- `sapiom-harness-pane-widths` (`lib/use-pane-widths.ts`) — column widths.

Note that the group ARRANGEMENT itself is already server-side, in each
project's `.sapiom/studio-rail.json` — it is the project's shape rather than
this browser's preference, and it travels with the repo. That is the precedent
for `closedProjects` too.

## Not a hazard: the mock's stores

`MockApi` in `web/src/lib/api.ts` writes `localStorage` under
`sapiom-mock-studio-rail:*` and `sapiom-mock-help-seen`. Those are fixtures
standing in for server-side files, used because `localStorage` is the only
store in a Playwright page that outlives a reload. They ship in the mock build
only and are not subject to any of the above.

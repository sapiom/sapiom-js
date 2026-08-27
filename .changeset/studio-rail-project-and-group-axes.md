---
"@sapiom/harness": minor
---

Agent Studio's left rail is rebuilt around where an agent **is** and what it is **related to**, and it can now move an agent's directory on disk.

**Two axes, chosen from the rail's own `Group by` control.** *Project* files every agent under the project roots that contain it — the folder you opened, a folder you have a session in — with the branching directories between them as rows. An agent inside two roots you both opened appears under both; they are two contexts, and the old longest-prefix rule made the shallower project silently lose agents it plainly contained. *Group* is the arrangement you make yourself: named groups per project root, seeded from the launch edges between agents and then yours to edit. The **Deployment axis is retired** — an agent's deploy state is a badge on its row, not a place it lives.

**`Remove project`** takes a root off the rail without touching anything on disk.

**`POST /api/agents/move` renames a directory in your working tree.** This is the Project axis's drag, and it is a real filesystem move, not a display preference: dropping an agent on a folder relocates that agent's directory there — `git mv` when the directory is tracked in a git repo, a plain rename otherwise. Nothing inside `sapiom.json` is rewritten, live sessions whose cwd sat inside the moved tree follow it, and the endpoint refuses on its own findings (a destination that exists, a destination inside the source, a `from` that is not a registered agent, or a destination outside the folders the rail shows) rather than trusting the caller.

**New local REST surfaces** on the same `127.0.0.1` boot-token-gated `/api` mount as the rest:

- `GET`/`PUT`/`DELETE /api/studio-rail` — the stored Group-axis arrangement, one `.sapiom/studio-rail.json` per project root. It is a committable file, so a team can share an arrangement. Writable roots are exactly the roots the rail can show.
- `GET /api/studio-rail/launch-edges` — which agents launch which, across every registered agent, used to seed groups.
- `POST /api/agents/move` — above.

**Stored UI state resets once on upgrade, deliberately.** The rail's preferences moved to keys that can name a project, a directory or a group rather than only a cwd: `collapsedCwds` → `collapsedKeys` (namespaced `project:` / `dir:` / `group:`) and `railGrouping` → `railAxis`. The old values are not migrated — they describe a rail that no longer exists — so after upgrading, every fold is open and the axis is back to *Project*. Set them again once and they stick.

There is no migration for project roots either: every directory already in your recents, and every live session's cwd, becomes a project row. Nothing is discarded, and `Remove project` is how the list gets shorter.

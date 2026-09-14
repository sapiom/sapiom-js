# Assistant lifecycle review evidence

Disposable Studio browser fixtures for https://linear.app/sapiom/issue/SAP-3292. This orphan branch is evidence only and must never merge.

Before/after images describe states before and after an explicit user action, not a historical pre-implementation baseline. All initial images and the Terminal video use controlled browser API fixtures. The video shows Continue → paused Assistant → explicit Start Terminal → return to the same paused Assistant. The Terminal is blank because that fixture does not launch a PTY. These fixtures do not prove native execution or an installed activated release.

No baseline feature-before image was captured for the recorded-history pane (#1008); its screenshot shows the resulting read-only reconstructed record. Private canonical design references and raw runtime/model evidence are deliberately excluded.

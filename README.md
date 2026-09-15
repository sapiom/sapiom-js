# Assistant lifecycle review evidence

Disposable Studio browser fixtures for https://linear.app/sapiom/issue/SAP-3292. This orphan branch is evidence only and must never merge.

Before/after images describe states before and after an explicit user action, not a historical pre-implementation baseline. All initial images and the Terminal video use controlled browser API fixtures. The video shows Continue → paused Assistant → explicit Start Terminal → return to the same paused Assistant. The Terminal is blank because that fixture does not launch a PTY. These fixtures do not prove native execution or an installed activated release.

No baseline feature-before image was captured for the recorded-history pane (#1008); its screenshot shows the resulting read-only reconstructed record. Private canonical design references and raw runtime/model evidence are deliberately excluded.

The native-lifecycle media uses the actual source-built SPA, Studio server, corrected native runtime and real bash PTY, with disposable loopback account/model fixtures. It shows Continue paused, explicit Send, End, same-ID paused Resume, explicit Start Terminal and final End. The 14-second viewport video was decoded and visually reviewed. All five managed processes were confirmed absent after cleanup. This is E2 source/candidate evidence, not a signed or activated production install.

The #1041 image pair shows pending Start before its held acknowledgement and Terminal after it, using the isolated UI fixture with a blank PTY.

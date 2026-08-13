---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

Clicking a link in the terminal opens the actual URL instead of a macOS "no application set to open the URL about:blank" dialog

The xterm web-links addon's default activation opens a blank window first and
assigns `location.href` afterwards. The desktop app's window-open handler
intercepts that first call, sees only `about:blank`, and hands it to the OS —
which has no handler for that scheme, so the link dies in a system dialog. The
terminal now passes the clicked URL directly to `window.open`, and the desktop
host additionally refuses to hand anything but `http(s):`/`mailto:` URLs to
`shell.openExternal`.

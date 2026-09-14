# Ending a Studio session

With the End coordinator installed, `DELETE /api/sessions/:id` ends the selected
Studio session's managed Terminal and Assistant runtimes. It uses the existing
per-boot token; an expired Assistant grant does not prevent local End. A normal
Terminal exit or a detached browser does not End the Assistant session.

End fences Assistant admission and requests both runtime shutdowns synchronously,
before awaiting storage. Concurrent requests for the same ID share the complete
operation, including final persistence. A completed retry checks both engines
again, since a new Terminal incarnation can exist under the same Assistant header.
Successful repeats keep the session ended and may advance its lifecycle revision.

The response is `200 { ok: true, lifecycle }` after confirmed cleanup and durable
`ended` metadata. Missing registry rows return `404`. Failed or incomplete cleanup,
failed storage, or the five-second operation deadline returns
`409 { ok: false, code: "cleanup_unconfirmed", error }`. The row and history remain
available. A deadline does not claim to cancel underlying filesystem writes;
admission remains fenced until confirmed cleanup and final persistence complete.

The coordinator reads the original lifecycle before writing `ending`. A saved
`ending` from a prior host cannot be cleared merely because the current host has
no runtime: positive cleanup evidence is required for both engines. This code
does not recover missing prior-host process ownership. Such unresolved sessions
remain `ending`; restarting Studio or repeating End cannot establish missing
process evidence. Different Studio IDs remain independent, including IDs in the
same folder. Routers without the coordinator retain their legacy Terminal close.

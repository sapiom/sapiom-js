/**
 * Terminal express error middleware — every route's `next(err)` lands here.
 *
 * Returns the real message (and errno-style `code`), not a generic string: on
 * the packaged desktop app this body is the only diagnostic anyone can see —
 * the GUI-subsystem exe has no console, so the `console.error` below is lost
 * to the void on Windows. fs.ts and macros.ts already answer their 500s with
 * the raw message; the server binds 127.0.0.1 behind a per-boot token, so the
 * message is not crossing a trust boundary.
 */
import type express from "express";

export function unhandledRequestErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
): void {
  console.error("[harness] unhandled request error:", err);
  const message = err instanceof Error && err.message ? err.message : "internal error";
  const code = (err as { code?: unknown } | null)?.code;
  res.status(500).json({ error: message, ...(typeof code === "string" ? { code } : {}) });
}

/**
 * Boot-token auth: every /api request (X-Harness-Token header) and every WS
 * upgrade (token query param) is checked against the same per-boot secret.
 */

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Constant-time string comparison — avoids leaking token length/prefix via timing. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare something of equal length anyway so this branch doesn't
    // resolve measurably faster than a real (mismatched-content) comparison.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function createBootTokenMiddleware(bootToken: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.header("X-Harness-Token") ?? "";
    if (!timingSafeEqualString(provided, bootToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

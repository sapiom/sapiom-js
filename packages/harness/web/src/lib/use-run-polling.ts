/**
 * Thin React hook that drives the run-poll controller from the event bus.
 *
 * When an `execution.started` bus message arrives with `target === "prod"`, the
 * controller starts polling `/api/runs/:id/state` every ~2 s. The returned map
 * is updated live as each poll resolves; polling stops automatically when the
 * run reaches a terminal status (completed / failed / cancelled).
 *
 * App wiring (passing `lastMessage` down, rendering the map) is intentionally
 * deferred to the next leaf (C1) — this file is machinery only.
 */
import { useEffect, useRef, useState } from "react";

import type { BusMessage, RunView } from "@shared/types";

import { createApi } from "./api";
import { createRunPollController } from "./run-poll-controller";
import type { RunPollController } from "./run-poll-controller";

// Module-level singleton — same pattern as use-harness-state's `const api`.
const api = createApi();

export function useRunPolling(
  lastMessage: BusMessage | null,
): Map<string, RunView> {
  const [runViews, setRunViews] = useState<Map<string, RunView>>(new Map());
  const controllerRef = useRef<RunPollController | null>(null);

  // Lazy-init the controller once; it persists for the component's lifetime.
  if (controllerRef.current === null) {
    controllerRef.current = createRunPollController({
      fetchRunState: (id, signal) => api.getRunState(id, signal),
      onUpdate: (id, rv) =>
        setRunViews((prev) => {
          const next = new Map(prev);
          next.set(id, rv);
          return next;
        }),
    });
  }

  // Start polling when an execution begins on the prod target.
  useEffect(() => {
    if (
      lastMessage?.type === "execution.started" &&
      lastMessage.target === "prod"
    ) {
      controllerRef.current!.start(lastMessage.executionId);
    }
  }, [lastMessage]);

  // Pause / resume when the tab visibility changes.
  useEffect(() => {
    const controller = controllerRef.current!;

    const onVisibilityChange = (): void => {
      controller.setPaused(document.hidden);
    };

    // Reflect the initial hidden state in case the hook mounts in a background tab.
    controller.setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Stop all polling on unmount.
  useEffect(() => {
    const controller = controllerRef.current!;
    return () => {
      controller.stopAll();
    };
  }, []);

  return runViews;
}

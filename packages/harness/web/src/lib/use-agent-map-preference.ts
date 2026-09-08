import { useCallback, useEffect, useRef, useState } from "react";
import type { HarnessSettings } from "@shared/types";

type MapLayout = "classic" | "elk";
const LEGACY_KEY = "sapiom-agent-map-layout";
const valid = (value: unknown): value is MapLayout =>
  value === "classic" || value === "elk";

export interface AgentMapLayoutPreference {
  mode: MapLayout;
  setMode: (mode: MapLayout) => void;
  error: string | null;
}

// Settings survive desktop's changing localhost port. Browser storage is only
// read to migrate an explicit choice from the comparison release.
export function useAgentMapPreference(
  settings: HarnessSettings | null,
  update: (patch: Partial<HarnessSettings>) => Promise<HarnessSettings>,
): AgentMapLayoutPreference {
  const [choice, setChoice] = useState<MapLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initial] = useState(() => {
    const query = new URLSearchParams(window.location.search).get("mapLayout");
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem(LEGACY_KEY);
    } catch {
      /* optional migration */
    }
    return {
      query: valid(query) ? query : null,
      legacy: valid(legacy) ? legacy : null,
    };
  });
  const migrated = useRef(false);
  const writes = useRef(Promise.resolve());
  const revision = useRef(0);
  const save = useCallback(
    (mode: MapLayout): void => {
      const current = ++revision.current;
      setError(null);
      // Serialize rapid toggles so an older response cannot win on disk.
      writes.current = writes.current.then(async () => {
        try {
          await update({ agentMapLayout: mode });
          try {
            localStorage.removeItem(LEGACY_KEY);
          } catch {
            /* optional migration */
          }
        } catch {
          if (current === revision.current)
            setError("Couldn't save layout preference");
        }
      });
    },
    [update],
  );
  useEffect(() => {
    if (!settings || migrated.current) return;
    migrated.current = true;
    if (!valid(settings.agentMapLayout) && initial.legacy && choice === null)
      save(initial.legacy);
  }, [settings, initial, choice, save]);

  return {
    mode:
      choice ??
      initial.query ??
      (valid(settings?.agentMapLayout)
        ? settings.agentMapLayout
        : (initial.legacy ?? "elk")),
    error,
    setMode: (mode) => {
      setChoice(mode);
      save(mode);
      const url = new URL(window.location.href);
      if (url.searchParams.has("mapLayout")) {
        url.searchParams.set("mapLayout", mode);
        window.history.replaceState(window.history.state, "", url);
      }
    },
  };
}

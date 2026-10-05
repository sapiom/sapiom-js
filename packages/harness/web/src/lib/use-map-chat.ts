/**
 * THE MAP CHAT's client state, per project (flow-map-chat-overlay.md 4.3,
 * design-map-chat.md §1).
 *
 * The conversation itself is the server's: one OpenCode host per project, keyed
 * `map:<projectId>`, whose `association.json` keeps it across reloads (design
 * Q2). What the client holds is only what the server cannot know:
 *
 *  - whether the card shows the chat or the composer, per project, so leaving
 *    the project and coming back shows what was left there;
 *  - a question asked from the card's composer, waiting for the chat to mount
 *    and send it;
 *  - which hand-off cards already started their session, so the card says
 *    Open session instead of offering a second one;
 *  - the session a hand-off just made, for the rail's one pulse (4.3.6).
 *
 * Held by the shell, above the project view, so none of it is lost when the
 * centre switches to a session and back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatDraft } from "../components/OpenCodeChat";
import { mapChatHostKey } from "./map-chat-host";

export interface MapChatState {
  isOpen: (projectId: string) => boolean;
  setOpen: (projectId: string, open: boolean) => void;
  /** Bumped by New chat: the chat remounts and attaches the fresh one. */
  revision: (projectId: string) => number;
  /** New chat (P2 reset route). Resolves false when the server refused. */
  reset: (projectId: string) => Promise<boolean>;
  /** Queue a prompt for the chat to send once it is ready, and open it. */
  ask: (projectId: string, prompt: string) => void;
  /** The queued prompt, removed as it is read. */
  takePending: (projectId: string) => string | null;
  /** The session a hand-off card made, by its tool call id. */
  handoffSession: (callId: string) => string | null;
  setHandoffSession: (callId: string, sessionId: string) => void;
  /** The last hand-off session, for the rail's pulse; `at` restarts it. */
  pulse: { sessionId: string; at: number } | null;
  /** The chat composer's unsent text, per project. */
  draft: (projectId: string) => ChatDraft;
  /**
   * Whether this account may use the Assistant (`/api/assistant/access`).
   * Only a definite "no" hides the card's composer; an unanswered check
   * leaves it, since the host enforces its own grant on every request.
   */
  canAsk: boolean;
}

export function useMapChat({
  bootToken,
  authRevision,
}: {
  bootToken: string | null;
  authRevision: number;
}): MapChatState {
  const [open, setOpenMap] = useState<Readonly<Record<string, boolean>>>({});
  const [revisions, setRevisions] = useState<Readonly<Record<string, number>>>(
    {},
  );
  const [handoffs, setHandoffs] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [pulse, setPulse] = useState<MapChatState["pulse"]>(null);
  const pending = useRef(new Map<string, string>());
  const drafts = useRef(new Map<string, ChatDraft>());
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setAllowed(null);
    void fetch("/api/assistant/access", {
      headers: { "X-Harness-Token": bootToken ?? "" },
      credentials: "omit",
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) return false;
        if (!response.ok) return null;
        const { enabled } = (await response.json()) as { enabled?: unknown };
        return typeof enabled === "boolean" ? enabled : null;
      })
      .catch(() => null)
      .then((value) => {
        if (!abort.signal.aborted) setAllowed(value);
      });
    return () => abort.abort();
  }, [bootToken, authRevision]);

  const draft = useCallback((projectId: string): ChatDraft => {
    let entry = drafts.current.get(projectId);
    if (!entry) {
      entry = { text: "" };
      drafts.current.set(projectId, entry);
    }
    return entry;
  }, []);

  const setOpen = useCallback((projectId: string, next: boolean) => {
    setOpenMap((current) =>
      current[projectId] === next ? current : { ...current, [projectId]: next },
    );
  }, []);

  const reset = useCallback(
    async (projectId: string): Promise<boolean> => {
      pending.current.delete(projectId);
      try {
        const response = await fetch(
          `/opencode/${encodeURIComponent(mapChatHostKey(projectId))}/reset`,
          {
            method: "POST",
            headers: { "X-Harness-Token": bootToken ?? "" },
            credentials: "omit",
          },
        );
        await response.body?.cancel();
        if (!response.ok) return false;
      } catch {
        return false;
      }
      setRevisions((current) => ({
        ...current,
        [projectId]: (current[projectId] ?? 0) + 1,
      }));
      setOpen(projectId, true);
      return true;
    },
    [bootToken, setOpen],
  );

  const ask = useCallback(
    (projectId: string, prompt: string) => {
      pending.current.set(projectId, prompt);
      setOpen(projectId, true);
    },
    [setOpen],
  );

  const takePending = useCallback((projectId: string): string | null => {
    const prompt = pending.current.get(projectId) ?? null;
    pending.current.delete(projectId);
    return prompt;
  }, []);

  const setHandoffSession = useCallback((callId: string, sessionId: string) => {
    setHandoffs((current) => ({ ...current, [callId]: sessionId }));
    setPulse({ sessionId, at: Date.now() });
  }, []);

  return useMemo(
    () => ({
      isOpen: (projectId: string) => open[projectId] === true,
      setOpen,
      revision: (projectId: string) => revisions[projectId] ?? 0,
      reset,
      ask,
      takePending,
      handoffSession: (callId: string) => handoffs[callId] ?? null,
      setHandoffSession,
      pulse,
      draft,
      canAsk: allowed !== false,
    }),
    [
      open,
      revisions,
      handoffs,
      pulse,
      allowed,
      setOpen,
      reset,
      ask,
      takePending,
      setHandoffSession,
      draft,
    ],
  );
}

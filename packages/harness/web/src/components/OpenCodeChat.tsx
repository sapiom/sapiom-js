import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ThreadComposerRuntime,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  createOpencodeClient,
  useOpenCodeRuntime,
  useOpenCodeThreadState,
} from "@assistant-ui/react-opencode";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { EmptyState } from "./EmptyState";
import { HandoffCard } from "./HandoffCard";
import { askChipLabel, parseAskPrompt } from "../lib/map-ask";
import {
  HANDOFF_TOOL,
  latestTurnOffersHandoff,
} from "../lib/map-chat-host";
import {
  finalResponseAgent,
  turnRecoveryAgent,
  openCodeTurn,
  openCodeResult,
} from "../../../src/shared/opencode-turn";
import {
  openCodeCompletionTokens,
  openCodeVisibleParts,
  openCodeVisibleText,
} from "../../../src/shared/opencode-completion";
import {
  parseOpenCodeStudioErrorEvent,
  parseOpenCodeTransportErrorBody,
  type OpenCodeTransportAction,
  type OpenCodeTransportFailure,
} from "../../../src/shared/opencode-errors";

export interface ChatDraft {
  text: string;
}
/** In-memory only: App owns one store for the current authenticated principal. */
export type ChatDraftStore = Map<string, ChatDraft>;

/**
 * The project's MAP CHAT variant (flow-map-chat-overlay.md 4.3): the same
 * conversation machinery, addressed by the map-chat host key instead of a
 * session id, with what only the map chat has. Absent for a session's
 * Assistant, which renders exactly as before.
 */
export interface MapChatSurface {
  /** "Ask about <selection>", following the map's pick (4.1.2, 4.2.1). */
  placeholder: string;
  /** The question with the selection's context line ahead of it (Q4). Read at
   *  send time, so a pick mid-chat moves the next message's chip. */
  composePrompt: (question: string) => string;
  /** A question asked from the card before the chat was open, sent once. */
  takePending: () => string | null;
}

interface Props {
  harnessSessionId: string;
  bootToken: string;
  draft: ChatDraft;
  onSignIn: () => void;
  onOpenSettings: () => void;
  onOpenTerminal: () => void;
  mapChat?: MapChatSurface;
}
interface RecoveryNotice {
  message: string;
  action: OpenCodeTransportAction;
}
/** OpenCode's error name for an answer stopped by an abort. */
const ABORTED = "MessageAbortedError";

/** The latest answer was stopped by an abort (Stop), not failed. */
function latestAnswerAborted(
  messages: readonly { info?: { role: string; error?: unknown } }[],
): boolean {
  const answer = [...messages].reverse().find((message) => message.info?.role === "assistant");
  const error = answer?.info?.error as { name?: unknown } | undefined;
  return error?.name === ABORTED;
}

const reconnectNotice = (message: string): RecoveryNotice => ({
  message,
  action: "reconnect",
});
const connectionError = reconnectNotice(
  "Connection lost. Reconnect to see the latest response.",
);
const runError = reconnectNotice(
  "Assistant could not finish. Reconnect and check the conversation before sending again.",
);
const openError = reconnectNotice(
  "Assistant could not open. Check Studio sign-in and workspace access, then retry.",
);
const requestError = reconnectNotice(
  "Could not load or send the message. Reconnect and check the conversation before sending again.",
);

/** The parser returns the shared table entry, never the server's string. */
const trustedNotice = (failure: OpenCodeTransportFailure): RecoveryNotice => ({
  message: failure.message,
  action: failure.action,
});

async function responseFailure(
  response: Response,
): Promise<OpenCodeTransportFailure | null> {
  try {
    return parseOpenCodeTransportErrorBody(await response.clone().json());
  } catch {
    return null;
  }
}

export function OpenCodeChat({
  harnessSessionId,
  bootToken,
  draft,
  onSignIn,
  onOpenSettings,
  onOpenTerminal,
  mapChat,
}: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<RecoveryNotice | null>(null);
  const [attempt, setAttempt] = useState(0);
  const baseUrl = new URL(
    `/opencode/${encodeURIComponent(harnessSessionId)}`,
    window.location.origin,
  ).toString();
  useEffect(() => {
    const abort = new AbortController();
    setConversationId(null);
    setError(null);
    void fetch(`${baseUrl}/attach`, {
      method: "POST",
      headers: { "X-Harness-Token": bootToken },
      credentials: "omit",
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const failure = await responseFailure(response);
          if (!abort.signal.aborted)
            setError(failure ? trustedNotice(failure) : openError);
          return;
        }
        const data = await response.json();
        if (
          typeof data.conversationId !== "string" ||
          !data.conversationId.startsWith("ses_")
        )
          throw new Error("invalid association");
        if (!abort.signal.aborted) setConversationId(data.conversationId);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(openError);
      });
    return () => abort.abort();
  }, [baseUrl, bootToken, attempt]);
  const retry = useCallback(() => {
    setConversationId(null);
    setError(null);
    setAttempt((value) => value + 1);
  }, []);
  return conversationId ? (
    <RuntimeChat
      key={`${conversationId}:${attempt}`}
      baseUrl={baseUrl}
      bootToken={bootToken}
      conversationId={conversationId}
      retry={retry}
      draft={draft}
      onSignIn={onSignIn}
      onOpenSettings={onOpenSettings}
      onOpenTerminal={onOpenTerminal}
      mapChat={mapChat}
    />
  ) : (
    <div className="studio-chat-start">
      {error ? (
        <Recovery
          notice={error}
          retry={retry}
          onSignIn={onSignIn}
          onOpenSettings={onOpenSettings}
          onOpenTerminal={onOpenTerminal}
        />
      ) : (
        <span role="status">Opening Assistant…</span>
      )}
    </div>
  );
}

function RuntimeChat({
  baseUrl,
  bootToken,
  conversationId,
  retry,
  draft,
  onSignIn,
  onOpenSettings,
  onOpenTerminal,
  mapChat,
}: {
  baseUrl: string;
  bootToken: string;
  conversationId: string;
  retry: () => void;
  draft: ChatDraft;
  onSignIn: () => void;
  onOpenSettings: () => void;
  onOpenTerminal: () => void;
  mapChat?: MapChatSurface;
}) {
  // Read at send time through a ref: the client below is built once per
  // conversation, and the selection it prefixes changes under it.
  const composePromptRef = useRef(mapChat?.composePrompt);
  composePromptRef.current = mapChat?.composePrompt;
  const [transportError, setTransportError] = useState<RecoveryNotice | null>(
    null,
  );
  const [actionError, setActionError] = useState<RecoveryNotice | null>(null);
  const [connected, setConnected] = useState(false);
  const eventAbort = useRef<AbortController | null>(null);
  const reconcile = useCallback(() => {
    // The adapter reconnects this display stream and reloads history/status.
    // Keep its controller mounted so answers, tool output, and drafts stay put.
    setConnected(false);
    eventAbort.current?.abort();
  }, []);
  const onError = useCallback(() => setActionError(requestError), []);
  const onTypedError = useCallback((failure: OpenCodeTransportFailure) => {
    setConnected(false);
    setActionError(trustedNotice(failure));
  }, []);
  const client = useMemo(() => {
    const client = createOpencodeClient({
      baseUrl,
      headers: { "X-Harness-Token": bootToken },
      credentials: "omit",
      fetch: async (input, init) => {
        let request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const root = new URL(`${baseUrl}/session/${conversationId}`).pathname;
        const composePrompt = composePromptRef.current;
        if (
          composePrompt &&
          request.method === "POST" &&
          path === `${root}/prompt_async`
        ) {
          // The map chat's context line (Q4) rides the stored prompt, so the
          // chip is read back from history and survives a reload.
          const body = (await request.clone().json()) as {
            parts?: { type?: string; text?: string }[];
          };
          const part = body.parts?.find((candidate) => candidate.type === "text");
          if (part && typeof part.text === "string") {
            part.text = composePrompt(part.text);
            request = new Request(request, { body: JSON.stringify(body) });
          }
        }
        const required =
          path === root ||
          path === `${root}/message` ||
          path.endsWith("/experimental/session");
        try {
          const response = await globalThis.fetch(request);
          if (!response.ok) {
            const failure = await responseFailure(response);
            if (failure) onTypedError(failure);
            else if (required) onError();
          }
          return response;
        } catch (error) {
          if (required && !request.signal.aborted) onError();
          throw error;
        }
      },
    });
    const subscribe = client.event.subscribe.bind(client.event);
    client.event.subscribe = async (parameters, options) => {
      const abort = new AbortController();
      eventAbort.current = abort;
      const result = await subscribe(parameters, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal, abort.signal])
          : abort.signal,
        onSseError(error) {
          options?.onSseError?.(error);
          if (!options?.signal?.aborted && !abort.signal.aborted) {
            setConnected(false);
            setTransportError(connectionError);
          }
        },
        onSseEvent(event) {
          if (!options?.signal?.aborted && !abort.signal.aborted) {
            const failure = parseOpenCodeStudioErrorEvent(event.data);
            if (failure) {
              onTypedError(failure);
              return;
            }
            const data = event.data as {
              type?: string;
              properties?: { sessionID?: string; error?: { name?: string } };
            };
            // A terminal Studio error is valid only through the exact shared
            // host-generated shape above. Native/malformed lookalikes and
            // unscoped session errors cannot poison this conversation.
            if (data.type === "studio.error") return;
            if (data.type === "session.error") {
              if (data.properties?.sessionID !== conversationId) return;
              options?.onSseEvent?.(event);
              // Stop (and New chat) abort the answer on purpose: OpenCode
              // reports that as a session error, but the conversation is
              // fine and must stay usable (P2's abort route).
              if (data.properties?.error?.name !== ABORTED) setActionError(runError);
              return;
            }
            options?.onSseEvent?.(event);
            setConnected(true);
            setTransportError(null);
          }
        },
      });
      return {
        ...result,
        stream: (async function* () {
          try {
            yield* result.stream;
          } finally {
            if (eventAbort.current === abort) eventAbort.current = null;
            if (!options?.signal?.aborted) {
              setConnected(false);
              if (!abort.signal.aborted) setTransportError(connectionError);
            }
          }
        })(),
      };
    };
    // This pinned adapter's title hook invokes compaction. OpenCode already
    // generates titles; suppress that unrelated model action, as in the POC.
    client.session.summarize = async () => ({ data: true }) as never;
    return client;
  }, [baseUrl, bootToken, conversationId, onError, onTypedError]);
  const runtime = useOpenCodeRuntime({
    client,
    initialSessionId: conversationId,
    onError,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatSurface
        baseUrl={baseUrl}
        bootToken={bootToken}
        conversationId={conversationId}
        connected={connected}
        reconcile={reconcile}
        error={actionError ?? transportError}
        retry={retry}
        composer={runtime.thread.composer}
        draft={draft}
        onSignIn={onSignIn}
        onOpenSettings={onOpenSettings}
        onOpenTerminal={onOpenTerminal}
        onTypedError={onTypedError}
        mapChat={mapChat}
      />
    </AssistantRuntimeProvider>
  );
}

const ToolProgress = ({
  toolName,
  status,
  isError,
}: ToolCallMessagePartProps) => (
  <div className="studio-chat-meta">
    {toolName} ·{" "}
    {isError
      ? "Failed"
      : status.type === "running"
        ? "Working…"
        : status.type === "requires-action"
          ? "Waiting"
          : status.type === "incomplete"
            ? "Interrupted"
            : "Complete"}
  </div>
);

function ChatSurface({
  baseUrl,
  bootToken,
  conversationId,
  connected,
  reconcile,
  error,
  retry,
  composer,
  draft,
  onSignIn,
  onOpenSettings,
  onOpenTerminal,
  onTypedError,
  mapChat,
}: {
  baseUrl: string;
  bootToken: string;
  conversationId: string;
  connected: boolean;
  reconcile: () => void;
  error: RecoveryNotice | null;
  retry: () => void;
  composer: ThreadComposerRuntime;
  draft: ChatDraft;
  onSignIn: () => void;
  onOpenSettings: () => void;
  onOpenTerminal: () => void;
  onTypedError: (failure: OpenCodeTransportFailure) => void;
  mapChat?: MapChatSurface;
}) {
  const loading = useAuiState((s) => s.thread.isLoading);
  const running = useAuiState((s) => s.thread.isRunning);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const ready = useOpenCodeThreadState(
    (s) => s.sessionId === conversationId && s.loadState.type === "ready",
  );
  useLayoutEffect(() => {
    if (!ready) return;
    composer.setText(draft.text);
    return composer.subscribe(() => {
      draft.text = composer.getState().text;
    });
  }, [composer, draft, ready]);
  // A question asked from the map card before this chat existed: sent once,
  // as soon as the conversation can take it, leaving any draft in place.
  const takePending = mapChat?.takePending;
  const sendable = ready && connected && !running && !loading;
  useEffect(() => {
    if (!takePending || !sendable) return;
    const question = takePending();
    if (!question) return;
    const kept = composer.getState().text;
    composer.setText(question);
    void composer.send();
    composer.setText(kept);
  }, [composer, sendable, takePending]);
  const native = useOpenCodeThreadState((s) => s);
  const completionTokens = useMemo(
    () =>
      openCodeCompletionTokens(
        native.messageOrder
          .map((id) => native.messagesById[id]!)
          .filter(Boolean),
      ),
    [native.messageOrder, native.messagesById],
  );
  const nativeMessages = native.messageOrder
    .map((id) => native.messagesById[id]!)
    .filter(Boolean);
  const nativeTurn = openCodeTurn(nativeMessages, native.sessionStatus?.type);
  // A map-chat turn that ended in a hand-off card did what it should: the
  // model often marks it failed because the work was not done here (P2's
  // real check). The card is the outcome, so it is neither shown as a
  // failure nor sent for a "final response" (design §4.4).
  const handedOff = mapChat != null && latestTurnOffersHandoff(nativeMessages);
  // An answer the user stopped reads as Stopped, not Failed.
  const stopped =
    nativeTurn.status === "failed" && latestAnswerAborted(nativeMessages);
  const turn = handedOff
    ? {
        status:
          nativeTurn.status === "failed" || nativeTurn.status === "stopped"
            ? ("finished" as const)
            : nativeTurn.status,
      }
    : stopped
      ? { status: "stopped" as const }
      : nativeTurn;
  const attempted = useRef(new Set<string>());
  const recoveryAbort = useRef<AbortController | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const missing = "missing" in turn ? turn.missing : undefined;
  const pending = Object.values(native.pendingUserMessages).some(
    (message) => message.status === "pending",
  );
  useEffect(() => {
    if (!error) return;
    recoveryAbort.current?.abort();
    recoveryAbort.current = null;
    setRecovering(false);
  }, [error]);
  useEffect(() => {
    if (
      !ready ||
      !connected ||
      error ||
      running ||
      pending ||
      !missing ||
      attempted.current.has(missing)
    )
      return;
    attempted.current.add(missing);
    setRecovering(true);
    setRecoveryFailed(false);
    const abort = new AbortController();
    recoveryAbort.current?.abort();
    recoveryAbort.current = abort;
    // The host verifies native history and allows one continuation.
    // Never resend the original prompt on idle, disconnect, or remount.
    void fetch(`${baseUrl}/session/${conversationId}/final-response`, {
      method: "POST",
      headers: {
        "X-Harness-Token": bootToken,
        "Content-Type": "application/json",
      },
      credentials: "omit",
      body: JSON.stringify({ messageId: missing }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(130_000)]),
    })
      .then(async (response) => {
        if (!response.ok) {
          const failure = await responseFailure(response);
          if (failure) {
            // A typed terminal rejection is not a failed recovery attempt the
            // composer may work around. Keep the incomplete turn blocked and
            // expose its exact static action without submitting anything else.
            onTypedError(failure);
            return;
          }
          throw new Error("Final response failed");
        }
        reconcile(); // Catch up on missed final events without resetting chat.
      })
      .catch(() => {
        if (!abort.signal.aborted) setRecoveryFailed(true);
      })
      .finally(() => {
        if (recoveryAbort.current === abort) recoveryAbort.current = null;
        setRecovering(false);
      });
  }, [
    baseUrl,
    bootToken,
    connected,
    conversationId,
    error,
    missing,
    pending,
    ready,
    reconcile,
    running,
    onTypedError,
  ]);
  const failed = useOpenCodeThreadState(
    (s) => s.loadState.type === "error" || s.runState.type === "error",
  );
  const visibleError = error ?? (failed ? runError : null);
  const requestsCurrent =
    native.sync.permissionsCurrent && native.sync.questionsCurrent;
  const waiting =
    requestsCurrent &&
    (Object.keys(native.interactions.permissions.pending).length > 0 ||
      Object.keys(native.interactions.questions.pending).length > 0);
  const checking =
    !connected ||
    !ready ||
    !requestsCurrent ||
    loading ||
    turn.status === "unknown";
  const catchingUp =
    connected &&
    !ready &&
    native.loadState.type === "loading" &&
    native.messageOrder.length > 0;
  const working =
    !visibleError &&
    (running ||
      recovering ||
      turn.status === "working" ||
      pending ||
      (!!missing && !attempted.current.has(missing)));
  const status = visibleError
    ? "Failed"
    : checking
      ? catchingUp
        ? "Catching up…"
        : "Checking status…"
      : waiting
        ? "Waiting for input"
        : working
          ? "Working"
          : turn.status === "finished"
            ? "Finished"
            : turn.status === "failed" || recoveryFailed
              ? "Failed"
              : turn.status === "stopped"
                ? "Stopped"
                : "Ready";
  return (
    <ThreadPrimitive.Root
      className="studio-chat"
      aria-label="Assistant conversation"
    >
      <ThreadPrimitive.Viewport
        className="studio-chat-viewport"
        scrollToBottomOnRunStart={false}
      >
        <div className="studio-chat-feed">
          <ThreadPrimitive.Empty>
            {mapChat ? (
              <p className="map-chat-empty" data-testid="map-chat-empty">
                Ask about the map. Work that needs a session comes back as a
                card you can start.
              </p>
            ) : (
              <EmptyState
                title="Start a conversation"
                body="Describe the change you want to make in this project."
              />
            )}
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => {
              const nativeMessage = native.messagesById[message.id];
              const token =
                nativeMessage?.info?.role === "assistant"
                  ? completionTokens.get(nativeMessage.info.parentID)
                  : undefined;
              const result = openCodeResult(nativeMessage, token);
              const visibleParts = openCodeVisibleParts(
                message.content,
                token,
                nativeMessage?.info?.role === "assistant" &&
                  !nativeMessage.info.time.completed,
              );
              return message.role === "user" &&
                [finalResponseAgent, turnRecoveryAgent].includes(
                  native.messagesById[message.id]?.info?.agent ?? "",
                ) ? null : (
                <MessagePrimitive.Root
                  className={
                    message.role === "user"
                      ? "studio-chat-user"
                      : "studio-chat-assistant"
                  }
                >
                  {message.content.map((part, index) =>
                    part.type === "text" ? (
                      message.role === "user" ? (
                        mapChat ? (
                          <MapChatQuestion key={index} text={part.text} />
                        ) : (
                          <p key={index} className="studio-chat-user-text">
                            {part.text}
                          </p>
                        )
                      ) : result ? null : (
                        <Markdown
                          key={index}
                          text={visibleParts[index] ?? ""}
                        />
                      )
                    ) : (
                      <MessagePrimitive.PartByIndex
                        key={index}
                        index={index}
                        components={{
                          tools: mapChat
                            ? {
                                by_name: { [HANDOFF_TOOL]: HandoffCard },
                                Fallback: ToolProgress,
                              }
                            : { Fallback: ToolProgress },
                        }}
                      />
                    ),
                  )}
                  {result && (
                    <Markdown
                      text={openCodeVisibleText(result.answer, token)}
                    />
                  )}
                  <MessagePrimitive.Error>
                    <ErrorPrimitive.Root className="studio-chat-error">
                      <ErrorPrimitive.Message />
                    </ErrorPrimitive.Root>
                  </MessagePrimitive.Error>
                </MessagePrimitive.Root>
              );
            }}
          </ThreadPrimitive.Messages>
          {status === "Failed" && !visibleError && (
            <div className="studio-chat-error" role="alert">
              Assistant could not complete this request. Review the response
              above and send a follow-up to continue.
            </div>
          )}
          {status === "Stopped" && (
            <div className="studio-chat-meta" role="note">
              Assistant has stopped. Completion was not confirmed; review the
              response above before continuing.
            </div>
          )}
          {visibleError && (
            <Recovery
              notice={visibleError}
              retry={retry}
              onSignIn={onSignIn}
              onOpenSettings={onOpenSettings}
              onOpenTerminal={onOpenTerminal}
            />
          )}
        </div>
      </ThreadPrimitive.Viewport>
      <div className="studio-chat-dock">
        <div
          role="status"
          aria-label="Assistant status"
          className={
            "status-tag studio-chat-status" +
            (mapChat ? " visually-hidden" : "")
          }
          data-status={status}
        >
          <span className="status-tag-dot" aria-hidden="true" />
          {status}
          {recovering ? " · Continuing unfinished work…" : ""}
        </div>
        <ComposerPrimitive.Root className="studio-chat-composer">
          <ComposerPrimitive.Input
            className="studio-chat-input"
            data-testid={mapChat ? "chat-input" : undefined}
            aria-label={mapChat ? "Ask the map chat" : "Message Assistant"}
            placeholder={mapChat?.placeholder ?? "Describe the change you want"}
            minRows={1}
            maxRows={6}
            submitMode="enter"
            cancelOnEscape={false}
            addAttachmentOnPaste={false}
            disabled={
              !connected ||
              !ready ||
              loading ||
              disabled ||
              !!visibleError ||
              recovering ||
              (!!missing && !recoveryFailed)
            }
          />
          <div className="studio-chat-actions">
            {mapChat && running ? (
              /* Stop (P2's abort route): the send button's place while a reply
                 streams, as in the mock's composer. */
              <ComposerPrimitive.Cancel
                className="composer-send is-stop"
                data-testid="chat-submit"
                data-pending="true"
                aria-label="Stop"
                data-tooltip="Stop"
              >
                <Icon name="Square" size={12} />
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send
                className="composer-send"
                data-testid={mapChat ? "chat-submit" : undefined}
                aria-label="Send message"
                disabled={
                  !connected ||
                  !ready ||
                  !!visibleError ||
                  working ||
                  (!!missing && !recoveryFailed)
                }
              >
                <Icon name="ArrowUp" size={14} />
              </ComposerPrimitive.Send>
            )}
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}

/**
 * A map-chat question as the feed shows it: the user's own words, and the chip
 * naming what was selected when it was asked (Q4). The stored prompt carries
 * the context line ahead of the words; the row keeps it on `data-prompt`.
 */
function MapChatQuestion({ text }: { text: string }) {
  const { subject, question } = parseAskPrompt(text);
  return (
    <div className="map-chat-question" data-prompt={text}>
      <p className="studio-chat-user-text">{question}</p>
      {subject && (
        <span
          className="map-chat-chip"
          data-testid="chat-context-chip"
          data-tooltip={subject.path}
        >
          <Icon name="Zap" size={11} />
          <span>{askChipLabel(subject)}</span>
        </span>
      )}
    </div>
  );
}

function Recovery({
  notice,
  retry,
  onSignIn,
  onOpenSettings,
  onOpenTerminal,
}: {
  notice: RecoveryNotice;
  retry: () => void;
  onSignIn: () => void;
  onOpenSettings: () => void;
  onOpenTerminal: () => void;
}) {
  const action = {
    sign_in: { label: "Sign in", run: onSignIn },
    open_settings: { label: "Open Settings", run: onOpenSettings },
    open_terminal: { label: "Open Terminal", run: onOpenTerminal },
    reconnect: { label: "Reconnect", run: retry },
  } satisfies Record<
    OpenCodeTransportAction,
    { label: string; run: () => void }
  >;
  return (
    <div className="studio-chat-error" role="alert">
      <p>{notice.message}</p>
      <button
        type="button"
        className="btn-ghost"
        onClick={action[notice.action].run}
      >
        {action[notice.action].label}
      </button>
    </div>
  );
}

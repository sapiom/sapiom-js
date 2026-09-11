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
import {
  finalResponseAgent,
  turnRecoveryAgent,
  openCodeTurn,
  openCodeResult,
} from "../../../src/shared/opencode-turn";
import {
  openCodeCompletionTokens,
  openCodeVisibleParts,
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
interface Props {
  harnessSessionId: string;
  bootToken: string;
  draft: ChatDraft;
  onSignIn: () => void;
  onOpenSettings: () => void;
  onOpenTerminal: () => void;
}
interface RecoveryNotice {
  message: string;
  action: OpenCodeTransportAction;
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
}: {
  baseUrl: string;
  bootToken: string;
  conversationId: string;
  retry: () => void;
  draft: ChatDraft;
  onSignIn: () => void;
  onOpenSettings: () => void;
  onOpenTerminal: () => void;
}) {
  const [transportError, setTransportError] = useState<RecoveryNotice | null>(
    null,
  );
  const [actionError, setActionError] = useState<RecoveryNotice | null>(null);
  const [connected, setConnected] = useState(false);
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
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const root = new URL(`${baseUrl}/session/${conversationId}`).pathname;
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
      const result = await subscribe(parameters, {
        ...options,
        onSseError(error) {
          options?.onSseError?.(error);
          if (!options?.signal?.aborted) {
            setConnected(false);
            setTransportError(connectionError);
          }
        },
        onSseEvent(event) {
          if (!options?.signal?.aborted) {
            const failure = parseOpenCodeStudioErrorEvent(event.data);
            if (failure) {
              onTypedError(failure);
              return;
            }
            const data = event.data as {
              type?: string;
              properties?: { sessionID?: string };
            };
            // A terminal Studio error is valid only through the exact shared
            // host-generated shape above. Native/malformed lookalikes and
            // unscoped session errors cannot poison this conversation.
            if (data.type === "studio.error") return;
            if (data.type === "session.error") {
              if (data.properties?.sessionID !== conversationId) return;
              options?.onSseEvent?.(event);
              setActionError(runError);
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
            if (!options?.signal?.aborted) {
              setConnected(false);
              setTransportError(connectionError);
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
        error={actionError ?? transportError}
        retry={retry}
        composer={runtime.thread.composer}
        draft={draft}
        onSignIn={onSignIn}
        onOpenSettings={onOpenSettings}
        onOpenTerminal={onOpenTerminal}
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
  error,
  retry,
  composer,
  draft,
  onSignIn,
  onOpenSettings,
  onOpenTerminal,
}: {
  baseUrl: string;
  bootToken: string;
  conversationId: string;
  connected: boolean;
  error: RecoveryNotice | null;
  retry: () => void;
  composer: ThreadComposerRuntime;
  draft: ChatDraft;
  onSignIn: () => void;
  onOpenSettings: () => void;
  onOpenTerminal: () => void;
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
  const turn = openCodeTurn(
    native.messageOrder.map((id) => native.messagesById[id]!).filter(Boolean),
    native.sessionStatus?.type,
  );
  const attempted = useRef(new Set<string>());
  const recoveryAbort = useRef<AbortController | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const missing = turn.missing;
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
      .then((response) => {
        if (!response.ok) throw new Error("Final response failed");
        retry(); // Reconcile history even if the last text event was missed.
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
    retry,
    running,
  ]);
  const failed = useOpenCodeThreadState(
    (s) => s.loadState.type === "error" || s.runState.type === "error",
  );
  const visibleError = error ?? (failed ? runError : null);
  const checking = !connected || !ready || loading || turn.status === "unknown";
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
      ? "Checking status…"
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
            <EmptyState
              title="Start a conversation"
              body="Describe the change you want to make in this project."
            />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => {
              const nativeMessage = native.messagesById[message.id];
              const token =
                nativeMessage?.info?.role === "assistant"
                  ? completionTokens.get(nativeMessage.info.parentID)
                  : undefined;
              const result = openCodeResult(nativeMessage, token);
              const visibleParts = openCodeVisibleParts(message.content, token);
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
                        <p key={index} className="studio-chat-user-text">
                          {part.text}
                        </p>
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
                        components={{ tools: { Fallback: ToolProgress } }}
                      />
                    ),
                  )}
                  {result && <Markdown text={result.answer} />}
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
          className="status-tag studio-chat-status"
          data-status={status}
        >
          <span className="status-tag-dot" aria-hidden="true" />
          {status}
          {recovering ? " · Continuing unfinished work…" : ""}
        </div>
        <ComposerPrimitive.Root className="studio-chat-composer">
          <ComposerPrimitive.Input
            className="studio-chat-input"
            aria-label="Message Assistant"
            placeholder="Describe the change you want"
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
            <ComposerPrimitive.Send
              className="composer-send"
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
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
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

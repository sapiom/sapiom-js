import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type TextMessagePartProps,
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

export interface ChatDraft {
  text: string;
}
/** In-memory only: App owns one store for the current authenticated principal. */
export type ChatDraftStore = Map<string, ChatDraft>;
interface Props {
  harnessSessionId: string;
  bootToken: string;
  draft: ChatDraft;
}
const connectionError =
  "Connection lost. Reconnect to see the latest response.";
const runError =
  "Assistant could not finish. Reconnect and check the conversation before sending again.";

export function OpenCodeChat({ harnessSessionId, bootToken, draft }: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        if (!response.ok) throw new Error("attach failed");
        const data = await response.json();
        if (
          typeof data.conversationId !== "string" ||
          !data.conversationId.startsWith("ses_")
        )
          throw new Error("invalid association");
        if (!abort.signal.aborted) setConversationId(data.conversationId);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError(
            "Assistant could not open. Check Studio sign-in and workspace access, then retry.",
          );
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
    />
  ) : (
    <div className="studio-chat-start">
      {error ? (
        <Recovery message={error} retry={retry} />
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
}: {
  baseUrl: string;
  bootToken: string;
  conversationId: string;
  retry: () => void;
  draft: ChatDraft;
}) {
  const [transportError, setTransportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const onError = useCallback(
    () =>
      setActionError(
        "Could not load or send the message. Reconnect and check the conversation before sending again.",
      ),
    [],
  );
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
          if (!response.ok && required) onError();
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
          options?.onSseEvent?.(event);
          if (!options?.signal?.aborted) {
            const data = event.data as { type?: string };
            if (data.type === "session.error") setActionError(runError);
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
  }, [baseUrl, bootToken, conversationId, onError]);
  const runtime = useOpenCodeRuntime({
    client,
    initialSessionId: conversationId,
    onError,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatSurface
        conversationId={conversationId}
        connected={connected}
        error={transportError ?? actionError}
        retry={retry}
        composer={runtime.thread.composer}
        draft={draft}
      />
    </AssistantRuntimeProvider>
  );
}

const AssistantText = ({ text }: TextMessagePartProps) => (
  <Markdown text={text} />
);
const UserText = ({ text }: TextMessagePartProps) => (
  <p className="studio-chat-user-text">{text}</p>
);
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
  conversationId,
  connected,
  error,
  retry,
  composer,
  draft,
}: {
  conversationId: string;
  connected: boolean;
  error: string | null;
  retry: () => void;
  composer: ThreadComposerRuntime;
  draft: ChatDraft;
}) {
  const loading = useAuiState((s) => s.thread.isLoading);
  const running = useAuiState((s) => s.thread.isRunning);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const ready = useOpenCodeThreadState(
    (s) => s.sessionId === conversationId && s.loadState.type === "ready",
  );
  useEffect(() => {
    if (!ready) return;
    composer.setText(draft.text);
    return composer.subscribe(() => {
      draft.text = composer.getState().text;
    });
  }, [composer, draft, ready]);
  const hasText = useAuiState((s) => {
    for (let i = s.thread.messages.length - 1; i >= 0; i--) {
      const message = s.thread.messages[i];
      if (message.role === "user") return false;
      if (
        message.content.some(
          (part) => part.type === "text" && part.text.length > 0,
        )
      )
        return true;
    }
    return false;
  });
  const failed = useOpenCodeThreadState(
    (s) => s.loadState.type === "error" || s.runState.type === "error",
  );
  const visibleError = error ?? (failed ? runError : null);
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
            {({ message }) => (
              <MessagePrimitive.Root
                className={
                  message.role === "user"
                    ? "studio-chat-user"
                    : "studio-chat-assistant"
                }
              >
                <MessagePrimitive.Parts
                  components={{
                    Text: message.role === "user" ? UserText : AssistantText,
                    tools: { Fallback: ToolProgress },
                  }}
                />
                <MessagePrimitive.Error>
                  <ErrorPrimitive.Root className="studio-chat-error">
                    <ErrorPrimitive.Message />
                  </ErrorPrimitive.Root>
                </MessagePrimitive.Error>
              </MessagePrimitive.Root>
            )}
          </ThreadPrimitive.Messages>
          {(!connected || !ready || loading || (running && !hasText)) &&
            !visibleError && (
              <div role="status" className="studio-chat-meta">
                {!connected
                  ? "Connecting…"
                  : loading || !ready
                    ? "Loading conversation…"
                    : "Assistant is working…"}
              </div>
            )}
          {visibleError && <Recovery message={visibleError} retry={retry} />}
        </div>
      </ThreadPrimitive.Viewport>
      <div className="studio-chat-dock">
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
              !connected || !ready || loading || disabled || !!visibleError
            }
          />
          <div className="studio-chat-actions">
            <ComposerPrimitive.Send
              className="composer-send"
              aria-label="Send message"
              disabled={!connected || !ready || !!visibleError}
            >
              <Icon name="ArrowUp" size={14} />
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}

function Recovery({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="studio-chat-error" role="alert">
      <p>{message}</p>
      <button type="button" className="btn-ghost" onClick={retry}>
        Reconnect
      </button>
    </div>
  );
}

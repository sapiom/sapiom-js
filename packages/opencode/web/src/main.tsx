import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  useOpenCodePermissions,
  useOpenCodeRuntime,
  useOpenCodeThreadState,
} from "@assistant-ui/react-opencode";
import { createRoot } from "react-dom/client";
import { useMemo } from "react";

import { createAssistantUiOpenCodeClient } from "./openCodeClient";
import "./styles.css";

function App() {
  const client = useMemo(
    () => createAssistantUiOpenCodeClient("/opencode"),
    [],
  );
  const runtime = useOpenCodeRuntime({
    client,
    onError: (error) => console.error("OpenCode runtime", error),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Shell />
    </AssistantRuntimeProvider>
  );
}

function Shell() {
  const loadState = useOpenCodeThreadState((state) => state.loadState.type);
  const runState = useOpenCodeThreadState((state) => state.runState.type);

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Sapiom × OpenCode</p>
          <h1>Headless harness POC</h1>
        </div>
        <div className="status" data-state={runState}>
          <span />
          {loadState === "ready" ? runState : loadState}
        </div>
      </header>

      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="viewport">
          <ThreadPrimitive.Empty>
            <section className="empty-state">
              <p>One thin UI. OpenCode owns the loop, tools, and events.</p>
              <p>Try: “List this project’s top-level files.”</p>
            </section>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.role === "user" ? <UserMessage /> : <AssistantMessage />
            }
          </ThreadPrimitive.Messages>

          <PermissionRequests />

          <ThreadPrimitive.ViewportFooter className="footer">
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </main>
  );
}

function PermissionRequests() {
  const { pending, reply } = useOpenCodePermissions();
  if (pending.length === 0) return null;

  return (
    <section className="permissions" aria-live="polite">
      {pending.map((request) => (
        <article key={request.id}>
          <div>
            <strong>{request.title ?? request.permission}</strong>
            <small>{request.patterns.join(", ")}</small>
          </div>
          <div className="permission-actions">
            <button onClick={() => void reply(request.id, "reject")}>
              Deny
            </button>
            <button onClick={() => void reply(request.id, "once")}>
              Allow once
            </button>
            {request.always.length > 0 ? (
              <button onClick={() => void reply(request.id, "always")}>
                Always allow
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </section>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user-message">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message assistant-message">
      <MessagePrimitive.Parts components={{ tools: { Fallback: ToolCall } }} />
    </MessagePrimitive.Root>
  );
}

function ToolCall({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps) {
  return (
    <details className="tool" open={status.type === "running"}>
      <summary>
        <span>{toolName}</span>
        <small>{status.type}</small>
      </summary>
      <pre>{JSON.stringify(result ?? args, null, 2)}</pre>
    </details>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input
        autoFocus
        className="composer-input"
        id="opencode-prompt"
        placeholder="Ask OpenCode to inspect or change this project…"
      />
      <ComposerPrimitive.Send className="send">Send</ComposerPrimitive.Send>
      <ComposerPrimitive.Cancel className="cancel">
        Stop
      </ComposerPrimitive.Cancel>
    </ComposerPrimitive.Root>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root");
createRoot(root).render(<App />);

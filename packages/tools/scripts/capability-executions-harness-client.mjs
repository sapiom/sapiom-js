import { fork } from "node:child_process";
import { EventEmitter } from "node:events";

/** Small, bounded IPC transport shared by the real backend harness and SDK subprocesses. */
export function launch(modulePath, options = {}) {
  const child = fork(modulePath, {
    ...options,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const events = new EventEmitter();
  const messages = [];
  let failure;
  // Drain outputs without putting potentially sensitive framework logs in evidence.
  child.stdout.resume();
  child.stderr.resume();
  child.on("message", (message) => {
    messages.push(message);
    events.emit("message", message);
  });
  child.on("error", () => {
    failure = new Error("Fixture process failed to start.");
    events.emit("failure", failure);
  });
  child.on("exit", (code, signal) => {
    failure = new Error(`Fixture exited (${signal ?? code}).`);
    events.emit("failure", failure);
  });
  const wait = (predicate, timeoutMs = 30_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        events.off("message", onMessage);
        events.off("failure", onFailure);
      };
      const onMessage = (message) => {
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      };
      const onFailure = (error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Fixture IPC timed out."));
      }, timeoutMs);
      events.on("message", onMessage);
      events.once("failure", onFailure);
    });
  };
  let seq = 0;
  return {
    child,
    wait,
    send: (message) => child.send(message),
    async control(action, options = {}) {
      const id = `control-${++seq}`;
      child.send({ id, type: "control", action, options });
      const message = await wait(
        (message) => message.id === id && message.type === "response",
        // Core permits a 45-second worker bootstrap before reporting failure.
        action === "worker" ? 60_000 : 30_000,
      );
      if (message.error)
        throw new Error(`Harness ${action} failed: ${message.error}`);
      return message.result;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    },
  };
}

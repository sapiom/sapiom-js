import { execFile, spawn } from "node:child_process";

const running = new Set<() => Promise<void>>();
let stopping = false;

export async function stopAgentUpdateCommands(): Promise<void> {
  stopping = true;
  await Promise.allSettled([...running].map((stop) => stop()));
}

interface WindowsProcess {
  pid: number;
  parentPid: number;
  createdAt: number;
}

interface ProcessIdentity {
  pid: number;
  startedAt: number;
  spawnedAt: number;
  exitedAt?: number;
}

// Windows can reuse npm's PID after it exits; validate the process lifetime.
export function windowsUpdateTree(
  snapshot: WindowsProcess[],
  identity: ProcessIdentity,
  stoppedAt: number,
): WindowsProcess[] {
  const root = snapshot.find((entry) => entry.pid === identity.pid);
  if (
    root &&
    (identity.exitedAt !== undefined ||
      root.createdAt < identity.startedAt ||
      root.createdAt > identity.spawnedAt)
  )
    return [];
  const queue = [
    root ?? { pid: identity.pid, parentPid: 0, createdAt: identity.startedAt },
  ];
  const found = root ? [root] : [];
  const seen = new Set([identity.pid]);
  for (const parent of queue) {
    for (const entry of snapshot) {
      if (
        entry.parentPid !== parent.pid ||
        seen.has(entry.pid) ||
        entry.createdAt < parent.createdAt
      )
        continue;
      if (
        !root &&
        parent.pid === identity.pid &&
        entry.createdAt > (identity.exitedAt ?? stoppedAt)
      )
        continue;
      seen.add(entry.pid);
      queue.push(entry);
      found.push(entry);
    }
  }
  return found.reverse();
}

function powershell(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });
}

async function stopWindowsTree(identity: ProcessIdentity): Promise<void> {
  const stoppedAt = Date.now();
  const raw = await powershell(
    "@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='parentPid';e={$_.ParentProcessId}}, @{n='createdAt';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}}) | ConvertTo-Json -Compress",
  );
  try {
    const parsed: unknown = JSON.parse(raw);
    const snapshot = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (entry): entry is WindowsProcess =>
        entry &&
        Number.isInteger(entry.pid) &&
        Number.isInteger(entry.parentPid) &&
        Number.isInteger(entry.createdAt),
    );
    const tree = windowsUpdateTree(snapshot, identity, stoppedAt);
    if (!tree.length) return;
    // Pin the handle and match its creation time before killing a Windows PID.
    await powershell(
      tree
        .map(
          (entry) =>
            `$p = $null; try { $p = Get-Process -Id ${entry.pid} -ErrorAction Stop; $null = $p.Handle; if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -eq ${entry.createdAt}) { $p.Kill() } } catch {} finally { if ($null -ne $p) { $p.Dispose() } }`,
        )
        .join("; "),
    );
  } catch {
    /* A failed snapshot must not authorize terminating unrelated processes. */
  }
}

export interface UpdateCommandResult {
  ok: boolean;
  stdout: string;
  detail: string;
}

/** Stop installers and their children on timeout or shutdown. */
export function runUpdateCommand(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onLine?: (line: string) => void;
  },
): Promise<UpdateCommandResult> {
  if (stopping)
    return Promise.resolve({
      ok: false,
      stdout: "",
      detail: "Studio is quitting",
    });
  return new Promise((resolve) => {
    let stdout = "";
    let detail = "";
    let timedOut = false;
    const startedAt = Date.now();
    const child = spawn(command, args, {
      env: options.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const spawnedAt = Date.now();
    let exitedAt: number | undefined;
    child.once("exit", () => {
      exitedAt = Date.now();
    });
    let finished = false;
    let cleanup: Promise<void> | undefined;
    const finish = (ok: boolean, reason = detail): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      running.delete(cancel);
      resolve({ ok, stdout, detail: reason });
    };
    const stop = (reason: string): Promise<void> => {
      cleanup ??= (async () => {
        if (child.pid) {
          if (process.platform === "win32")
            await stopWindowsTree({
              pid: child.pid,
              startedAt,
              spawnedAt,
              exitedAt,
            });
          else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Parent/group already exited. */
            }
          }
          child.kill("SIGKILL");
        }
        // Descendants may retain pipes even after their parent exits.
        child.stdout.destroy();
        child.stderr.destroy();
        finish(false, reason);
      })();
      return cleanup;
    };
    const cancel = (): Promise<void> => stop("Studio is quitting");
    running.add(cancel);
    const timer = setTimeout(() => {
      timedOut = true;
      void stop(`Timed out after ${options.timeoutMs}ms`);
    }, options.timeoutMs);
    timer.unref();
    const output = (chunk: Buffer, isStdout: boolean): void => {
      const text = chunk.toString("utf8");
      if (isStdout) stdout = (stdout + text).slice(-65_536);
      detail = (detail + text).slice(-8_192);
      for (const line of text.split(/\r?\n/).filter(Boolean))
        options.onLine?.(line);
    };
    child.stdout.on("data", (chunk: Buffer) => output(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => output(chunk, false));
    child.once("error", (err) => {
      finish(false, err.message);
    });
    child.once("close", (code) => {
      if (!cleanup && !timedOut) finish(code === 0);
    });
  });
}

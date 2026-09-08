import type { ELK } from "elkjs/lib/elk-api";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";
import {
  createElkGraph,
  readElkGraph,
  type ElkLayoutInput,
} from "./elk-graph-layout";
import type { DirectedGraphLayout } from "./directed-graph-layout";

export class ElkLayoutWorker {
  private engine: ELK | null = null;
  private worker: Worker | null = null;
  private pending: ((error: Error) => void) | null = null;
  private request = 0;

  constructor(
    private readonly createWorker = () => new Worker(workerUrl),
    private readonly timeoutMs = 30_000,
  ) {}

  private stopWorker(): void {
    const engine = this.engine,
      worker = this.worker;
    this.engine = null;
    this.worker = null;
    if (engine) engine.terminateWorker();
    else worker?.terminate(); // ELK construction can fail after the factory creates a worker.
  }

  layout(
    input: ElkLayoutInput,
    signal: AbortSignal,
  ): Promise<DirectedGraphLayout> {
    this.pending?.(new Error("Layout superseded"));
    const request = ++this.request;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending = null;
      };
      const fail = (error: Error) => {
        if (settled) return;
        cleanup();
        this.stopWorker();
        reject(error);
      };
      const abort = () => fail(new Error("Layout cancelled"));
      const timer = setTimeout(
        () => fail(new Error("Layout timed out")),
        this.timeoutMs,
      );
      this.pending = fail;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void import("elkjs/lib/elk-api")
        .then(async ({ default: ELK }) => {
          if (settled || request !== this.request) return;
          this.engine ??= new ELK({
            algorithms: ["layered"],
            workerFactory: () => {
              const worker = this.createWorker();
              this.worker = worker;
              const failed = () => {
                if (this.worker !== worker) return;
                if (this.pending)
                  this.pending(new Error("Layout worker failed"));
                else this.stopWorker();
              };
              worker.addEventListener("error", failed);
              worker.addEventListener("messageerror", failed);
              return worker;
            },
          });
          const graph = await this.engine.layout(createElkGraph(input));
          if (settled || request !== this.request) return;
          const layout = readElkGraph(input, graph);
          cleanup();
          resolve(layout);
        })
        .catch(fail);
    });
  }

  dispose(): void {
    this.request++;
    this.pending?.(new Error("Layout disposed"));
    this.stopWorker();
  }
}

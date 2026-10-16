import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

/**
 * A small CDP client so the interceptor can open its own connection to a
 * browser websocket. It deliberately does not depend on Playwright or
 * Puppeteer: the agent's driver is a second CDP client, and this one has to
 * attach beside it.
 */

export interface CdpEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** One CDP payload, including a large getRequestPostData body, stays under this. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

class WebSocketClient {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closed = false;
  onmessage: (data: string) => void = () => {};
  onclose: () => void = () => {};
  onerror: (error: Error) => void = () => {};

  private constructor(private readonly socket: Duplex) {
    socket.on("data", (chunk: Buffer) => {
      this.append(chunk);
    });
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose();
    });
    socket.on("error", (error: Error) => {
      this.fail(
        error instanceof Error ? error : new Error("CDP websocket error"),
      );
    });
  }

  static connect(url: string, timeoutMs: number): Promise<WebSocketClient> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const key = crypto.randomBytes(16).toString("base64");
      const transport = target.protocol === "wss:" ? https : http;
      const request = transport.request({
        host: target.hostname,
        port: target.port || (target.protocol === "wss:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        timeout: timeoutMs,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": key,
        },
      });
      const fail = (error: Error) => {
        request.destroy();
        reject(error);
      };
      request.on("upgrade", (response, socket, head) => {
        if (response.statusCode !== 101) {
          socket.destroy();
          fail(
            new Error(
              `CDP websocket upgrade refused: HTTP ${response.statusCode}`,
            ),
          );
          return;
        }
        const client = new WebSocketClient(socket);
        if (head?.length) client.append(Buffer.from(head));
        resolve(client);
      });
      request.on("response", (response) => {
        fail(
          new Error(
            `CDP websocket upgrade refused: HTTP ${response.statusCode}`,
          ),
        );
      });
      request.on("timeout", () =>
        fail(new Error("CDP websocket connect timeout")),
      );
      request.on("error", fail);
      request.end();
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.onerror(error);
    this.socket.destroy();
    this.onclose();
  }

  private append(chunk: Buffer): void {
    if (this.closed) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered > MAX_FRAME_BYTES) {
      this.fail(new Error("CDP websocket frame exceeded the size cap"));
      return;
    }
    try {
      this.parse();
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("CDP websocket parse failed"),
      );
    }
  }

  private peek(length: number): Buffer | null {
    if (this.buffered < length) return null;
    if (this.chunks[0] && this.chunks[0].length >= length) {
      return this.chunks[0].subarray(0, length);
    }
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      const take = Math.min(chunk.length, length - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (offset >= length) break;
    }
    return out;
  }

  private consume(length: number): Buffer | null {
    if (this.buffered < length) return null;
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const head = this.chunks[0];
      const need = length - offset;
      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, offset, 0, need);
        this.chunks[0] = head.subarray(need);
        offset += need;
      }
    }
    this.buffered -= length;
    return out;
  }

  private parse(): void {
    for (;;) {
      const header = this.peek(2);
      if (!header) return;
      const first = header[0];
      const second = header[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        const extended = this.peek(4);
        if (!extended) return;
        length = extended.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        const extended = this.peek(10);
        if (!extended) return;
        length = Number(extended.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.fail(new Error("CDP websocket frame exceeded the size cap"));
        return;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      const frame = this.consume(offset + length);
      if (!frame) return;
      let payload = frame.subarray(offset, offset + length);
      if (masked) {
        const mask = frame.subarray(maskOffset, maskOffset + 4);
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let index = 0; index < payload.length; index++) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }
      const opcode = first & 0x0f;
      const fin = (first & 0x80) !== 0;
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_FRAME_BYTES) {
        this.fail(new Error("CDP websocket frame exceeded the size cap"));
        return;
      }
      this.fragments.push(Buffer.from(payload));
      if (fin) {
        const message = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.fragmentBytes = 0;
        this.onmessage(message);
      }
    }
  }

  private frame(opcode: number, data: Buffer): void {
    if (this.closed) return;
    const mask = crypto.randomBytes(4);
    const length = data.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length]);
    } else if (length < 65536) {
      header = Buffer.from([
        0x80 | opcode,
        0x80 | 126,
        length >> 8,
        length & 255,
      ]);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const body = Buffer.allocUnsafe(data.length);
    for (let index = 0; index < data.length; index++) {
      body[index] = data[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  send(data: string): void {
    this.frame(0x1, Buffer.from(data, "utf8"));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.frame(0x8, Buffer.alloc(0));
    } catch {
      // The socket may already be gone.
    }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 200);
  }
}

export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();

  private constructor(private readonly socket: WebSocketClient) {
    socket.onmessage = (data) => {
      let message: any;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(`CDP ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (!message.method) return;
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      };
      for (const listener of this.listeners) listener(event);
    };
    const rejectAll = (error: Error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    socket.onerror = (error) => {
      rejectAll(error);
    };
    socket.onclose = () => {
      rejectAll(new Error("CDP connection closed"));
    };
  }

  static async connect(
    url: string,
    timeoutMs = 15_000,
  ): Promise<CdpConnection> {
    return new CdpConnection(await WebSocketClient.connect(url, timeoutMs));
  }

  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 15_000,
  ): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }
}

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

class WebSocketClient {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;
  onmessage: (data: string) => void = () => {};
  onclose: () => void = () => {};

  private constructor(private readonly socket: Duplex) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on("close", () => {
      this.closed = true;
      this.onclose();
    });
    socket.on("error", () => {
      this.closed = true;
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
        if (head?.length) {
          client.buffer = Buffer.from(head);
          client.parse();
        }
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

  private parse(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(
          payload.map((byte, index) => byte ^ mask[index % 4]),
        );
      }
      this.buffer = this.buffer.subarray(offset + length);
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
      this.fragments.push(Buffer.from(payload));
      if (fin) {
        const message = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
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
    const body = Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]));
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
    socket.onclose = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
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

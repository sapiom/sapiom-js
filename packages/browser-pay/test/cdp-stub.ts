import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** Returned by a `CdpReply` for a command the browser never acknowledges. */
export const NO_REPLY = Symbol("no reply");

/** Returns the `result` for a command, or `undefined` for `{}`; throwing answers with a CDP error. */
export type CdpReply = (command: CdpCommand) => unknown;

export interface CdpStub {
  url: string;
  commands: CdpCommand[];
  emit(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

/** A minimal CDP WebSocket server: records every command and answers with `reply`. */
export async function startCdpStub(
  reply: CdpReply = () => undefined,
): Promise<CdpStub> {
  const commands: CdpCommand[] = [];
  let socket: Duplex | undefined;
  let pending = Buffer.alloc(0);

  const onMessage = (text: string) => {
    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (!message.id || !message.method) return;
    const command: CdpCommand = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    };
    commands.push(command);
    let answer: Record<string, unknown>;
    try {
      const result = reply(command);
      if (result === NO_REPLY) return;
      answer = { id: message.id, result: result ?? {} };
    } catch (error) {
      answer = { id: message.id, error: { message: String(error) } };
    }
    socket?.write(serverFrame(JSON.stringify(answer)));
  };

  const parse = () => {
    for (;;) {
      if (pending.length < 2) return;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (pending[1] & 0x80) !== 0;
      const maskAt = offset;
      if (masked) offset += 4;
      if (pending.length < offset + length) return;
      const opcode = pending[0] & 0x0f;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      if (masked) {
        for (let index = 0; index < payload.length; index++) {
          payload[index] ^= pending[maskAt + (index % 4)];
        }
      }
      pending = pending.subarray(offset + length);
      if (opcode === 0x1) onMessage(payload.toString("utf8"));
    }
  };

  const server = http.createServer();
  server.on("upgrade", (request, upgraded, head) => {
    const key = String(request.headers["sec-websocket-key"] ?? "");
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    upgraded.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket = upgraded;
    if (head?.length) pending = Buffer.concat([pending, head]);
    upgraded.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      parse();
    });
    upgraded.on("error", () => {});
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    commands,
    emit(event) {
      socket?.write(serverFrame(JSON.stringify(event)));
    },
    close() {
      socket?.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

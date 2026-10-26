import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { CdpCommandError, CdpConnection } from "./cdp";

function acceptKey(key: string): string {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function serverFrame(payload: Buffer): Buffer {
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function listen(): Promise<{
  url: string;
  onceSocket: Promise<Duplex>;
  close: () => Promise<void>;
}> {
  let capture: (socket: Duplex) => void = () => {};
  let active: Duplex | undefined;
  const onceSocket = new Promise<Duplex>((resolve) => {
    capture = (socket) => {
      active = socket;
      resolve(socket);
    };
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    const key = String(request.headers["sec-websocket-key"] ?? "");
    socket.on("error", () => {});
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    capture(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        onceSocket,
        close: () =>
          new Promise((done) => {
            active?.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe("CdpConnection", () => {
  it("reassembles a result that arrives one byte at a time", async () => {
    const stub = await listen();
    try {
      const connection = await CdpConnection.connect(stub.url);
      const socket = await stub.onceSocket;
      const pending = connection.send("Runtime.evaluate", {});
      const frame = serverFrame(
        Buffer.from(JSON.stringify({ id: 1, result: { value: 7 } })),
      );
      for (const byte of frame) {
        socket.write(Buffer.from([byte]));
      }
      await expect(pending).resolves.toEqual({ value: 7 });
      connection.close();
    } finally {
      await stub.close();
    }
  });

  it("rejects pending calls when Chrome sends a close frame, and later sends reject", async () => {
    const stub = await listen();
    try {
      const connection = await CdpConnection.connect(stub.url);
      const socket = await stub.onceSocket;
      const pending = connection.send("Fetch.enable", {}, undefined, 30_000);
      socket.write(Buffer.from([0x88, 0x00]));
      await expect(pending).rejects.toThrow(/closed/);
      await expect(
        connection.send("Runtime.evaluate", {}, undefined, 30_000),
      ).rejects.toThrow(/closed/);
    } finally {
      await stub.close();
    }
  });

  it("rejects a pending call when the socket errors without a close frame", async () => {
    const stub = await listen();
    try {
      const connection = await CdpConnection.connect(stub.url);
      const socket = await stub.onceSocket;
      const pending = connection.send("Fetch.enable", {}, undefined, 30_000);
      socket.destroy(new Error("reset"));
      await expect(pending).rejects.toThrow(/reset|CDP/);
    } finally {
      await stub.close();
    }
  });

  it("rejects Fetch.enable with timedOut when the browser never replies", async () => {
    const stub = await listen();
    try {
      const connection = await CdpConnection.connect(stub.url);
      await stub.onceSocket;
      const pending = connection.send("Fetch.enable", {}, undefined, 20);
      await expect(pending).rejects.toBeInstanceOf(CdpCommandError);
      await expect(pending).rejects.toHaveProperty("timedOut", true);
      await expect(pending).rejects.toHaveProperty("method", "Fetch.enable");
      await expect(pending).rejects.toHaveProperty(
        "message",
        "CDP command timed out: Fetch.enable",
      );
      connection.close();
    } finally {
      await stub.close();
    }
  });

  it("rejects pending calls when a frame claims to exceed the size cap", async () => {
    const stub = await listen();
    try {
      const connection = await CdpConnection.connect(stub.url);
      const socket = await stub.onceSocket;
      const pending = connection.send(
        "Fetch.getRequestPostData",
        {},
        undefined,
        30_000,
      );
      const header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(32 * 1024 * 1024), 2);
      socket.write(header);
      await expect(pending).rejects.toThrow(/size cap|CDP/);
      connection.close();
    } finally {
      await stub.close();
    }
  });
});

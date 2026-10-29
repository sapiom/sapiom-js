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

function listen(
  options: {
    discoveryDelayMs?: number;
    handshakeDelayMs?: number;
    trickle?: boolean;
  } = {},
): Promise<{
  url: string;
  onceSocket: Promise<Duplex>;
  close: () => Promise<void>;
}> {
  let capture: (socket: Duplex) => void = () => {};
  let active: Duplex | undefined;
  const timers = new Set<NodeJS.Timeout>();
  const onceSocket = new Promise<Duplex>((resolve) => {
    capture = (socket) => {
      active = socket;
      resolve(socket);
    };
  });
  const server = http.createServer((request, response) => {
    if (request.url !== "/json/version?token=synthetic") {
      response.writeHead(404).end();
      return;
    }
    const address = server.address() as AddressInfo;
    response.setHeader("Content-Type", "application/json");
    timers.add(
      setTimeout(() => {
        response.end(
          JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/browser`,
          }),
        );
      }, options.discoveryDelayMs ?? 0),
    );
  });
  server.on("upgrade", (request, socket) => {
    const key = String(request.headers["sec-websocket-key"] ?? "");
    socket.on("error", () => {});
    if (options.trickle) {
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      const trickle = setInterval(() => {
        socket.write("X-Keepalive: partial-handshake\r\n");
      }, 20);
      timers.add(trickle);
      socket.once("close", () => clearInterval(trickle));
    }
    timers.add(
      setTimeout(() => {
        for (const timer of timers) clearTimeout(timer);
        socket.write(
          `${options.trickle ? "" : "HTTP/1.1 101 Switching Protocols\r\n"}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        );
      }, options.handshakeDelayMs ?? 0),
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
            for (const timer of timers) clearTimeout(timer);
            active?.destroy();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

describe("CdpConnection", () => {
  it("times out and closes a handshake even while partial headers keep arriving", async () => {
    const stub = await listen({ handshakeDelayMs: 900, trickle: true });
    let connection: CdpConnection | undefined;
    try {
      const pending = CdpConnection.connect(stub.url, 300).then((value) => {
        connection = value;
        return value;
      });
      const rejected = expect(pending).rejects.toThrow(
        /^CDP websocket connect timeout$/,
      );
      const socket = await stub.onceSocket;
      const closed = new Promise<void>((resolve) =>
        socket.once("close", resolve),
      );
      await rejected;
      await closed;
    } finally {
      connection?.close();
      await stub.close();
    }
  });

  it("shares one timeout budget between discovery and the handshake", async () => {
    const stub = await listen({ discoveryDelayMs: 200, handshakeDelayMs: 200 });
    let connection: CdpConnection | undefined;
    try {
      const pending = CdpConnection.connect(
        `${stub.url.replace("ws:", "http:")}?token=synthetic`,
        300,
      ).then((value) => {
        connection = value;
        return value;
      });
      await expect(pending).rejects.toThrow(/^CDP websocket connect timeout$/);
    } finally {
      connection?.close();
      await stub.close();
    }
  });

  it("keeps an established connection usable after the connect deadline", async () => {
    const stub = await listen();
    let connection: CdpConnection | undefined;
    try {
      connection = await CdpConnection.connect(stub.url, 200);
      const socket = await stub.onceSocket;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const pending = connection.send("Browser.getVersion", {});
      socket.write(
        serverFrame(
          Buffer.from(
            JSON.stringify({
              id: 1,
              result: { product: "still-connected" },
            }),
          ),
        ),
      );
      await expect(pending).resolves.toEqual({ product: "still-connected" });
    } finally {
      connection?.close();
      await stub.close();
    }
  });

  it("discovers an HTTP endpoint and exchanges a real CDP command", async () => {
    const stub = await listen();
    try {
      const connection = await CdpConnection.connect(
        `${stub.url.replace("ws:", "http:")}?token=synthetic`,
      );
      const socket = await stub.onceSocket;
      const pending = connection.send("Browser.getVersion", {});
      socket.write(
        serverFrame(
          Buffer.from(
            JSON.stringify({
              id: 1,
              result: { product: "test-browser" },
            }),
          ),
        ),
      );
      await expect(pending).resolves.toEqual({ product: "test-browser" });
      connection.close();
    } finally {
      await stub.close();
    }
  });
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

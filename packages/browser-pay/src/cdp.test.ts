import crypto from "node:crypto";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { CdpCommandError, CdpConnection, discoveredWebSocketUrl } from "./cdp";

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

type Discovery = (port: number) => {
  status: number;
  body: string;
  headers?: Record<string, string>;
};

function listen(discovery?: Discovery): Promise<{
  url: string;
  port: number;
  gets: string[];
  upgrades: string[];
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
  const gets: string[] = [];
  const upgrades: string[] = [];
  const server = http.createServer((request, response) => {
    gets.push(request.url ?? "");
    const port = (server.address() as AddressInfo).port;
    const answer = discovery?.(port) ?? { status: 404, body: "" };
    response.writeHead(answer.status, {
      "content-type": "application/json",
      ...answer.headers,
    });
    response.end(answer.body);
  });
  server.on("upgrade", (request, socket) => {
    upgrades.push(request.url ?? "");
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
        port: address.port,
        gets,
        upgrades,
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

  it("notifies every close listener even when an earlier listener throws", async () => {
    const stub = await listen();
    try {
      const connection = await CdpConnection.connect(stub.url);
      const socket = await stub.onceSocket;
      const broken = jest.fn(() => {
        throw new Error("observer failed");
      });
      const notified = jest.fn();
      connection.onClose(broken);
      connection.onClose(notified);
      const pending = connection.send("Fetch.enable", {}, undefined, 30_000);
      socket.write(Buffer.from([0x88, 0x00]));
      await expect(pending).rejects.toThrow(/closed/);
      expect(broken).toHaveBeenCalledTimes(1);
      expect(notified).toHaveBeenCalledTimes(1);
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

describe("CdpConnection discovery", () => {
  const version = (webSocketDebuggerUrl: unknown) =>
    JSON.stringify({ Browser: "Chrome/1", webSocketDebuggerUrl });

  it.each([
    ["/base?token=t", "/base/json/version/?token=t"],
    ["/proxy/devtools/?token=t", "/proxy/devtools/json/version/?token=t"],
  ])(
    "reads the websocket URL for %s from json/version/ under the path, keeping the query",
    async (path, discovery) => {
      const stub = await listen((port) => ({
        status: 200,
        body: version(`ws://127.0.0.1:${port}/devtools/browser/abc`),
      }));
      try {
        const connection = await CdpConnection.connect(
          `http://127.0.0.1:${stub.port}${path}`,
        );
        expect(stub.gets).toEqual([discovery]);
        expect(stub.upgrades).toEqual(["/devtools/browser/abc"]);
        connection.close();
      } finally {
        await stub.close();
      }
    },
  );

  it.each([
    "/devtools/browser/abc",
    "/devtools/page/abc",
    "/session/abc/devtools/browser/def?token=test",
  ])(
    "connects an http:// URL to %s directly, without discovery",
    async (path) => {
      const stub = await listen();
      try {
        const connection = await CdpConnection.connect(
          `http://127.0.0.1:${stub.port}${path}`,
        );
        expect(stub.gets).toEqual([]);
        expect(stub.upgrades).toEqual([path]);
        connection.close();
      } finally {
        await stub.close();
      }
    },
  );

  it("times out a discovery answer that keeps sending bytes", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      const drip = setInterval(() => response.write(" "), 20);
      response.on("close", () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    try {
      const started = Date.now();
      await expect(
        CdpConnection.connect(`http://127.0.0.1:${port}`, 100),
      ).rejects.toThrow("CDP discovery timeout");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a 101 upgrade answer to the discovery request", async () => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () =>
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        CdpConnection.connect(`http://127.0.0.1:${port}`, 1_000),
      ).rejects.toThrow("CDP discovery refused: HTTP 101");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each<[string, Discovery, string]>([
    [
      "a redirect",
      (port) => ({
        status: 302,
        body: "",
        headers: { location: `http://127.0.0.1:${port}/other` },
      }),
      "CDP discovery refused: HTTP 302",
    ],
    [
      "a body over the size cap",
      () => ({ status: 200, body: "x".repeat(70 * 1024) }),
      "CDP discovery response is invalid",
    ],
  ])(
    "refuses %s after one GET, with no websocket",
    async (_name, answer, message) => {
      const stub = await listen(answer);
      try {
        await expect(
          CdpConnection.connect(`http://127.0.0.1:${stub.port}`),
        ).rejects.toThrow(message);
        expect(stub.gets).toEqual(["/json/version/"]);
        expect(stub.upgrades).toEqual([]);
      } finally {
        await stub.close();
      }
    },
  );

  it("accepts only a ws:// or wss:// webSocketDebuggerUrl, and wss:// over https", () => {
    for (const body of [
      "<html>",
      "{}",
      version("http://browser.example.test/devtools/browser/abc"),
    ]) {
      expect(() => discoveredWebSocketUrl(body, false)).toThrow(
        "CDP discovery response is invalid",
      );
    }
    const plain = version("ws://browser.example.test/devtools/browser/abc");
    expect(() => discoveredWebSocketUrl(plain, true)).toThrow(
      "CDP discovery over https named a websocket without TLS",
    );
    expect(discoveredWebSocketUrl(plain, false).protocol).toBe("ws:");
    expect(
      discoveredWebSocketUrl(
        version("wss://browser.example.test/devtools/browser/abc"),
        true,
      ).protocol,
    ).toBe("wss:");
  });
});

import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";

import {
  startOpenCodeServer,
  type OpenCodeServer,
  type StartOpenCodeServerOptions,
} from "./server.js";

const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export interface StartOpenCodeStandaloneOptions extends StartOpenCodeServerOptions {
  webRoot: string;
  port?: number;
}

export interface OpenCodeStandalone {
  origin: string;
  port: number;
  opencode: OpenCodeServer;
  close(): Promise<void>;
}

export async function startOpenCodeStandalone(
  options: StartOpenCodeStandaloneOptions,
): Promise<OpenCodeStandalone> {
  const opencode = await startOpenCodeServer(options);
  const hostname = "127.0.0.1";
  const webRoot = resolve(options.webRoot);
  const server = createServer((request, response) => {
    void handleRequest(request, response, opencode, webRoot).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Internal server error");
    });
  });

  try {
    await listen(server, hostname, options.port ?? 0);
  } catch (error) {
    await opencode.close();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(server);
    await opencode.close();
    throw new Error("Standalone server started without a TCP address");
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.all([closeHttpServer(server), opencode.close()]).then(
      () => undefined,
    );
    return closing;
  };

  return {
    origin: `http://${hostname}:${address.port}`,
    port: address.port,
    opencode,
    close,
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  opencode: OpenCodeServer,
  webRoot: string,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (
    requestUrl.pathname === "/opencode" ||
    requestUrl.pathname.startsWith("/opencode/")
  ) {
    await proxyRequest(request, response, requestUrl, opencode);
    return;
  }

  await serveStatic(response, requestUrl.pathname, webRoot);
}

async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  opencode: OpenCodeServer,
): Promise<void> {
  const path = requestUrl.pathname.slice("/opencode".length) || "/";
  const target = `${path}${requestUrl.search}`;
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await readRequestBody(request);
  const abortController = new AbortController();
  const abortUpstream = (): void => abortController.abort();
  response.once("close", abortUpstream);
  const upstream = await opencode.fetch(target, {
    method,
    headers: proxyHeaders(request.headers),
    body,
    redirect: "manual",
    signal: abortController.signal,
  });

  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalizedName) &&
      !DECODED_BODY_HEADERS.has(normalizedName)
    ) {
      headers[name] = value;
    }
  });
  response.writeHead(upstream.status, headers);

  if (upstream.body === null) {
    response.end();
    response.off("close", abortUpstream);
    return;
  }

  const reader = upstream.body.getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      if (!response.write(result.value)) {
        await new Promise<void>((resolveDrain) =>
          response.once("drain", resolveDrain),
        );
      }
      result = await reader.read();
    }
    response.end();
  } finally {
    response.off("close", abortUpstream);
    reader.releaseLock();
  }
}

async function serveStatic(
  response: ServerResponse,
  pathname: string,
  webRoot: string,
): Promise<void> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  const relativePath =
    decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const filePath = resolve(webRoot, relativePath);
  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${sep}`)) {
    response.writeHead(404).end("Not found");
    return;
  }

  const selectedPath = (await existingFile(filePath))
    ? filePath
    : extname(filePath) === ""
      ? resolve(webRoot, "index.html")
      : undefined;
  if (selectedPath === undefined || !(await existingFile(selectedPath))) {
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": contentType(selectedPath),
    "content-security-policy": [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
    ].join("; "),
    "x-content-type-options": "nosniff",
  });
  response.end(await readFile(selectedPath));
}

async function existingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function proxyHeaders(source: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      name.toLowerCase() === "authorization" ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase())
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  headers.delete("content-length");
  return headers;
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error("OpenCode proxy request exceeds 16 MiB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function listen(server: Server, hostname: string, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
    server.closeAllConnections();
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Node fetch decodes compressed response bodies but preserves these headers.
const DECODED_BODY_HEADERS = new Set(["content-encoding", "content-length"]);

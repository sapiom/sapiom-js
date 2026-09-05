import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (process.env.FAKE_OPENCODE_FAIL === "1") {
  console.error("fake opencode failed before listening");
  process.exit(23);
}

const hostname = valueAfter("--hostname") ?? "127.0.0.1";
const port = Number(valueAfter("--port"));
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const expectedAuthorization =
  "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

const server = createServer((request, response) => {
  if (request.headers.authorization !== expectedAuthorization) {
    response.writeHead(401).end("unauthorized");
    return;
  }

  response.setHeader("content-type", "application/json");
  if (request.url === "/global/health") {
    response.end(JSON.stringify({ healthy: true, version: "fake-opencode" }));
    return;
  }

  if (request.url === "/global/event") {
    response.setHeader("content-type", "text/event-stream");
    response.end('data: {"type":"server.connected"}\n\n');
    return;
  }

  if (request.url === "/debug/compressed") {
    const body = gzipSync(JSON.stringify({ compressed: true }));
    response.setHeader("content-encoding", "gzip");
    response.setHeader("content-length", body.byteLength);
    response.end(body);
    return;
  }

  if (request.url === "/debug/environment") {
    response.end(
      JSON.stringify({
        cwd: process.cwd(),
        config: process.env.OPENCODE_CONFIG_CONTENT,
        xdgConfig: process.env.XDG_CONFIG_HOME,
        xdgData: process.env.XDG_DATA_HOME,
        xdgCache: process.env.XDG_CACHE_HOME,
        xdgState: process.env.XDG_STATE_HOME,
        disableClaudeCode: process.env.OPENCODE_DISABLE_CLAUDE_CODE,
        disableClaudeCodeSkills:
          process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS,
        disableDefaultPlugins: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS,
        disableExternalSkills: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS,
        disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
        disableAutoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE,
      }),
    );
    return;
  }

  response.writeHead(404).end(JSON.stringify({ error: "not found" }));
});

server.listen(port, hostname);

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const password = process.env.OPENCODE_SERVER_PASSWORD;
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
for (const specifier of config.plugin ?? []) {
  const source = readFileSync(fileURLToPath(specifier), "utf8");
  const keys = JSON.parse(source.match(/^const keys = (.+);$/m)?.[1] ?? "[]");
  const readyPath = JSON.parse(
    source.match(/await writeFile\(("(?:[^"\\]|\\.)*"), "ready/)?.[1] ?? '""',
  );
  for (const key of keys) delete process.env[key];
  writeFileSync(readyPath, "ready\n", { flag: "wx", mode: 0o600 });
}
writeFileSync("runtime.pid", String(process.pid));
if (config.crash) {
  console.error("private provider diagnostic");
  process.exit(1);
}
createServer((req, res) => {
  if (req.headers.authorization !== authorization) {
    res.writeHead(401).end();
    return;
  }
  if (req.url === "/global/health") {
    if (!config.stall)
      res.end(JSON.stringify({ healthy: true, version: "fixture" }));
  } else if (req.url === "/config") {
    res.end("{}");
  } else if (req.url === "/inspect") {
    const tool = spawn(process.execPath, [
      "-e",
      "console.log(JSON.stringify(Object.entries(process.env)))",
    ]);
    let output = "";
    tool.stdout.on("data", (chunk) => {
      output += chunk;
    });
    tool.on("exit", () => {
      const entries = JSON.parse(output);
      const credentials = [
        password,
        config.provider?.sapiom?.options?.apiKey,
        config.mcp?.sapiom?.headers?.Authorization,
      ].filter(Boolean);
      res.end(
        JSON.stringify({
          cwd: process.cwd(),
          keys: entries.map(([key]) => key),
          runtimeKeys: Object.keys(process.env),
          credentialValueInherited: entries.some(([, value]) =>
            credentials.includes(value),
          ),
          configChecks: {
            model: config.model,
            modelBridge:
              config.provider?.sapiom?.options?.baseURL?.endsWith(
                "/llm/v2/openai/v1",
              ),
            mcpBridge: config.mcp?.sapiom?.url?.endsWith("/mcp"),
          },
        }),
      );
    });
  } else {
    res.writeHead(404).end("private diagnostic");
  }
}).listen(
  Number(process.argv[process.argv.indexOf("--port") + 1]),
  "127.0.0.1",
);

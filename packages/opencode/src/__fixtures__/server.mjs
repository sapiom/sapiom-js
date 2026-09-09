import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
writeFileSync("runtime.pid", String(process.pid));
if (config.crash) {
  console.error("private provider diagnostic");
  process.exit(1);
}
const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
createServer((req, res) => {
  if (req.headers.authorization !== authorization) {
    res.writeHead(401).end();
    return;
  }
  if (req.url === "/global/health") {
    if (!config.stall)
      res.end(JSON.stringify({ healthy: true, version: "fixture" }));
  } else if (req.url === "/inspect") {
    const tool = spawn(process.execPath, [
      "-e",
      "console.log(JSON.stringify(Object.keys(process.env)))",
    ]);
    let output = "";
    tool.stdout.on("data", (chunk) => {
      output += chunk;
    });
    tool.on("exit", () =>
      res.end(
        JSON.stringify({
          cwd: process.cwd(),
          config,
          keys: JSON.parse(output),
        }),
      ),
    );
  } else {
    res.writeHead(404).end("private diagnostic");
  }
}).listen(
  Number(process.argv[process.argv.indexOf("--port") + 1]),
  "127.0.0.1",
);

import { existsSync, readFileSync } from "node:fs";

const blocker = new URL("../.release-blocked", import.meta.url);
if (existsSync(blocker)) {
  console.error(`Release blocked:\n${readFileSync(blocker, "utf8").trim()}`);
  process.exitCode = 1;
}

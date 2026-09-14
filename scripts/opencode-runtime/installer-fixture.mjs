// Child-process fixture: simulate platform APIs, never run a foreign binary.
import os from "node:os";
import fs from "node:fs";
import cp from "node:child_process";
import path from "node:path";

const scenario = JSON.parse(process.env.OPENCODE_INSTALLER_SCENARIO);
const root = process.env.OPENCODE_INSTALLER_FIXTURE;
const calls = [];
const read = fs.readFileSync.bind(fs);
const exists = fs.existsSync.bind(fs);
os.platform = () => scenario.platform;
os.arch = () => scenario.arch;
fs.readFileSync = (file, ...args) => String(file) === "/proc/cpuinfo"
  ? (scenario.avx2 ? "flags: avx2" : "flags: sse2") : read(file, ...args);
fs.existsSync = (file) => {
  if (String(file) === "/etc/alpine-release") return scenario.musl;
  if (scenario.platform === "win32" && String(file).endsWith("/npm/bin/npm-cli.js"))
    return !scenario.noNpmCLI;
  return exists(file);
};
if (scenario.forceCopy) fs.linkSync = () => { throw new Error("fixture cross-device link"); };
cp.spawnSync = (command, args, options) => {
  if (command === "ldd") return { status: 0, stdout: scenario.musl ? "musl libc" : "GNU libc" };
  if (command === "sysctl") return { status: 0, stdout: scenario.avx2 ? "1" : "0" };
  if (command.toLowerCase().includes("powershell") || command.startsWith("pwsh"))
    return { status: 0, stdout: scenario.avx2 ? "True" : "False" };
  if (command === "npm" || (command === process.execPath && args[0]?.endsWith("npm-cli.js"))) {
    calls.push({ command, npm: args, shell: options?.shell ?? false });
    return { status: 1, stdout: "", stderr: "" };
  }
  if (command === path.join(root, "bin/opencode.exe")) {
    const selected = read(command, "utf8");
    calls.push({ selected });
    return { status: selected === scenario.reject ? 1 : 0, stdout: "" };
  }
  throw new Error("Unexpected executable in installer simulation");
};
process.on("exit", () => fs.writeFileSync(path.join(root, "calls.json"), JSON.stringify(calls)));

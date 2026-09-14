// OpenCode's installer names the selected native binary opencode.exe on EVERY
// platform. electron-builder normally drops .exe dependencies outside Windows.
// Keep only this installed binary; do not enable other Windows-only files.
export default function includeOpenCodeRuntime(file) {
  return file
    .replace(/\\/g, "/")
    .endsWith("/node_modules/opencode-ai/bin/opencode.exe");
}

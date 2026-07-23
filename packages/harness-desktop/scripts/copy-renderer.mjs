// Copies the setup window's static assets (HTML/CSS) into dist/renderer.
// tsc emits only setup.js from src/renderer; the .html/.css must be copied.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src", "renderer");
const outDir = join(root, "dist", "renderer");

await mkdir(outDir, { recursive: true });
for (const file of ["setup.html", "setup.css"]) {
  await cp(join(srcDir, file), join(outDir, file));
}
console.log("copied renderer assets → dist/renderer");

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectDirFiles } from "./upload-dir.js";

function write(root: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

describe("collectDirFiles", () => {
  let base: string;
  let root: string;
  let secret: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "upload-dir-"));
    root = path.join(base, "app");
    secret = path.join(base, "credentials");
    writeFileSync(secret, "TOP-SECRET");
    write(root, "index.html", "<h1>hi</h1>");
    write(root, "public/app.js", "console.log(1)");
    write(root, ".env", "API_KEY=1");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("skips a symlink to a file outside the root, a symlink loop and dotfiles", () => {
    symlinkSync(secret, path.join(root, "public", "x"));
    symlinkSync(root, path.join(root, "loop"));

    const files = collectDirFiles(root);

    expect(files.map((f) => f.path).sort()).toEqual([
      "index.html",
      "public/app.js",
    ]);
    expect(files.some((f) => f.content.includes("TOP-SECRET"))).toBe(false);
  });

  it("still walks a root that is itself a symlink to a directory", () => {
    const link = path.join(base, "app-link");
    symlinkSync(root, link);

    expect(
      collectDirFiles(link)
        .map((f) => f.path)
        .sort(),
    ).toEqual(["index.html", "public/app.js"]);
  });
});

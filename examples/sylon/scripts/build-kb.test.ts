import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { KB } from "../_shared/kb.generated";
import { KB_OUT, readKb, renderKb } from "./build-kb";

describe("build-kb", () => {
  it("the committed kb.generated.ts matches kb/*.md (run `pnpm run build:kb`)", () => {
    expect(readFileSync(KB_OUT, "utf8")).toBe(renderKb(readKb()));
  });

  it("round-trips bodies with backticks, backslashes and template markers", () => {
    const body = "use `curl`, a \\path and ${HOME}";
    const src = renderKb([{ slug: "x", title: "X", body }]);
    const match = /body: (`[\s\S]*`),\n/.exec(src)!;
    expect(new Function(`return ${match[1]}`)()).toBe(body);
  });

  it("ships 3 to 5 pages, each with a title", () => {
    expect(KB.length).toBeGreaterThanOrEqual(3);
    expect(KB.length).toBeLessThanOrEqual(5);
    for (const page of KB) expect(page.title).not.toBe(page.slug);
  });
});

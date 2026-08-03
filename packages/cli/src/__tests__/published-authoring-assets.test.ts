import { readFileSync } from "node:fs";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, "templates", "default");

const packageJson = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
) as {
  description: string;
  files: string[];
  keywords: string[];
};

describe("published authoring assets", () => {
  it("keeps the legacy template in the published CLI boundary", () => {
    expect(packageJson.files).toContain("templates");
  });

  it("uses Agent and Agent run terminology in legacy template prose", () => {
    const prose = ["AGENTS.md", "CLAUDE.md", "README.md", "index.ts"]
      .map((file) => readFileSync(path.join(TEMPLATE_ROOT, file), "utf8"))
      .join("\n");

    expect(prose).toContain("Sapiom agent");
    expect(prose).toContain("agent run");
    expect(prose).not.toMatch(
      /\b(?:workflow|workflows|orchestration|orchestrations)\b/i,
    );
  });

  it("uses Agent terminology in npm metadata", () => {
    expect(packageJson.description).toBe(
      "The Sapiom command-line interface — scaffold, validate, and ship Sapiom agents.",
    );
    expect(packageJson.keywords).toEqual([
      "sapiom",
      "cli",
      "agents",
      "automation",
    ]);
  });

  it("uses the canonical public Agent command identifiers", () => {
    const templatePackage = JSON.parse(
      readFileSync(path.join(TEMPLATE_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(templatePackage.scripts.check).toBe("sapiom agents check");
    expect(templatePackage.scripts.deploy).toBe("sapiom agents deploy");
  });
});

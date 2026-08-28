import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWorkflowsRouter,
  WorkflowRegistry,
} from "./workflow-registry.js";

describe("createWorkflowsRouter public projection", () => {
  let tmpRoot: string;
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workflow-router-public-"),
    );
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("never serializes registry-only source or marker evidence", async () => {
    const markerRoot = path.join(tmpRoot, "marker-agent");
    const sourceRoot = path.join(tmpRoot, "source-agent");
    await fs.mkdir(markerRoot, { recursive: true });
    await fs.writeFile(
      path.join(markerRoot, "sapiom.json"),
      JSON.stringify({ definitionId: 7, name: "marker-cloud-name" }),
    );
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "index.ts"),
      'import { defineAgent } from "@sapiom/agent";\n' +
        'export const agent = defineAgent({ name: "source-proof-name" });\n',
    );

    const registry = new WorkflowRegistry(path.join(tmpRoot, "workflows.json"));
    const app = express();
    app.use(express.json());
    app.use(createWorkflowsRouter(registry));
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const scan = await fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: tmpRoot }),
    });
    expect(scan.status).toBe(200);
    const scanBody = (await scan.json()) as {
      found: Array<Record<string, unknown>>;
    };
    expect(scanBody.found).toHaveLength(2);
    expect(
      scanBody.found.every((row) => !("sourceDefinitionName" in row)),
    ).toBe(true);
    expect(scanBody.found.every((row) => !("markerPresent" in row))).toBe(true);

    const internalRows = await registry.list();
    expect(internalRows.some((row) => row.markerPresent === true)).toBe(true);
    expect(
      internalRows.some(
        (row) => row.sourceDefinitionName === "source-proof-name",
      ),
    ).toBe(true);

    const list = await fetch(`${baseUrl}/api/workflows`);
    const listBody = (await list.json()) as Array<Record<string, unknown>>;
    expect(listBody.every((row) => !("sourceDefinitionName" in row))).toBe(
      true,
    );
    expect(listBody.every((row) => !("markerPresent" in row))).toBe(true);

    const connect = await fetch(`${baseUrl}/api/workflows/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: markerRoot }),
    });
    expect(connect.status).toBe(200);
    const connectBody = (await connect.json()) as Record<string, unknown>;
    expect(connectBody).not.toHaveProperty("sourceDefinitionName");
    expect(connectBody).not.toHaveProperty("markerPresent");
  });
});

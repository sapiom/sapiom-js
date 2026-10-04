import { describe, expect, it } from "vitest";

import {
  FLEET_ID,
  agentSlug,
  assertFleetId,
  consoleSlugFor,
  dbHandleFor,
  fleetTitle,
  issueMarker,
} from "./fleet-id";
import { PROJECTS } from "../scripts/fleet";
import {
  assertFleetIdSynced,
  generatedSource,
  resolveFleetId,
  resolveFleetTitle,
} from "../scripts/fleet-id";
import fleet from "../fleet.json";

describe("fleet identity derivation", () => {
  it("derives every name from the default id", () => {
    expect(fleet.fleetId).toBe("support-desk");
    expect(agentSlug("intake", "support-desk")).toBe("support-desk-intake");
    expect(agentSlug("urgent-pager", "support-desk")).toBe(
      "support-desk-urgent-pager",
    );
    expect(dbHandleFor("support-desk")).toBe("support-desk");
    expect(consoleSlugFor("support-desk")).toBe("support-desk-console");
    expect(fleetTitle("support-desk")).toBe("Support Desk");
    expect(issueMarker("i-1", "support-desk")).toBe("support-desk:i-1");
  });

  it("derives an existing install's names from a single-word id, whose handle is the id itself", () => {
    expect(agentSlug("intake", "helpdesk")).toBe("helpdesk-intake");
    expect(agentSlug("linear-sync", "helpdesk")).toBe("helpdesk-linear-sync");
    expect(dbHandleFor("helpdesk")).toBe("helpdesk");
    expect(consoleSlugFor("helpdesk")).toBe("helpdesk-console");
    expect(fleetTitle("helpdesk")).toBe("Helpdesk");
    expect(issueMarker("i-1", "helpdesk")).toBe("helpdesk:i-1");
  });

  it("accepts lowercase hyphenated ids and rejects the rest", () => {
    expect(assertFleetId("acme-help-desk")).toBe("acme-help-desk");
    for (const bad of [
      "",
      "Helpdesk",
      "a_b",
      "-a",
      "a-",
      "a--b",
      "1a",
      7,
      null,
    ])
      expect(() => assertFleetId(bad)).toThrow(/fleetId/);
  });

  it("lets fleet.local.json override fleet.json's id", () => {
    expect(resolveFleetId()).toBe("support-desk");
    expect(resolveFleetId({})).toBe("support-desk");
    expect(resolveFleetId({ fleetId: "helpdesk" })).toBe("helpdesk");
    expect(() => resolveFleetId({ fleetId: "Not Valid" })).toThrow();
  });

  it("names the fleet by its title, else by its id", () => {
    expect(resolveFleetTitle()).toBe("Support Desk");
    expect(resolveFleetTitle({ fleetId: "helpdesk" })).toBe("Helpdesk");
    expect(
      resolveFleetTitle({ fleetId: "helpdesk", title: " Customer Care " }),
    ).toBe("Customer Care");
    expect(() => resolveFleetTitle({ title: "" })).toThrow(/title/);
    expect(() => resolveFleetTitle({ title: 7 })).toThrow(/title/);
  });

  it("writes the id into the generated module and checks it is current", () => {
    expect(generatedSource("helpdesk")).toContain(
      'export const FLEET_ID = "helpdesk";',
    );
    expect(() => assertFleetIdSynced("some-other-fleet")).toThrow(
      /fleet-id\.generated\.ts/,
    );
  });

  it("gives every fleet.json project the slug of the loaded fleet id", () => {
    expect(PROJECTS.map((p) => p.slug)).toEqual(
      fleet.projects.map((p) => `${FLEET_ID}-${p.key}`),
    );
  });

  it("rejects ids too short for a database handle or too long for the Console slug", () => {
    expect(() => assertFleetId("ab")).toThrow(/3-55 characters/);
    expect(() => assertFleetId("a".repeat(56))).toThrow(/3-55 characters/);
    expect(assertFleetId("a".repeat(55))).toHaveLength(55);
  });
});

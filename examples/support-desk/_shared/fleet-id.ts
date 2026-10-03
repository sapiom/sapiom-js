/**
 * The fleet's identity. `fleetId` (fleet.json, overridable in fleet.local.json) names everything
 * deployed: each agent's slug is `<fleetId>-<key>`, the Postgres handle is the id itself,
 * and the Console's App Link slug is `<fleetId>-console`. Changing the id on a live install
 * therefore points setup at different agents and a different database; keep it to keep the install.
 *
 * The pure derivations take the id as an argument so tests can cover any id. The `FLEET_ID` that
 * deployed code uses is `fleet-id.generated.ts`, which setup writes before bundling.
 */
import { FLEET_ID } from "./fleet-id.generated";

export { FLEET_ID };

/** Lowercase words joined by single hyphens, starting with a letter: valid as a slug and as a database handle. */
const FLEET_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** A handle is 3-63 characters, and `<id>-console` must fit the App Link's 63-character slug. */
const FLEET_ID_MIN = 3;
const FLEET_ID_MAX = 63 - "-console".length;

export function assertFleetId(id: unknown): string {
  if (
    typeof id !== "string" ||
    !FLEET_ID_PATTERN.test(id) ||
    id.length < FLEET_ID_MIN ||
    id.length > FLEET_ID_MAX
  )
    throw new Error(
      `fleetId must be ${FLEET_ID_MIN}-${FLEET_ID_MAX} characters of lowercase words joined by hyphens, starting with a letter (got ${JSON.stringify(id)})`,
    );
  return id;
}

/** The deployed agent slug for a fleet.json project key. */
export const agentSlug = (key: string, fleetId: string = FLEET_ID) =>
  `${fleetId}-${key}`;

/** The shared database's handle: the fleet id itself. Handles allow hyphens but not underscores. */
export const dbHandleFor = (fleetId: string) => fleetId;

export const consoleSlugFor = (fleetId: string) => `${fleetId}-console`;

/** `support-desk` is `Support Desk`. */
export const fleetTitle = (fleetId: string) =>
  fleetId
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/** The prefix of every Linear issue description the fleet writes, which a retry searches for. */
export const issueMarker = (issueId: string, fleetId: string = FLEET_ID) =>
  `${fleetId}:${issueId}`;

export const DB_HANDLE = dbHandleFor(FLEET_ID);

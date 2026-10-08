/** `pnpm run setup` and `pnpm run console:build` run this first; see `assertFleetIdSynced`. */
import { syncFleetId } from "./fleet-id";

if (syncFleetId()) console.log("updated _shared/fleet-id.generated.ts");

/**
 * `pnpm run linear:list`: the Linear teams and projects the org's Linear connector can see, so
 * fleet.local.json can name a real `linearTeamId` and `linearProjectId`. The CLI twin of the setup
 * agent's Linear listing (agents/setup), on SAPIOM_API_KEY. Writes nothing.
 */
import { probeLinear } from "../agents/setup/index";

async function main() {
  if (!process.env.SAPIOM_API_KEY)
    throw new Error("set SAPIOM_API_KEY to an org key for the target org");
  const { check, linear } = await probeLinear({
    isLocalTrace: false,
    logger: console,
  } as never);
  if (!check.ok) throw new Error(`${check.detail}. ${check.fix ?? ""}`.trim());
  console.log(JSON.stringify(linear, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

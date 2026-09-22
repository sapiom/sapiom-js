# Capability execution assembled gate

Build `@sapiom/analytics-core` and `@sapiom/tools` first. Core must contain C07's
`backend/test/fixtures/capability-execution-harness.ts`, installed backend dependencies,
and private local PostgreSQL/Redis fixture services. The harness validates the private
service env file and rejects shared/default Redis and nonfixture database names.

```sh
pnpm --filter @sapiom/analytics-core build
pnpm --filter @sapiom/tools build
node --test packages/tools/scripts/capability-executions-sdk-child.test.mjs
CAPABILITY_EXECUTION_TEST_ENV=/absolute/private/.env.test \
  node packages/tools/scripts/capability-executions-e2e.mjs \
  --backend-dir /absolute/core-checkout \
  --evidence-dir /absolute/private/evidence
```

The child smoke test uses a local HTTP fixture and checks the runner itself. It is not
the assembled gate. The assembled command invokes the actual Core harness using private
IPC and imports only built SDK artifacts. It requires loopback fixture endpoints. API
credentials are passed only through IPC, not arguments or evidence files. It drains
framework logs rather than copying them into evidence. The harness must provide real
HTTP authentication, PostgreSQL/outbox, Redis/BullMQ, worker/router and local billing;
only external provider effects and test admission/capability settings are controlled.

The runner takes several minutes, including a real 90+ second operation. Scenarios cover
lost receipts, caller process death/resumption, duplicate delivery, outbox recovery,
worker death at six checkpoints, terminal replay, and admission-off accepted-job
continuity. No direct repository completion or fake clock is used. Each scenario records
SDK transport history (body hash only), ID/key, state/epoch/checkpoint, provider attempt
history and actual billing rows. Successful cases require one provider attempt, one
authorization/usage identity with a settled authorization and one exact settlement
event. The provider-received crash must retain one attempt and an allowed authorization
owned by capability execution recovery; uncertain dispatch must not add provider attempts. The command exits nonzero on missing/incorrect evidence.

`capability-executions-evidence.json` records both Git SHAs and dirty state, SDK version,
API fixture version, runtime settings, exact command, scenario durations and exit code.
Do not claim a clean-revision phase pass from dirty sources. Cleanup stops SDK children
and asks the harness to stop its worker/services on success or failure. Production
ingress, SDK publication, family adoption and caller upgrades remain separate release work.

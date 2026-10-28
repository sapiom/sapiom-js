// Release workflows only run reviewed code: a manual dispatch must come from
// main. The protected environments enforce this too; this fails earlier and
// says why instead of leaving a job stuck on a deployment policy.
const event = process.env.GITHUB_EVENT_NAME ?? "";
const ref = process.env.GITHUB_REF ?? "";

if (event === "workflow_dispatch" && ref !== "refs/heads/main") {
  console.error(
    `::error::Release workflows can only be dispatched from main (got ${ref}). Merge first, then run from main.`,
  );
  process.exitCode = 1;
}

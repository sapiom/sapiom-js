// Release workflows only run reviewed code: a manual dispatch must come from
// main. This fails in the first job and names the ref, before any job reaches
// a protected environment.
const event = process.env.GITHUB_EVENT_NAME ?? "";
const ref = process.env.GITHUB_REF ?? "";

if (event === "workflow_dispatch" && ref !== "refs/heads/main") {
  console.error(
    `::error::Release workflows can only be dispatched from main (got ${ref}). Merge first, then run from main.`,
  );
  process.exitCode = 1;
}

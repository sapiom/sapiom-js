# Architecture: Studio Run Workspace

## Fit

The Studio web shell keeps its existing session action bar, Steps surface, run store, and current-session picker. The harness server exposes the bound agent's cached manifest input contract. Production reads continue through the existing execution inspector; local runs continue through the child bootstrap but stream lifecycle events as attempts happen. One enriched `RunView` drives every layout and target.

## Endpoints

- `GET /api/workflows/:id/input-contract` — return the registered workflow's entry JSON Schema and runnable example, an explicit no-contract result, or an extraction-unavailable reason.
- `POST /api/runs` — unchanged route; the run sheet supplies its existing optional `input`.
- `POST /api/runs/local` — unchanged route; accepts the same input and emits discriminated live step events plus its terminal summary.

## Data

No database changes. `RunView` gains run-level input/output/error/timestamps. `StepView` gains attempt/timestamps/state/directive. The browser keeps current-session runs in memory. Last target and last validated input are stored in local storage by workflow path; payloads never enter analytics.

## Flow

1. Split Run control opens the sheet with an explicit or remembered target.
2. Studio reads the registered workflow's input contract and builds a prefilled form.
3. Validation produces one exact JSON input value and calls the existing local or cloud launch.
4. Cloud polling or local NDJSON events update the same run store.
5. Steps renders a chronological timeline and a shared result/attempt inspector.
6. Contextual debug actions serialize bounded evidence into the active coding-agent session.

## External

No new external services, environment variables, webhooks, or persistence. AJV validates the existing JSON Schema in the browser. Production capability-call arguments/results remain absent until the upstream projection exposes them.

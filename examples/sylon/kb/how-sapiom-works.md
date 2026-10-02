# How Sapiom works

Source: https://docs.sapiom.ai/start/how-sapiom-works

Sapiom separates **authoring an agent** from **running it in production**. Agent Studio and Sapiom MCP help you create and operate the project. The Sapiom runtime executes the deployed version, supplies capability credentials, and records what happens.

```text
Author locally
  Studio or Sapiom MCP
           ↓
Deploy agent version
           ↓
Start managed run
           ↓
Run steps
  ├── Capabilities
  └── Router (optional)
           ↓
Observe run + step activity

Application ──→ Router (direct)
```

## 1. Author locally

An **agent project** is a local TypeScript source folder. Its definition declares an entry step, the steps that can run, accepted input, and transitions between steps.

Use Agent Studio for an integrated workspace, or connect Sapiom MCP to Claude Code or Codex. Both interfaces work with the same project format and local tools.

## 2. Test against capability stubs

Local Run executes your real step code on your machine. Calls through `ctx.sapiom` return configured stubs instead of reaching real Sapiom capabilities.

Using Agent Studio or Sapiom MCP requires Sapiom authentication, including for this local authoring step. The run itself stays on your machine and creates no Sapiom capability spend. It checks your graph, inputs, step code, and expected provider-shaped responses; it does not prove that a real provider will return the same data.

## 3. Deploy a version

Deployment sends the current project source to Sapiom and starts a cloud build. A successful build creates a ready version that a production run can use.

The local project and hosted agent are related but distinct. Editing local files does not change production until you deploy another version, and a run keeps the exact version it started with.

## 4. Start a production run

A **run** is one invocation of the deployed agent. The runtime validates its input, begins at the declared entry step, and follows the directives returned by each step until the agent completes, fails, or waits for an external signal.

For each step dispatch, Sapiom constructs the execution context. That context includes the typed `ctx.sapiom` client and execution attribution needed to associate managed activity with the current organization, run, and step.

## 5. Use capabilities inside the run

Capabilities give agent steps managed access to operations such as search, scraping, browser automation, compute, data, files, images, audio, repositories, email lookup, and domains.

Production capability calls happen inside the Sapiom-managed run. The runtime provides the credential; the agent project does not store a general capability API key.

## 6. Use Router where LLM inference belongs

Router accepts provider-compatible LLM requests and selects available model infrastructure behind the requested Sapiom model label.

There are two supported paths:

- **Inside an agent run:** use Router as part of a step. The request can be attributed to that run and step alongside the rest of the automation.
- **Direct from an application:** authenticate to Router with a Sapiom account credential. The request is observable as Router traffic but is not part of an agent graph or agent-run trace.

Router's direct path is the exception. It does not make other Sapiom capabilities directly callable.

See the [Router API reference](/router) for request formats, model IDs, lanes, and examples.

## 7. Inspect what happened

The agent run is the operational unit for multi-step work. Sapiom records its selected version, current state, step attempts, outputs, and available activity evidence. Capability and Router activity performed with the run's execution context can be connected to that execution.

Direct Router calls retain Router-level request and usage observability, but there is no agent run or step to attach them to.

## Core terms

| Term          | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| Agent Studio  | Integrated local workspace for authoring, testing, deploying, and inspecting agents.         |
| Sapiom MCP    | Project-aware authoring and operations tools used by a coding agent.                         |
| Agent project | Local source folder containing the agent definition and supporting files.                    |
| Agent         | Controlled, deployable multi-step automation owned by a Sapiom organization.                 |
| Version       | Built source revision that can be selected for production runs when ready.                   |
| Run           | One invocation of a deployed agent version. Lower-level interfaces may call it an execution. |
| Step          | One unit of code in the agent graph, dispatched with run context.                            |
| Capability    | Managed operation available to code running inside an agent run.                             |
| Router        | Sapiom's LLM-routing product, usable directly or from an agent run.                          |

## Continue

- [Build your first agent](https://docs.sapiom.ai/agents/quick-start): Create, check, and run the shipped starter locally.
- [Understand agents and projects](https://docs.sapiom.ai/concepts/agents-and-agent-projects): Learn how local source, hosted identity, versions, and runs relate.
- [Explore capabilities](https://docs.sapiom.ai/capabilities): Choose the managed operations your deployed agent steps need.
- [Inspect a production run](https://docs.sapiom.ai/guides/inspect): Read execution state and the evidence recorded for each step.

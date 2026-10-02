# Capabilities

Source: https://docs.sapiom.ai/capabilities

Sapiom capabilities are cloud operations that a deployed agent can call without integrating each backing provider separately. Some calls are metered; check the signed-in dashboard for lifecycle and current price availability before depending on one.

## Source of truth

Every step receives a pre-authenticated capability client at `ctx.sapiom`. The declarations from the version of `@sapiom/tools` installed in the agent project are the authoritative contract. Use editor autocomplete and typecheck the exact method you call.

Local Run replaces capability calls with configured stubs. A production run uses the real, tenant-scoped capability client.

The [Agents capability catalog](https://app.sapiom.ai/agents/authoring#capabilities-inside-steps) is a platform-global projection of code-backed definitions. It can show intrinsic contracts, lifecycle, routing, and a live price when that join is available. It is **not an inventory of resources connected or provisioned for your organization**, and it does not report your observed spend or applied policy. Use a run's inspector and your transaction surfaces for observed execution data.

## Capability guides

- [Search the Web](https://docs.sapiom.ai/capabilities/search): Answers with sources, or raw results
- [Web Scraping](https://docs.sapiom.ai/capabilities/scraping): Read pages as clean markdown or HTML
- [AI Model Access](https://docs.sapiom.ai/capabilities/ai-models): Supported text models discovered at runtime
- [Decisions](https://docs.sapiom.ai/capabilities/decisions): Calibrated probabilities over a fixed answer set
- [Generate Images](https://docs.sapiom.ai/capabilities/images): Text-to-image with optional durable storage
- [Generate Video](https://docs.sapiom.ai/capabilities/video): Short clips with optional native audio
- [Audio Services](https://docs.sapiom.ai/capabilities/audio): Text-to-speech, sound effects, and voices
- [Browser Automation](https://docs.sapiom.ai/capabilities/browser): Capture screenshots and connect to sessions
- [Compute](https://docs.sapiom.ai/capabilities/compute): Provision and operate cloud sandboxes
- [App Links](https://docs.sapiom.ai/capabilities/app-links): Publish an app to a durable URL that outlives its sandbox
- [Data](https://docs.sapiom.ai/capabilities/data): Provision ephemeral Postgres databases
- [File Storage](https://docs.sapiom.ai/capabilities/file-storage): Presigned transfers and controlled sharing
- [Repositories](https://docs.sapiom.ai/capabilities/repositories): Agent-managed Git repositories
- [Email Lookup](https://docs.sapiom.ai/capabilities/email-enrichment): Find and verify professional email addresses
- [Domains & DNS](https://docs.sapiom.ai/capabilities/domains): Register domains and manage DNS

## Availability

The `ctx.sapiom` surface is finite and versioned. This curated guide covers supported product areas, but it is not an exhaustive API reference. If a method is absent from the installed declarations, it is not available to that agent project.

## Next steps

- [Build an Agent](https://docs.sapiom.ai/agents/quick-start): Scaffold, author steps, and deploy.
- [Use Capabilities in a step](https://docs.sapiom.ai/agents/authoring#capabilities-inside-steps): Work from the typed ctx.sapiom contract.

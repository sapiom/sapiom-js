---
"@sapiom/tools": minor
---

content-generation: route `video.create` / `video.launch` through the `/v1/capabilities/content.generation.video` router (SAP-2575)

Video verbs now submit through the shared capability router (like images), so the SDK no longer builds the gateway-direct `/run/<model>` URL: `model` is a request-body field the router's adapter resolves server-side (a semantic alias like `"veo3-fast"`, or a raw provider id, defaulted when omitted), and authentication rides the `/v1` guard's `x-api-key` header. The public `video.create` / `video.launch` surface and the submit-then-poll-to-completion behavior are unchanged.

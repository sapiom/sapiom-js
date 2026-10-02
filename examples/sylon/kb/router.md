# Router API reference

Source: https://docs.sapiom.ai/router

Sapiom Router accepts LLM requests from your application using a Sapiom API key. Choose a model, then use the request format your application already understands.

**Base URL:** `https://router.sapiom.ai`

Open [Router in the dashboard](https://app.sapiom.ai/router) to inspect Router activity. For LLM calls inside a deployed Sapiom agent, see [Choose a call surface](/guides/choose-a-call-surface).

## Authentication

Set `SAPIOM_API_KEY` to your Sapiom API key in the environment where you run the examples. Send it in either `Authorization: Bearer` or `x-api-key`. Router authenticates your Sapiom account; you do not supply a provider API key.

## Request formats

| Format                  | Endpoint                    |
| ----------------------- | --------------------------- |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| Anthropic Messages      | `POST /v1/messages`         |
| OpenAI Responses        | `POST /v1/responses`        |

Each endpoint accepts its named request format and returns that format's response. Router translates between formats when the selected provider uses a different one.

For Responses requests translated to another format, `previous_response_id` is not supported. Include the conversation in `input` instead. Responses requests do not fall back to a different model class.

## Models

The models below were verified on September 15, 2026. Availability can change as Router configuration changes.

Use the request ID in the JSON `model` field with any of the three formats.

| Model             | Request ID      |
| ----------------- | --------------- |
| MiniMax M3        | `m3`            |
| GLM 5.3 Priority  | `glm-priority`  |
| GPT-5.6 Luna      | `gpt-luna`      |
| Claude Opus 4.7   | `claude-opus`   |
| Claude Sonnet 4.6 | `claude-sonnet` |

## Lanes

A lane selects the latency and capacity policy for your request.

Set `x-sapiom-lane` in any request format. The default is `run_now`.

| Lane       | Use                                                         |
| ---------- | ----------------------------------------------------------- |
| `run_now`  | Interactive work; prioritizes latency.                      |
| `standard` | Less urgent work; balances latency and serving cost.        |
| `flex`     | Delay-tolerant work; accepts slower performance under load. |

`run_now` prioritizes latency for interactive work. When available, `standard` balances latency and serving cost, and `flex` accepts slower performance for delay-tolerant work. Lanes influence routing, capacity admission, and fallback budgets.

`flex` uses the same request and streaming APIs. It does not submit an asynchronous job. A request can return HTTP `429` if capacity admission fails; a rejected request is not queued for later execution.

## Example requests

### OpenAI Chat Completions

```bash
curl -sS https://router.sapiom.ai/v1/chat/completions \
  -H "Authorization: Bearer $SAPIOM_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'x-sapiom-lane: run_now' \
  -d '{
    "model": "m3",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Say hello."}]
  }'
```

### Anthropic Messages

```bash
curl -sS https://router.sapiom.ai/v1/messages \
  -H "x-api-key: $SAPIOM_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Say hello."}]
  }'
```

### OpenAI Responses

```bash
curl -sS https://router.sapiom.ai/v1/responses \
  -H "Authorization: Bearer $SAPIOM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-luna",
    "max_output_tokens": 256,
    "input": "Say hello."
  }'
```

For streaming, add `"stream": true` to the JSON body and `-N` to `curl`. Router returns a server-sent event stream in the selected request format.

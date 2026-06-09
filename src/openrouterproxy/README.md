# OpenRouter proxy

An OpenAI-compatible passthrough to [OpenRouter](https://openrouter.ai) with
multi-key rotation and per-key cooldowns. It runs **inside the same server** as
the Qwen proxy (no separate process/port), mounted under the `/openrouter`
prefix so it never collides with the Qwen `/v1/...` routes.

Unlike the Qwen side, this needs **no browser/Playwright** — OpenRouter is a
direct API, so the request and (streamed) response bodies are forwarded as-is.
The only added logic is picking a healthy key and rotating away from any key
that gets rate-limited.

## Configuration

All config is via environment variables (`.env`):

```bash
# Required to enable the proxy — comma-separated pool of keys to rotate.
OPENROUTER_KEYS=sk-or-v1-aaaa,sk-or-v1-bbbb,sk-or-v1-cccc

# Optional ranking headers shown on openrouter.ai
OPENROUTER_REFERER=https://your-app.example
OPENROUTER_TITLE=Your App Name

# Optional upstream override (rarely needed)
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

If `API_KEY` is set (shared with the Qwen proxy), requests must send
`Authorization: Bearer <API_KEY>`. If unset, the proxy is open.

## Endpoints

Base URL for clients: `http://<host>:<port>/openrouter/v1`

| Method | Path                            | Notes                                          |
| ------ | ------------------------------- | ---------------------------------------------- |
| `POST` | `/openrouter/v1/chat/completions` | Stream + non-stream. Rotates keys on failure.  |
| `GET`  | `/openrouter/v1/models`           | Proxies the OpenRouter model list.             |
| `GET`  | `/openrouter/v1/keys`             | Masked key + cooldown status (debugging).      |

Point any OpenAI client at the base URL above and use any OpenRouter model id
(e.g. `deepseek/deepseek-r1:free`).

## Rotation & cooldown behaviour

A key is put on cooldown (and the request retries the next key) when OpenRouter
returns:

| Status | Reason        | Default cooldown                         |
| ------ | ------------- | ---------------------------------------- |
| `429`  | `RateLimited` | from `X-RateLimit-Reset` / `Retry-After`, else 1 min |
| `402`  | `NoCredits`   | 1 hour                                   |
| `401` / `403` | `InvalidKey` | 24 hours                          |
| `5xx`  | upstream      | not cooled; just tries the next key      |

A `4xx` that is the caller's fault (e.g. `400` bad model) is returned as-is
without burning other keys. When every key is on cooldown the proxy replies
`429` with a hint of when the soonest key frees up.

Cooldowns are **in-memory only** (reset on restart) by design.

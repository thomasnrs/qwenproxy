# OpenRouter proxy

An OpenAI-compatible passthrough to [OpenRouter](https://openrouter.ai) with a
**per-key requests-per-second (RPS) throttle**. It runs **inside the same server**
as the Qwen proxy (no separate process/port), mounted under the `/openrouter`
prefix so it never collides with the Qwen `/v1/...` routes.

Unlike the Qwen side, this needs **no browser/Playwright** — OpenRouter is a
direct API, so the request and (streamed) response bodies are forwarded as-is.

## Rate limiting: full manual + proactive RPS

OpenRouter's limits aren't a fixed per-key cooldown — they're per-model and, in
practice, a requests-per-second ceiling. So this proxy does **no automatic
cooldown**. Instead:

- **Per-key RPS throttle (proactive).** Each key has a configurable RPS. Every
  request reserves the soonest free slot across the enabled keys and *waits* for
  it if needed, so the proxy stays under the rate and naturally spreads load
  across keys (concurrent requests fan out to different keys).
- **Failover, no benching.** If a key returns 401/402/403/408/429 or a 5xx, the
  request fails over to the next key — but the key is **never auto-disabled**.
  You manage keys manually (tune RPS or disable) via the admin console.
- **Queue cap.** If every key is saturated for longer than `OPENROUTER_MAX_WAIT_MS`,
  the request returns `429` instead of waiting indefinitely.

All RPS/disable state is **in-memory** (the `.env` provides the boot default).

## Configuration

```bash
# Required — comma-separated pool of keys.
OPENROUTER_KEYS=sk-or-v1-aaaa,sk-or-v1-bbbb,sk-or-v1-cccc

# Requests per second per key (default 1; fractional ok, e.g. 0.5 = 1 req/2s).
OPENROUTER_RPS=1

# Max queue wait before returning 429 when all keys are saturated (ms, default 30000).
OPENROUTER_MAX_WAIT_MS=30000

# Optional ranking headers / upstream override
OPENROUTER_REFERER=https://your-app.example
OPENROUTER_TITLE=Your App Name
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

If `API_KEY` is set (shared with the Qwen proxy), requests must send
`Authorization: Bearer <API_KEY>`. If unset, the proxy is open.

## Endpoints

Base URL for clients: `http://<host>:<port>/openrouter/v1`

| Method | Path                              | Notes                                       |
| ------ | --------------------------------- | ------------------------------------------- |
| `POST` | `/openrouter/v1/chat/completions` | Stream + non-stream. RPS-throttled + failover. |
| `GET`  | `/openrouter/v1/models`           | Proxies the OpenRouter model list.          |
| `GET`  | `/openrouter/v1/keys`             | Key RPS / disabled / next-slot status.      |

Use any OpenRouter model id (e.g. `deepseek/deepseek-r1:free`).

## Live admin (server console)

With the server running in an interactive terminal:

```
or list                  # keys: RPS, status, next free slot
or rps <key|#|all> <n>   # set requests-per-second for a key (or all)
or disable <key|#>       # stop using a key
or enable  <key|#>       # resume using a key
```

Changes take effect immediately and are in-memory (reset to the `.env` defaults
on restart).

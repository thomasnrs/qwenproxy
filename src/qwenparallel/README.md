# Qwen parallel proxy

A second OpenAI-compatible entrypoint for the **same Qwen accounts**, built for
**parallel multi-agent** workloads. It runs inside the same server, mounted under
`/qwen-parallel`, and shares the account pool, the cached Playwright headers, and
the rate-limit cooldown system — but **shares none of the main route's code**, so
it cannot change the behaviour of `/v1/chat/completions`.

## Why it exists

The main Qwen route serializes requests **per account** with a mutex: it drives a
single browser chat session per account, and Qwen rejects a second request to the
same chat ("chat is in progress"). With N accounts you get at most N concurrent
streams — a bottleneck when an orchestrator fans out many agents at once.

This service removes that bottleneck:

- **No per-account mutex** — concurrent requests proceed in parallel.
- **Fresh Qwen conversation per request** (`chat_id: null`) — so parallel requests
  on the same account never collide. The full history is always re-sent in the
  prompt, so dropping server-side session continuity loses nothing.

Result: **one account can serve many simultaneous streams.** (Measured: 5 parallel
requests on a single account complete in ~one request's time, not 5×.)

## Endpoints

Base URL for clients: `http://<host>:<port>/qwen-parallel/v1`

| Method | Path                                  | Notes                              |
| ------ | ------------------------------------- | ---------------------------------- |
| `POST` | `/qwen-parallel/v1/chat/completions`  | Stream + non-stream. Tool calls + thinking supported. |
| `GET`  | `/qwen-parallel/v1/models`            | Proxies the Qwen model list.       |
| `GET`  | `/qwen-parallel/v1/status`            | Per-account cooldown status.       |

Point any OpenAI client at the base URL above. Auth follows `API_KEY` (same as the
rest of the server): if set, send `Authorization: Bearer <API_KEY>`; if unset, open.

## Rotation & cooldown

Reuses the shared account manager: round-robin selection, skips accounts on
cooldown, and on a rate-limit (`RateLimited` / HTTP 429 — whether it arrives as a
non-ok response or inside the stream body) marks the account for the number of
hours Qwen reports. Those cooldowns are persisted to SQLite (shared with the main
route), so they survive restarts.

## When to use which Qwen route

| | `/v1/chat/completions` (main) | `/qwen-parallel/v1/chat/completions` |
| --- | --- | --- |
| Concurrency | serial per account | many per account |
| Chat session | persistent per account | fresh per request |
| Best for | single conversational client | parallel agent fan-out |

Both hit the same accounts and the same cooldown pool — pick per use case.

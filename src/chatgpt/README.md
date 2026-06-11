# ChatGPT proxy (Playwright)

OpenAI-compatible entrypoint that drives **chatgpt.com** through a real browser,
mounted under `/chatgpt`. Same scheme as the Qwen/DeepSeek proxies, with its own
account pool.

## Why it drives the UI

ChatGPT's web is the most locked-down target: Cloudflare bot management, Arkose,
and a Sentinel proof-of-work on `/backend-api/conversation`. Rather than
reverse-engineer any of that, we type + send through the real page (which solves
all of it) and tee the streamed response back to Node via an in-page hook.

## Setup

```bash
# 1) Add an account (opens a real browser; expect a Cloudflare check, then log in)
npm run chatgpt:login

# 2) Start the server; ChatGPT accounts are pre-warmed at boot
npm start
```

Point any OpenAI client at: `http://<host>:<port>/chatgpt/v1`

| Method | Path                            | Notes                       |
| ------ | ------------------------------- | --------------------------- |
| `POST` | `/chatgpt/v1/chat/completions`  | Stream + non-stream         |
| `GET`  | `/chatgpt/v1/models`            | `gpt-4o`, `gpt-4o-mini`, … |
| `GET`  | `/chatgpt/v1/accounts`          | Accounts + initialized state|

Auth follows `API_KEY` like the rest of the server. The web UI's selected model
is used (per-request model switching isn't wired yet).

## ⚠️ Status: needs live tuning

Written without a real ChatGPT session, so expect to iterate:

1. **Cloudflare** may block the automated browser entirely. If `chatgpt:login`
   can't get through, this path won't work from that machine/IP.
2. **UI selectors / send** (`complete.ts → submitPrompt`): assumes `#prompt-textarea`
   and a `[data-testid="send-button"]` (Enter fallback).
3. **SSE parser** (`complete.ts → parsePayload`): handles cumulative `parts` and
   the `{o,p,v}` patch format, but the real stream may differ.

Run with `CHATGPT_DEBUG=1` and read the `[ChatGPT][url]` and `[ChatGPT][raw]`
lines — they show exactly what the page requests and streams, so the matcher and
parser can be locked down.

# DeepSeek proxy (Playwright)

An OpenAI-compatible entrypoint that drives **chat.deepseek.com** through a real
browser, mounted under `/deepseek`. Same spirit as the Qwen proxy (one persistent
browser profile per account), with its **own** account pool.

## Why it drives the UI (and not the API directly)

DeepSeek's web chat is protected by a per-request **proof-of-work** (the
`X-Ds-Pow-Response` header, solved in WASM). Rather than reverse-engineer that, we
**type the prompt and send it through the real page** — the page solves the PoW
and logs in itself. An in-page `fetch` hook tees the streamed response back to
Node. This serializes to one chat at a time per account (concurrency comes from
having multiple accounts).

## Setup

```bash
# 1) Add an account (opens a real browser; log in by hand — captcha possible)
npm run deepseek:login

# 2) Start the server normally; DeepSeek accounts are pre-warmed at boot
npm start
```

Point any OpenAI client at: `http://<host>:<port>/deepseek/v1`

| Method | Path                              | Notes                          |
| ------ | --------------------------------- | ------------------------------ |
| `POST` | `/deepseek/v1/chat/completions`   | Stream + non-stream            |
| `GET`  | `/deepseek/v1/models`             | `deepseek-chat`, `deepseek-reasoner` |
| `GET`  | `/deepseek/v1/accounts`           | Accounts + initialized state   |

Auth follows `API_KEY` like the rest of the server.

## ⚠️ Status: needs live tuning

This was written without access to a real DeepSeek session, so two spots are
**best-effort guesses** that likely need adjustment against the live site:

1. **UI selectors / send** (`complete.ts → submitPrompt`): assumes the input is
   `#chat-input` / `textarea` and that **Enter** sends. If sending doesn't fire,
   this is the place to fix (selector or a send-button click).
2. **SSE parser** (`complete.ts → parsePayload`): handles an OpenAI-ish shape and
   a patch-style `{p,v,o}` shape, but DeepSeek's real stream may differ.

To tune: run with `DEEPSEEK_DEBUG=1`, send one request, and read the
`[DeepSeek][raw]` lines — they show the exact chunks so the parser can be locked
down.

## Files

| File | Role |
| ---- | ---- |
| `accounts.ts` | `deepseek_accounts` table CRUD |
| `browser.ts` | Playwright launch per account, manual login, page lifecycle |
| `tee.ts` | bridges in-page `__dsChunk` → the right request sink |
| `complete.ts` | drives the UI, tees the SSE, parses into events |
| `router.ts` | OpenAI-compatible routes + account rotation |
| `login.ts` | `npm run deepseek:login` CLI |

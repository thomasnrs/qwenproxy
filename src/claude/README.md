# Claude proxy (Playwright)

OpenAI-compatible entrypoint that drives **claude.ai** through a real browser,
mounted under `/claude`. It has its own account pool and persistent browser
profiles in `claude_profiles/`.

## Setup

```bash
# 1) Add an account (opens a real browser; log in by hand)
npm run claude:login

# 2) Start the server; Claude accounts are pre-warmed at boot
npm start
```

Point any OpenAI client at: `http://<host>:<port>/claude/v1`

| Method | Path                          | Notes                 |
| ------ | ----------------------------- | --------------------- |
| `POST` | `/claude/v1/chat/completions` | Stream + non-stream   |
| `GET`  | `/claude/v1/models`           | Generic Claude web ids|
| `GET`  | `/claude/v1/accounts`         | Accounts + init state |

Auth follows `API_KEY` like the rest of the server. The model currently selected
in the Claude web UI is used; the OpenAI `model` field is accepted for client
compatibility.

## Live tuning

Claude's web UI and transport can change. This implementation first tries to
parse streamed web chunks and falls back to reading the rendered assistant text.
Set `CLAUDE_DEBUG=1` to log captured URLs, raw chunks, DOM candidates, and the
selected DOM text. Set `CLAUDE_DEBUG=0` to turn those logs off.

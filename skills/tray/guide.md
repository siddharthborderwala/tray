## Modes

- Interactive (prompts, spinners) only when stdin and stdout are TTYs and
  neither `CI` nor an agent (`AGENT`, `AI_AGENT`, `CLAUDECODE`, `CURSOR_AGENT`,
  `GEMINI_CLI`, `CODEX_THREAD_ID`) is detected. `TRAY_INTERACTIVE=1` forces it
  back on; `--non-interactive` and `--json` always win.
- stdout carries only the answer: a URL, an id, a table, or with `--json` one
  JSON object. Everything else (progress, receipts like `✓ Removed …`,
  warnings, prompts, errors) goes to stderr. On failure stdout is empty.
- Piped tables are tab-separated, with ISO 8601 times.
- In non-interactive mode a value that would have been prompted for is an
  error (exit 2) whose last line is the command to run instead. Confirmations
  need `--yes`; `--yes` never fills in data. `tray rollback` needs a deploy
  id (`tray deploys <site>` lists them).

## Environment

| Variable | Meaning |
|---|---|
| `TRAY_DOMAIN` | Tray to use (e.g. `acme.dev`). |
| `TRAY_API_KEY` | API key (`tray_k_…`). Overrides the saved login. |
| `CLOUDFLARE_API_TOKEN` | Used by `tray setup` and `tray upgrade`. |
| `NO_COLOR`, `CI` | Respected (also `--no-color`). `CI` implies non-interactive. |
| `TRAY_INTERACTIVE` | `1` forces interactive mode (TTYs still required). |

## `--json` shapes

On success: one JSON object on stdout, indented on a terminal, one line when
piped. Lists are `{ "<things>": [...] }` (plus `next` when there's more);
everything else is `{ "<thing>": {...}, "outcome": "…" }`. Either can carry
`warnings: [{ "code", "message" }]`. `outcome` is one of `created`, `updated`,
`unchanged`, `removed`, `revoked`, `added`, `rolled_back`, `logged_in`,
`logged_out`, `approved`.

```jsonc
// tray put
{"site":{"name":"q3-review","url":"https://q3-review.acme.dev","visibility":"public","deploy":"lq3k2-8f1a"},
 "outcome":"created","files":42,"uploaded":3,"bytes":3145728}   // outcome: created | updated | unchanged

// tray list            → {"sites":[{"name","url","visibility","currentDeploy","domains","shareCount","createdAt","updatedAt"}]}
// tray open            → {"site":{…}}
// tray edit            → {"site":{…},"outcome":"updated"}
// tray deploys         → {"deploys":[{"id","files","bytes","spa","createdAt","createdBy","current"}],"next":"…"}
// tray rollback        → {"site":{…},"outcome":"rolled_back"}
// tray remove          → {"site":{"name":"q3-review"},"outcome":"removed"}
// tray share / unshare → {"site":{"name":"q3-review"},"shares":[{"entry","owner"}],"outcome":"added"}

// tray domain add      → {"domain":{"host","site","createdAt"},"outcome":"added"}
// tray domain list     → {"domains":[{"host","site","createdAt"}]}
// tray domain remove   → {"domain":{"host"},"outcome":"removed"}

// tray whoami          → {"account":{"domain","email","key","source"}}   // source: env | keychain | file
// tray login           → {"account":{"domain","email","name"},"outcome":"logged_in"}
// tray logout          → {"account":{"domain"},"outcome":"logged_out"}
// tray account list    → {"accounts":[{"domain","email","name","current"}],"current":"acme.dev"}
// tray account switch  → {"account":{"domain"},"outcome":"updated"}

// tray key create      → {"key":{"id","name","key":"tray_k_…"},"outcome":"created"}   (shown once)
// tray key list        → {"keys":[{"id","name","email","createdAt","lastUsedAt","current"}]}
// tray key revoke      → {"key":{"id","name"},"outcome":"revoked"}
```

**`tray login --json`** waits for approval. Meanwhile it prints one line on
stderr for the user: `{"pending":{"approveUrl","userCode","expiresAt"}}`.

**Errors** (with `--json`): stdout is empty and stderr gets one line. `next`
holds the commands that fix it:

```json
{"error":"q3-review already exists (last put from ~/work/x on mbp)","code":"site_exists",
 "hint":"Overwrite it, or pick another name:","param":"site",
 "next":["tray put ./dist --replace","tray put ./dist --site <OTHER>"]}
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Operation failed (network, server, conflict such as `site_exists`) |
| 2 | Bad usage or missing input (the error names the flag) |
| 4 | Not authenticated or not authorized |
| 130 | Canceled: Ctrl-C, Escape, or "no" at a prompt (nothing was changed) |

## Common error codes

`site_exists`, `site_not_found`, `site_public` (share on a public site; run
`tray edit <site> --visibility private` first), `domain_taken`,
`zone_not_in_account`, `too_large` (over 100 MB), `not_logged_in`,
`unauthenticated`, `network`, `missing_input`, `confirmation_required`,
`invalid_usage`, `unknown_command`, `unknown_option`, `canceled`.

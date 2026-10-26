## Modes

- Interactive (prompts, spinners) only when stdin and stdout are TTYs and
  neither `CI` nor an agent (`AGENT`, `AI_AGENT`, `CLAUDECODE`, `CURSOR_AGENT`,
  `GEMINI_CLI`, `CODEX_THREAD_ID`) is detected. `TRAY_INTERACTIVE=1` forces it
  back on; `--non-interactive` and `--json` always win.
- stdout carries only the result (a URL, a table, or JSON). Progress and
  hints go to stderr.
- In non-interactive mode a value that would have been prompted for is an
  error (exit 2) naming the flag. Confirmations need `--yes`.

## Environment

| Variable | Meaning |
|---|---|
| `TRAY_DOMAIN` | Tray to use (e.g. `acme.dev`). |
| `TRAY_API_KEY` | API key (`tray_k_…`). Overrides the saved login. |
| `CLOUDFLARE_API_TOKEN` | Used by `tray setup` and `tray upgrade`. |
| `NO_COLOR`, `CI` | Respected. `CI` implies non-interactive. |
| `TRAY_INTERACTIVE` | `1` forces interactive mode (TTYs still required). |

## `--json` shapes

One JSON object on stdout (`tray login --json` prints two: the approval link
first, then the result). Indented on a terminal, one line when piped.

```jsonc
// tray whoami
{"domain":"acme.dev","email":"sid@acme.com","key":"mbp","source":"keychain"} // source: env | keychain | file
// with a saved key but no local login record: "email" and "key" are null and a "warning" says to run `tray login <domain>`

// tray put
{"site":"q3-review","url":"https://q3-review.acme.dev","visibility":"public",
 "deploy":"lq3k2-8f1a","files":42,"uploaded":3,"bytes":3145728}

// tray list
{"sites":[{"name":"q3-review","url":"…","visibility":"private","currentDeploy":"lq3k2-8f1a",
  "domains":[],"shareCount":1,"createdAt":"…","updatedAt":"…"}]}

// tray open
{"site":"q3-review","url":"https://q3-review.acme.dev"}

// tray edit            → the site object (as in `list`)
// tray rollback
{"site":"q3-review","url":"https://q3-review.acme.dev","deploy":"lq3k2-8f1a"}

// tray remove
{"site":"q3-review","removed":true}

// tray share / unshare
{"site":"q3-review","data":[{"entry":"sid@acme.com","owner":true},{"entry":"@acme.com","owner":false}]}

// tray domain add      → {"host":"docs.acme.com","site":"docs","createdAt":"…"}
// tray domain list     → {"data":[{"host","site","createdAt"}]}
// tray domain remove   → {"host":"docs.acme.com","removed":true}

// tray login           → {"approveUrl":"…","userCode":"QXFT-7K2M"} then {"domain","email","name"}
// tray logout          → {"domain":"acme.dev","loggedOut":true}
// tray account list    → {"current":"acme.dev","data":[{"domain","email","name","current"}]}
// tray account switch  → {"current":"acme.dev"}

// tray key create      → {"id":"3f9a0c1d2e4b","name":"ci","key":"tray_k_…"} (shown once)
// tray key list        → {"data":[{"id","name","email","createdAt","lastUsedAt"}]}
// tray key revoke      → {"id":"3f9a0c1d2e4b","revoked":true}

// tray skill install   → {"written":["/Users/sid/.agents/skills/tray/SKILL.md", …],"unchanged":[…]}

// any error
{"error":"q3-review already exists (last put from ~/work/x on mbp)","code":"site_exists",
 "hint":"Use --replace to overwrite it, or -s <other> to pick another name.","param":"site"}
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Operation failed (network, server, conflict such as `site_exists`) |
| 2 | Bad usage or missing input (the error names the flag) |
| 4 | Not authenticated or not authorized |
| 130 | Cancelled: Ctrl-C, Escape, or "no" at a prompt (interactive only) |

## Common error codes

`site_exists`, `site_not_found`, `site_public` (share on a public site; run
`tray edit <site> --visibility private` first), `domain_taken`,
`zone_not_in_account`, `too_large` (over 50 MB), `not_logged_in`,
`unauthenticated`, `network`, `missing_input`, `invalid_usage`.

# Tray CLI: output, errors, consent and help

Design for the CLI audit against https://vercel.com/design/cli (2026-11-07).
Once approved, the contracts here replace the matching parts of SPEC §4.
Unchanged on purpose: auth and permission errors exit 4 (the `gh`
convention), and prompts need stdout to be a TTY as well as stdin.

## 1. Streams

| | stdout | stderr |
|---|---|---|
| Human | Only the answer: a URL, host, key secret or table | Everything else: frames, progress, receipts, warnings, prompts, empty states, errors |
| `--json` | Exactly one JSON document, on success only | Errors as one JSON line, plus the `login` pending line. Nothing else |

So `x=$(tray …)` captures only the answer, and an empty stdout means failure.

Exit codes are unchanged: 0 ok, 1 failed, 2 usage or missing input, 4 auth,
130 canceled.

## 2. JSON

**Success.** One object. Every key is camelCase. There are three shapes:

```jsonc
// Lists: the plural noun, plus a cursor when there's more.
{ "sites": [ … ] }
{ "deploys": [ … ], "next": "mw2gq…" }

// Single things (reads and mutations): the noun, and what happened.
{ "site": { … }, "outcome": "created" }
{ "key":  { … }, "outcome": "revoked" }

// Either shape can carry warnings (only when there are any).
{ "site": { … }, "outcome": "updated", "warnings": [{ "code": "private_ignored", "message": "…" }] }
```

`outcome` is one of `created`, `updated`, `unchanged`, `removed`, `revoked`,
`added`, `rolled_back`, `logged_in`, `logged_out` or `approved`. With `--json`,
warnings go only in `warnings`, never on stderr.

**Errors.** The same keys as the API (`{ error, code, hint?, param? }`), plus
`next`: the commands that fix it. They go **on stderr**, as one line.

```json
{"error":"Not logged in to acme.dev.","code":"not_logged_in","next":["tray login acme.dev"]}
```

**`login --json`.** The approve link goes on stderr as one line, so an agent
can relay it while the command waits:
`{"pending":{"approveUrl":"…","userCode":"QXFT-7K2M","expiresAt":"…"}}`.
Once it's approved, stdout gets the single result:
`{"account":{…},"outcome":"logged_in"}`.

**`--version --json`** prints `{"version":"0.2.0"}`.

## 3. Human output

**What goes on stdout per command.** Receipts like `✓ Removed q3-review.` go on stderr.

| Command | stdout |
|---|---|
| `put`, `edit`, `rollback`, `open` | The site URL |
| `list`, `deploys`, `domain list`, `key list`, `account list`, `share <site>` | The table |
| `remove` | The site name |
| `domain add` | `https://<host>` |
| `key create` | The secret (no change) |
| `share`, `unshare` | The resulting share table |
| `whoami` | A key/value table |
| `login`, `logout`, `approve`, `account use`, `setup`, `skill install`, `upgrade` | Nothing; the receipt goes on stderr |

**Interactive mode.** The Clack frame (`┌ … └`) is drawn entirely on stderr,
and the bare answer is printed on stdout after it.

**Tables.** On a TTY: padded columns, relative times (`3d ago`), and `—` for
empty cells. When piped: tab-separated, ISO 8601 UTC times, empty cells, and
the header row kept.

**Empty results.** stderr gets `No sites on acme.dev.`, then the next
command indented underneath. stdout gets nothing on a TTY, and only the header
row when piped.

**Progress when non-interactive.** One plain line per phase on stderr, such as
`Collected 12 files (1.2 MB)`, `Uploaded 3 changed files` and
`Deployed q3-review`, so CI logs show progress. With `--json`: none.

## 4. Errors

```text
✗ Couldn't reach tray.acme.dev.
  The connection was refused.

Check the domain, or log in again:
    tray login acme.dev
```

- **Headline:** one sentence written by the CLI, ending with a period. It
  starts with `✗` on a TTY and `Error:` when plain or `NO_COLOR` is set.
  Raw network, Bun and Worker text never goes in the headline: it goes in a
  detail line (indented 2) and in JSON `data.cause`.
- **Recovery:** a label line, then at most two exact commands, indented 4,
  without backticks. In JSON these are `next`.
- **The data model:** `TrayError` gets `details?: string[]` and
  `next?: string[]`. The free-text `hint` stays, for prose that isn't a
  command.

**Usage errors** report only the first unknown token:

```text
✗ Unknown command pt for tray. Did you mean put?

See all commands:
    tray --help
```

The same goes for `Unknown option --prvate for tray put. Did you mean
--private?`. The suggestion appears only within edit distance 2. Codes are
`unknown_command` and `unknown_option`.

**Invalid values** state the rule and name the value:
`Can't share q3-review. 2 entries are invalid.`, with one detail line per
entry (`notanemail: not an email or @domain`).

**Missing input when non-interactive** shows the retry command, keeping the
user's own arguments:

```text
✗ Can't edit q3-review without --visibility in non-interactive mode.

Run:
    tray edit q3-review --visibility private
```

**Canceling** isn't an error. stderr gets `Canceled. Nothing was changed.`,
the code is `canceled` and the exit is 130, with no `✗`.

## 5. Consent

| Tier | Commands | Interactive | Non-interactive |
|---|---|---|---|
| Safe | Reads, `put` (new site), `share`, `domain add`, `key create`, `rollback` | No prompt | No prompt |
| Destructive: deletes, changes access, or overwrites | `remove`, `key revoke`, `unshare`, `edit --visibility public`, `put --replace` | Preview what changes, then y/N | Needs `--yes`, else exit 2 with the retry command including `--yes` |

**`remove`** is the only thing that can't be undone (the site, every deploy,
its custom-domain links). It looks the site up first, so a missing site errors
without a prompt. Then it previews:

```text
Site            q3-review
URL             https://q3-review.acme.dev
Custom domains  2
Deploys         14

This cannot be undone.
Remove q3-review? (y/N)
```

**Rollback never guesses when non-interactive.** Without `--to`, it fails with
`missing_input`, and the deploy it would have picked goes in `next`:
`tray rollback q3-review --to mw2gq…`. In interactive mode, the picker
shows `From` and `To` before acting. No confirmation, since another rollback
undoes it.

`--yes` still answers only confirmations. It never fills in data or an
inferred target.

## 6. Help

- `tray help` and `tray help <cmd…>` work like `--help`.
- A bare group (`tray domain`, `tray key`) prints its help on stdout and
  exits 0.
- **Root help is grouped by task:**
  - Publish: `put`, `list`, `open`, `deploys`, `rollback`, `remove`
  - Access: `edit`, `share`, `unshare`
  - Domains: `domain`
  - Account: `login`, `logout`, `whoami`, `account`, `key`, `approve`
  - Setup: `setup`, `upgrade`, `skill`
- **Leaf help** has Usage, a summary, Arguments, Options and Examples (1–3,
  each checked by a test that runs it through the parser), then
  `Global options: see tray --help` and `Learn more: https://tray.sh/cli#<cmd>`.
- **Summaries** are imperative with no period, and never teach aliases. The
  aliases still work. Behavior notes move into a Notes section.
- **`--`** ends option parsing, so `tray put -- -weird.html` works.

## 7. New commands and global options

- **`tray deploys <site> [--limit N] [--next CURSOR]`:** a newest-first table
  of id, created and source, with the current deploy marked. Uses the existing
  `GET /sites/{site}/deploys` endpoint (`limit`, `before`). It's where
  `rollback --to` gets its ids from.
- **Global options:**
  - `--no-color` (and `NO_COLOR`)
  - `--no-open` (open, login, setup): print the URL and don't launch a browser
  - `--debug`: one stderr line per API call (`GET https://tray.acme.dev/v1/sites 200 84ms`), never with headers or bodies
- **Other fixes:**
  - **Config:** writes are atomic (a temp file, then a rename), including `auth.json`.
  - **Skill copies:** when `login` or `setup` refreshes them, they say so in one stderr line.
  - **whoami:** prints `key: from TRAY_API_KEY`, not the variable name twice.
  - **share:** listing stays `tray share <site>`. A `share list` subcommand would collide with a site named `list`, so the bare form is documented as canonical.

## 8. Compatibility

Breaking for scripts: errors move to stderr, JSON shapes change, `login
--json` splits its output, rollback needs `--to` when non-interactive, and
`cancelled` becomes `canceled`. There are no users before launch, so this
ships as **0.2.0**, with SPEC §4, `cli.md`, `guide.md`, `SKILL.md` (the login
line, `--json` errors) and the site's docs updated in the same release.

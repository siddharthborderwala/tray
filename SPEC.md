# Tray — CLI spec (v1)

> Artifacts for every agent. Put it on a tray. Pass it around.

Tray turns a folder, zip, or HTML file into a URL on your own domain. It is
self-hosted on the user's Cloudflare account and built for both people and
agents.

- Project home: `tray.sh` (docs, install script)
- Example instance: `thts.app` → sites at `<site>.thts.app`, API at `tray.thts.app`

---

## 1. Principles

1. **One command to share.** `tray put ./thing` prints a URL.
2. **Agents are first-class.** Every prompt has a flag. No hangs without a TTY.
   Clean stdout. `--json` everywhere.
3. **Humans get delight.** Interactive terminals get Clack-styled output.
4. **Nothing is lost.** Deploys are immutable; `rollback` always works.
5. **Self-hosted only.** No Tray-operated servers. Cloudflare is the root of trust.

---

## 2. Architecture

```
tray CLI ──HTTPS──► Worker (tray.<domain>)  ──► R2 bucket
                         ▲
visitor ──► <site>.<domain> / custom host ──► same Worker (serving)
                         ▲
              Cloudflare Access (owner login, sign-in for private sites)
```

- **Worker**: serves all sites and exposes the API on `tray.<domain>`. Built
  with Hono (see §5).
- **R2**: all content and state. No database.
- **Cloudflare Access**: identity for login and for private sites.
- **CLI ↔ Cloudflare API**: plain `fetch`, no SDK, no Wrangler.

### Storage layout (R2)

```
blobs/<sha256>                         file contents (content-addressed)
sites/<site>/meta.json                 { visibility, sharedWith[], createdBy, source }
sites/<site>/current                   active deploy id
sites/<site>/deploys/<id>.json         { files: { "/path": {hash,size,type} }, spa, createdAt, createdBy }
hosts/<hostname>                       custom domain → site
keys/<id>.json                         { hash, name, email, createdAt, lastUsedAt }   id = sha256(key)[0:12]
auth/pending/<deviceCode>.json         { userCode, name, ip, expiresAt, key? }
auth/codes/<userCode>                  deviceCode (index for approve)
```

### Limits

- 50 MB total per deploy (checked by CLI and Worker).
- Site names: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`. Reserved: `tray`.

---

## 3. Command conventions

Verified against `gh` and `vercel` docs.

| Rule | Example |
|---|---|
| Main object (sites) gets top-level verbs | `tray put`, `tray list`, `tray share` |
| Sub-resources are noun → verb, singular (plural alias accepted) | `tray domain add` (`domains` works) |
| The thing being acted on is positional; the parent site is a flag | `tray domain add docs.acme.com -s docs` |
| Long names are canonical; short aliases exist | `list` / `ls`, `remove` / `rm` |
| Create-time booleans, edit-time values | `put --private`, `edit --visibility public` |

### Global flags

| Flag | Meaning |
|---|---|
| `--json` | Print one JSON object to stdout (results and errors). Implies non-interactive. |
| `--non-interactive` | Never prompt. Missing input is an error. |
| `-y, --yes` | Accept confirmations. |
| `--domain <d>` | Use this tray instead of the current account. |
| `-h, --help` / `-v, --version` | Help / version. |

### Environment

| Variable | Meaning |
|---|---|
| `TRAY_DOMAIN` | Tray to use (e.g. `thts.app`). |
| `TRAY_API_KEY` | API key. Overrides saved login. |
| `CLOUDFLARE_API_TOKEN` | Used by `tray setup` and `tray domain add`. |
| `NO_COLOR`, `CI` | Respected. `CI` implies non-interactive. |

### Credential resolution

`--domain` / `TRAY_DOMAIN` → saved current account → error.
`TRAY_API_KEY` → saved key for that domain (Keychain via `Bun.secrets`, else
`~/.config/tray/auth.json`, mode 600) → error:

```
error: not logged in to thts.app
Run `tray login thts.app` or set TRAY_API_KEY.
```

### Output and modes

Interactive mode only when stdin **and** stdout are TTYs, `CI` is unset, and
neither `--json` nor `--non-interactive` is passed.

- **stdout** carries only the result (a URL, a table, or JSON).
- **stderr** carries progress, spinners, and hints.
- Every prompt maps to a flag. In non-interactive mode a missing value exits 2
  naming the flag.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Operation failed (network, server, conflict) |
| 2 | Bad usage or missing input |
| 4 | Not authenticated / not authorized (same as `gh`) |
| 130 | Cancelled: Ctrl-C, Escape, or "no" at a prompt (interactive only) |

JSON errors: `{ "error": "message", "code": "site_exists", "hint": "…", "param": "…" }` (same shape as the API, §5).

---

## 4. Commands

### Overview

```
tray put <path> [-s site] [--private] [--spa] [--replace]
tray list | ls
tray open <site>
tray edit <site> --visibility public|private [--yes]
tray rollback <site> [--to <deploy-id>]
tray remove | rm <site> [--yes]

tray share <site> [<email|@domain>...]
tray unshare <site> <email|@domain>...

tray domain add <host> -s <site>
tray domain remove | rm <host> [--yes]
tray domain list | ls [-s <site>]

tray login [domain]
tray approve <code>
tray logout [domain]
tray account list | ls
tray account switch <domain>

tray key create [--name <name>]
tray key list | ls
tray key revoke <name>

tray setup [--domain <d>] [--email <e>]
tray upgrade
```

---

### `tray put <path>`

Publish a folder, `.zip`, `.tar.gz`, single `.html` file, or `-` (stdin HTML).

| Flag | Meaning |
|---|---|
| `-s, --site <name>` | Site name. Default: slug of the folder or file name (`report.html` → `report`). |
| `--private` | Only the owner can view. Applies when creating (or with `--replace`). |
| `--spa` | Unknown paths serve `/index.html`. |
| `--replace` | Overwrite a site last put from a different source. |

**Collecting files**
- Folder: walk recursively; skip `.git`, `.DS_Store`, `node_modules`, dotfiles
  (except `.well-known`).
- Zip / tar.gz: unpack in memory (fflate / `Bun.Archive`); skip `__MACOSX`;
  strip a single shared top-level folder.
- Single `.html` or stdin: becomes `/index.html`.

**Upload**
1. Hash every file (SHA-256); content type from `Bun.file().type`.
2. Reject if total > 50 MB (exit 1, lists the largest files).
3. `POST /v1/blobs/check` in batches of 512 hashes, up to 20 requests in parallel → missing hashes.
4. `PUT /v1/blobs/<hash>` for each missing file, up to 32 in parallel.
5. `POST /v1/sites/<site>/deploys` with the manifest and `source` → URL.

**Name conflicts**

The CLI records `site → { absolutePath, machineId }` in `~/.config/tray/`.

| Situation | Behaviour |
|---|---|
| Site doesn't exist | Create it. |
| Exists, last put from this path on this machine | Update it. |
| Exists, from elsewhere, interactive | Prompt: `report already exists (last put from ~/work/x on mbp). Replace? y/N` |
| Exists, from elsewhere, non-interactive | Exit 1, code `site_exists`, hint: use `--replace` or `-s <other>`. |

Old deploys are always kept, so a replace is undoable with `tray rollback`.

**Visibility on redeploy**: unchanged. `--private` only applies to new sites or
with `--replace`. Use `tray edit` to change it.

**Output**

```
# interactive
┌  tray
◇  Collected 42 files · 3.1 MB
◇  Uploaded 3 changed files
└  https://report.thts.app   (private · you)

# non-interactive
https://report.thts.app

# --json
{"site":"report","url":"https://report.thts.app","visibility":"public",
 "deploy":"lq3k2-8f1a","files":42,"uploaded":3,"bytes":3145728}
```

---

### `tray list` (alias `ls`)

```
SITE      URL                        VISIBILITY   DOMAINS          UPDATED
report    https://report.thts.app    private (3)  —                2m ago
docs      https://docs.thts.app      public       docs.acme.com    3d ago
```

`(3)` = number of people it is shared with, including the owner.

### `tray open <site>`

Opens the site in the default browser. Non-interactive: prints the URL.

### `tray edit <site> --visibility public|private`

- `private` → only the owner (and people it is shared with) can view it.
- `public` → anyone with the link. Requires confirmation (or `--yes`), since
  it exposes the site:
  `report will be visible to anyone with the link. Continue? y/N`
- Existing share lists are kept while private and restored if made private again.

### `tray rollback <site> [--to <deploy-id>]`

Points the site at the previous deploy, or at `--to`. Prints the URL and the
deploy id now live. Interactive with no `--to`: pick from recent deploys.
Without `--to`, the CLI resolves "previous" from `GET /sites/<site>/deploys`
and always sends an explicit `to` to the API.

### `tray remove <site>` (alias `rm`)

Deletes the site pointer and its custom-domain mappings.
Confirmation required (or `--yes`). Blobs are left for later garbage collection.

---

### `tray share` / `tray unshare`

Who can see a **private** site. Entries are emails or `@domain` (anyone with an
email at that domain).

```
tray share report bob@acme.com @acme.com   # add people
tray unshare report bob@acme.com           # remove
tray share report                          # list who can see it
```

- On a public site: exit 1 with
  `report is public. Make it private first: tray edit report --visibility private`.
- The owner is always included and cannot be removed.
- Stored in `meta.json` (`sharedWith[]`) and enforced by the Worker. No per-site
  Cloudflare Access apps (see "Private sites" in §5).

---

### `tray domain`

```
tray domain add docs.acme.com -s docs
tray domain rm docs.acme.com
tray domain list [-s docs]
```

- `add` attaches the host as a Worker Custom Domain (Cloudflare creates DNS and
  TLS) and writes `hosts/<host>`. Needs `CLOUDFLARE_API_TOKEN` or the token
  saved by setup.
- v1 requires the host's zone to be on the same Cloudflare account. Otherwise
  exit 1 with an explanation.
- The host is added to the sign-in Access app, so "Sign in to view" works there too.

---

### Auth: `login`, `approve`, `logout`, `account`

```
$ tray login thts.app
Opening https://tray.thts.app/approve?code=QXFT-7K2M
  or on a logged-in machine: tray approve QXFT-7K2M
waiting…
✓ Logged in as sid@acme.com on thts.app
```

Flow (device code):
1. `POST /auth/device` → `{ deviceCode, userCode, approveUrl, interval }`.
2. Approval, either:
   - **Browser**: `tray.<domain>/approve` is behind Cloudflare Access. The user
     signs in with email (one-time code) or Google. The page shows device name
     and IP with an Approve button. The Worker reads the verified email from
     `Cf-Access-Jwt-Assertion`.
   - **CLI**: `tray approve <code>` on a logged-in machine shows device name and
     IP and asks `Approve? y/N`.
3. The CLI polls `POST /auth/token` until it receives an API key bound to that
   email and device name.

- Codes expire after 10 minutes and are single-use.
- `--name <device>` sets the device/key name (default: hostname).
- Non-interactive `login` prints the URL and code to stderr and keeps polling;
  `--json` prints `{ "approveUrl", "userCode" }` first, then the result.
- Multiple trays: log in to each domain once. `tray account list` shows them;
  `tray account switch <domain>` sets the current one; `--domain` overrides per
  command.
- `tray logout [domain]` revokes this device's key and removes it locally.

### `tray key`

API keys for agents and CI. Same kind of credential as login keys.

```
$ tray key create --name ci
tray_k_3f9a…   (shown once)
$ tray key list
NAME      EMAIL           CREATED   LAST USED
mbp       sid@acme.com    3d ago    now
ci        sid@acme.com    now       never
$ tray key revoke ci
```

Keys are prefixed `tray_k_` (secret-scanner friendly) and stored hashed.

---

### `tray setup`

One-time provisioning of a tray on the user's Cloudflare account.

```
$ tray setup
? Domain for your tray (must be on Cloudflare): thts.app
? Cloudflare API token (needs: Workers, R2, DNS, Access): ****
? Your email: sid@acme.com
◇  R2 bucket            tray-thts-app
◇  Worker               tray
◇  Routes + DNS         *.thts.app, tray.thts.app
◇  Access               tray.acme.dev/approve → sid@acme.com
◇  Sign-in              *.acme.dev/.tray/signin (email code)
└  Your tray is ready at thts.app. This machine is logged in.
```

- Flags: `--domain`, `--email`; token from `CLOUDFLARE_API_TOKEN` or prompt.
- Idempotent: re-running updates the Worker and fixes missing pieces.
- Checks that Zero Trust is enabled; if not, links to the one-time enable page.
- The Worker source is embedded in the CLI binary.
- Recovery: re-running setup with the Cloudflare token issues a fresh key for
  this machine, even if all keys were lost.

### `tray upgrade`

Replaces the binary with the latest release, then offers to redeploy the Worker
if its version is older.

---

## 5. Worker API (`https://tray.<domain>/v1`)

Every route needs `authorization: Bearer tray_k_…` unless marked *no auth*.
Every response carries a `tray-version: <worker semver>` header; the CLI warns
when the Worker is older than itself ("run `tray upgrade`").

### Conventions

- Paths use plural nouns. Actions on a resource are `POST` sub-paths
  (`/sites/{site}/rollback`, `/blobs/check`).
- Single resources are returned as bare objects. Lists are wrapped:
  `{ "data": [...] }` (plus `hasMore` where paginated).
- Field names are camelCase. Timestamps are ISO 8601 UTC strings (`createdAt`).
- `DELETE` never takes a body; the item is in the path. Returns `204`.
- Every write is safe to retry: putting the same manifest returns the existing
  deploy, `rollback` names its target, adding shares/domains that already exist
  is a no-op. No `Idempotency-Key`, no rate-limit headers.
- Request ids: Cloudflare's `cf-ray` header; the CLI prints it on 5xx.
- Header names are written lowercase everywhere (code, docs, examples):
  `authorization`, `content-length`, `tray-version`. HTTP/2 and HTTP/3 send
  them lowercase anyway.

### Endpoints

```
POST   /blobs/check                 {hashes[≤512]} → 200 {missing[]}
PUT    /blobs/{sha256}              raw body, content-length required → 201 new | 200 exists {hash,size}

GET    /sites                       → {data:[Site]}
GET    /sites/{site}                → Site
PATCH  /sites/{site}                {visibility} → Site
DELETE /sites/{site}                → 204

POST   /sites/{site}/deploys        {files,spa,visibility?,replace?,source} → 201 new | 200 unchanged {site,deploy}
GET    /sites/{site}/deploys        ?limit=20&before=<deployId> → {data:[Deploy], hasMore}
POST   /sites/{site}/rollback       {to} → Site

GET    /sites/{site}/shares         → {data:[Share]}
POST   /sites/{site}/shares         {entries[]} → {data:[Share]}
DELETE /sites/{site}/shares/{entry} → 204

GET    /domains                     ?site= → {data:[Domain]}
POST   /domains                     {host,site} → 201 Domain | 200 same mapping | 409 domain_taken
DELETE /domains/{host}              → 204

GET    /keys                        → {data:[Key]}
POST   /keys                        {name} → 201 {id,name,key}   (key shown once)
DELETE /keys/{id}                   → 204
DELETE /keys/current                → 204   (logout)

POST   /auth/device                 {name}            no auth → DeviceCode
POST   /auth/token                  {deviceCode}      no auth → 200 {key,email,name} | 400 pending/expired/denied
GET    /auth/device/{userCode}      → {name, ip, expiresAt}   (for `tray approve`)
POST   /auth/approve                {userCode, approve?: true} → 204   (key, or Access identity)

GET    /openapi.json                no auth
```

Notes:

- `POST /blobs/check`: R2 calls count against the Workers per-request limit
  (1,000 Free / 10,000 Paid), so 512 hashes per call is safe on both.
- `PUT /blobs/{sha256}`: streamed into `R2.put(key, body, { sha256 })`. `411`
  without `content-length`, `413` over 50 MB, `400 digest_mismatch` if R2
  rejects the hash.
- `POST /sites/{site}/deploys` creates the site if needed. `source` is
  `{ path, machine }` and drives the `site_exists` check. If `files` + `spa`
  equal the current deploy, it returns that deploy with `200`. It checks that
  every blob not in the current deploy exists; otherwise `409 missing_blobs`
  with `missing: [...]`.
- `rollback.to` is required. The CLI fetches recent deploys to pick from.
- Keys get a stable `id` = first 12 hex chars of `sha256(key)`; stored at
  `keys/<id>.json` (with the full hash inside). The CLI maps names to ids and
  errors if a name is ambiguous.
- Device flow follows RFC 8628 semantics without OAuth formalities: no
  `grant_type` / `client_id`; error codes `authorization_pending`, `slow_down`,
  `expired_token`, `access_denied`. A `userCode → deviceCode` index lives at
  `auth/codes/<userCode>`.

### Shapes

```jsonc
// Site
{ "name": "q3-review", "url": "https://q3-review.acme.dev", "visibility": "private",
  "currentDeploy": "lq3k2-8f1a", "domains": [], "shareCount": 1,
  "createdAt": "2026-10-26T09:12:03Z", "updatedAt": "2026-10-26T09:12:03Z" }

// Deploy
{ "id": "lq3k2-8f1a", "files": 42, "bytes": 3145728, "spa": false,
  "createdAt": "2026-10-26T09:12:03Z", "createdBy": "sid@acme.com" }

// POST /sites/q3-review/deploys request
{ "files": { "/index.html": { "hash": "9f86d0…", "size": 5120, "type": "text/html" } },
  "spa": false, "visibility": "private", "replace": false,
  "source": { "path": "/Users/sid/work/q3-review", "machine": "mbp-3f9a" } }

// DeviceCode
{ "deviceCode": "…", "userCode": "QXFT-7K2M",
  "verificationUri": "https://tray.acme.dev/approve",
  "verificationUriComplete": "https://tray.acme.dev/approve?code=QXFT-7K2M",
  "expiresIn": 600, "interval": 5 }
```

### Errors

One flat shape everywhere, identical to CLI `--json` errors. Codes are
lowercase snake_case. `param` names the bad field on validation errors. Some
codes add fields (e.g. `missing`).

```json
{ "error": "q3-review already exists (last put from ~/work/x on mbp)",
  "code": "site_exists",
  "hint": "Pass replace: true (CLI: --replace) or use another site name.",
  "param": "site" }
```

| Status | Codes |
|---|---|
| 400 | `invalid_request`, `digest_mismatch`, `authorization_pending`, `slow_down`, `expired_token`, `access_denied` |
| 401 | `unauthenticated` |
| 403 | `forbidden` |
| 404 | `site_not_found`, `deploy_not_found`, `domain_not_found`, `key_not_found` |
| 409 | `site_exists`, `domain_taken`, `missing_blobs`, `site_public` |
| 411 | `length_required` |
| 413 | `too_large` |
| 422 | `zone_not_in_account` |
| 5xx | `internal` |

CLI exit codes: 401/403 → 4, 400 → 2, everything else → 1. No other codes.

### Implementation

- **Hono** on Workers. One app: `/v1/*` and `/approve` on `tray.<domain>`;
  every other host falls through to the serving handler.
- **`@hono/zod-openapi`**: every route declares params, body and responses as
  zod schemas (from `packages/schema`). Invalid input → `400 invalid_request`
  with `param` (via the default hook). `GET /v1/openapi.json` is generated from
  the same schemas.
- **Auth middleware**: bearer key on everything except `/auth/device`,
  `/auth/token` and `/openapi.json`. Keys looked up by id, then the full
  `sha256(key)` compared.
- **Typed client**: the Worker exports its app type; the CLI uses Hono's `hc`
  client typed from it.
- **Shared schemas**: `packages/schema` is used by the Worker, the CLI and the
  OpenAPI output.

### Serving

Resolve site from `Host` (`<site>.<domain>` or `hosts/<hostname>`); path order
`/x` → `/x.html` → `/x/` (redirect) → `/x/index.html` → SPA fallback →
`/404.html` → Tray 404 page. ETag = file hash.

### Private sites (no enumeration)

A visitor must not be able to tell a private site from one that doesn't exist.

- Three cases return the **identical** response: the site doesn't exist; the
  site is private and the visitor isn't signed in; the visitor is signed in
  but not on the share list. All return `404` with the Tray 404 page, which has
  a "Sign in to view" link. Same status, same body, same headers
  (`Cache-Control: no-store`). The Worker does the same lookups in each case.
- **Sign in** goes to `/.tray/signin?next=<path>` on the same host. That path,
  and only that path, is covered by **one** Cloudflare Access app created by
  `tray setup`: destination `*.<domain>/.tray/signin` plus each custom host,
  policy "anyone with an email code". Access only proves who the visitor is.
  The Worker decides what they can see.
- After sign-in Access sets its `CF_Authorization` cookie for that host and the
  Worker redirects to `next`. On every request to a private site the Worker
  reads that cookie, verifies the JWT (team certs, sign-in app `aud`), and
  checks the email against the owner and `sharedWith[]`.
- Signed-in visitors see "Signed in as <email> · Sign out" on the 404 page,
  whether or not the site exists. Sign out goes to `/cdn-cgi/access/logout`.
- Public sites never touch Access.
- Every person who signs in uses a Cloudflare Zero Trust seat (Free plan: 50).
  `tray setup` mentions this.

---

## 6. Distribution

- Bun + TypeScript, compiled with `bun build --compile` for darwin-arm64,
  darwin-x64, linux-x64, linux-arm64, windows-x64.
- `curl -fsSL tray.sh/install | sh` → `~/.local/bin/tray`.
- Versioning: one version for the whole project (CLI and the Worker bundle it
  embeds). Starts at `0.1.0`. Released by tagging `vX.Y.Z`; GitHub Releases is
  the changelog. The CLI compares its version with the Worker's `tray-version`.
- npm: `@traysh/cli` (bin: `tray`). `npm i -g @traysh/cli` or `bunx @traysh/cli`. Internal packages use the same scope (`@traysh/schema`, `@traysh/worker`).
- CLI dependencies: `@clack/prompts`, `@bomb.sh/router` (pinned), `zod`,
  `fflate`, `hono` (client only).
- Worker dependencies: `hono`, `@hono/zod-openapi`, `zod`. The Worker bundle is
  embedded in the CLI binary and uploaded by `tray setup`.
- Repo: one Bun workspace — `apps/cli`, `apps/worker`, `apps/site` (Astro,
  tray.sh, serves `/install`), `packages/schema` (shared zod schemas).

---

## 7. Out of scope for v1

- BYO S3 storage
- Custom domains outside the user's Cloudflare account (Cloudflare for SaaS)
- Signed / expiring share links
- Teammates who can publish (`tray member`)
- DNS-based email → domain discovery
- MCP server
- Hosted Tray service
- `tray gc` for old deploys and orphaned blobs

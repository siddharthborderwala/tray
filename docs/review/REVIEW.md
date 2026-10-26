# Tray pre-launch review

Scope: the whole repo at `cf1e08c` (CLI, Worker, schema, site, skill, scripts,
CI/release), read against SPEC.md. Nothing here touched the real Cloudflare
API; items that need a live check are marked **(live)**.

Baseline: `fmt:check`, `lint`, `typecheck`, `test` (238 pass) and `build` were
all green before any change.

Severity: **critical** = launch-blocking breakage or exploitable now;
**high** = security issue or a failure real users will hit; **medium** =
incorrect behaviour with a workaround, or spec drift; **low** = polish,
hardening, docs.

---

## Critical

### C1. The install script is broken: `detect_target` no longer exists

- **Where:** `scripts/install.sh:19` calls `detect_target`. The function was
  deleted in f3d08be (the PATH rework). `apps/site/src/pages/install.ts` serves
  this file verbatim at `tray.sh/install`.
- **Failure:** `curl -fsSL tray.sh/install | sh` prints
  `sh: detect_target: not found` and exits 127 before downloading anything.
  This is the primary install path in the README, the site, the CLI hints and
  the skill.
- **Why tests missed it:** `apps/cli/test/install-sh.test.ts` only runs `sh -n`
  (syntax) and sources the file to call `setup_path`; nothing calls `main` or
  `detect_target`.
- **Fix:** restore `detect_target` (darwin/linux, x64/arm64, Rosetta, musl).
  Add tests that run `detect_target` and that every function `main` calls is
  defined.

## High

### H1. Open redirect after sign-in (`/.tray/signin?next=`)

- **Where:** `apps/worker/src/serve.ts:97-104` (`safeNext`).
- **Problem:** the guard rejects `//x` and `\`, then resolves `next` against a
  dummy origin and returns the normalised pathname. Dot segments normalise
  away, so `/.//evil.com`, `/..//evil.com`, `/a/..//evil.com` and
  `/%2e//evil.com` all come out as `//evil.com`, a protocol-relative URL.
- **Failure:** a phishing link
  `https://q3-review.acme.dev/.tray/signin?next=/.//evil.example/login` sends
  the visitor through a genuine Cloudflare Access email-code sign-in on the
  owner's domain, then `302 location: //evil.example/login`. The sign-in
  policy is "everyone", so anyone can trigger this. Verified against the app.
- **Fix:** check the normalised pathname as well: reject it if it starts with
  `//`. Tests cover each bypass.

### H2. The approve page can be framed (clickjacking → API key for the attacker)

- **Where:** `apps/worker/src/approve.ts`, `apps/worker/src/pages.ts:8`. No
  `x-frame-options` or `frame-ancestors`.
- **Problem:** the device-login approval page has one primary button that mints
  an owner-level API key. Every tray site lives on the same registrable domain
  as `tray.<domain>`, so a page on any site is *same-site* with the approve
  page and the owner's Access cookie is sent to it even under `SameSite=Lax`.
- **Failure:** an attacker runs `tray login acme.dev`, gets a user code, and
  gets an HTML artifact published on the tray (an agent-generated report, a
  "preview" sent for review) that frames
  `https://tray.acme.dev/approve?code=QXFT-7K2M` under a decoy "Continue"
  button. One click by the owner approves the login, and the attacker's
  polling CLI receives a key with full control of the tray.
- **Also:** the POST handler's Origin check accepts a missing Origin, and
  `new URL(origin)` throws on `Origin: null`, which turns into a 500.
- **Fix:** send `x-frame-options: DENY` and
  `content-security-policy: frame-ancestors 'none'` on every page the Worker
  renders (approve, messages, the Tray 404). Refuse POSTs whose Origin doesn't
  parse or doesn't match, or whose `sec-fetch-site` is anything other than
  `same-origin` or `none`.

### H3. Large first deploys fail: one R2 `head` per new blob

- **Where:** `apps/worker/src/routes/sites.ts:284-290`.
- **Problem:** `POST /sites/{site}/deploys` HEADs every blob the current deploy
  doesn't already reference. SPEC §5 notes that R2 calls count against the
  per-request limit (1,000 on Free). With the auth lookup, `loadSite` and the
  writes, a deploy with more than about 990 new unique files goes over the
  limit.
- **Failure:** the first `tray put` of a docs or Storybook build with 1,500
  files, which is well under 50 MB, gets `500 internal` on the Free plan. Retries
  fail the same way, because the blobs are still "new" relative to the
  current deploy.
- **Fix:** keep HEADs for small sets. For large sets, sweep the sorted hashes
  with `list({ prefix: "blobs/", startAfter })`: one call checks up to 1,000
  consecutive keys, so a deploy costs about (new blobs ÷ density) calls
  instead of one per blob. It still checks every blob, as the spec requires.
  **(live)**: confirm the per-request op accounting on a Free account.

## Medium

### M1. Wrong `content-type` on any JSON route returns `500 internal`

- **Where:** `apps/worker/src/app.ts:102-110`.
- **Problem:** `@hono/zod-openapi` throws `HTTPException(415)` when the body
  isn't `application/json`. `onError` only maps 400 HTTPExceptions, so a 415
  becomes `500 {"code":"internal","hint":"Check the Worker logs"}` and is
  logged as an error.
- **Failure:** `curl -X POST …/v1/keys -d '{"name":"ci"}'` (curl defaults to
  `application/x-www-form-urlencoded`) gets "internal error". An agent calling
  the API directly is told the Worker is broken.
- **Fix:** map every 4xx `HTTPException` to `400 invalid_request` with a
  message that names the problem. 415 isn't in the spec's status table.

### M2. CLI `--json` errors drop `param` (and `missing`) from API errors

- **Where:** `apps/cli/src/api.ts:25-36, 52`. `ApiFailure` calls
  `super(message, code, exit, hint)`, so `param` is never set.
  `apps/cli/src/format.ts:48` only prints the four core fields.
- **Failure:** `tray put … --json` that hits `400 invalid_request` prints
  `{"error":"files./x.type: …","code":"invalid_request"}` with no `param`,
  although SPEC §3 says CLI JSON errors have the API's shape. Agents that key
  off `param` can't.
- **Fix:** carry `param` through, and print the API body's extra fields
  (e.g. `missing`).

### M3. `tray login` gives up on one transient network error or 5xx

- **Where:** `apps/cli/src/commands/auth.ts:39-55`.
- **Failure:** while waiting up to 10 minutes for approval, a single dropped
  connection (laptop Wi-Fi, VPN reconnect) or Worker 5xx makes `pollForKey`
  rethrow. The login fails, and if the owner approves in the meantime the
  minted key is orphaned (see M4).
- **Fix:** keep polling through network errors and 5xx until the deadline.

### M4. Device approval mints the key early and stores it in plaintext

- **Where:** `apps/worker/src/auth.ts:191-206` (`decideDevice`),
  `apps/worker/src/routes/device.ts:103-106`.
- **Problem:** the API key is created when the owner approves and sits in
  plaintext in `auth/pending/<deviceCode>.json` until the CLI polls. If the
  CLI never polls (killed, timed out, M3), the record and its plaintext key
  stay in R2 forever, and the key is valid and listed in `tray key list`
  as if it were a real device.
- **Fix:** approval records `{status: "approved", email}`. `POST /auth/token`
  mints the key when it hands it out, deleting the pending record first so it
  stays single-use. Nothing secret is stored at rest, and nothing is orphaned.

### M5. Version drift breaks `tray upgrade` on the first release after 0.1.0

- **Where:** `apps/cli/src/version.ts:1` hardcodes `"0.1.0"`;
  `apps/worker/package.json` and `apps/site/src/lib/site.ts:7` carry their
  own copies. `.github/workflows/release.yml:27` only checks
  `apps/cli/package.json`, and the release workflow doesn't run tests.
- **Failure:** bump `apps/cli/package.json` to 0.2.0 and tag `v0.2.0`. The
  binary still reports 0.1.0, so every `tray upgrade` sees 0.1.0 < 0.2.0,
  re-downloads, swaps and re-execs. If the Worker's package.json isn't
  bumped, every CLI warns "the tray Worker … is v0.1.0, older than this CLI"
  and `tray upgrade` redeploys the Worker every time.
- **Fix:** read `VERSION` from `apps/cli/package.json` (Bun embeds it at
  compile time). Have the release job check the CLI, Worker and skill versions
  against the tag, and run the tests.

### M6. Docs and help say `tray domain add` uses `CLOUDFLARE_API_TOKEN`; it doesn't

- **Where:** `apps/cli/src/help.ts:8`, `apps/site/src/content/docs/cli.md`
  (Environment), `apps/site/src/content/docs/privacy.md`, SPEC §3 and §4.
- **Problem:** `tray domain add` only calls the Worker, which uses the
  `CF_API_TOKEN` secret that setup stored. The env var is read by `tray setup`
  and `tray upgrade`.
- **Failure:** a user rotates their token, exports the new one, runs
  `tray domain add`, and gets a 502 from the Worker's stale secret. Nothing
  they read explains why.
- **Fix:** correct the help text and docs ("`tray setup` and `tray upgrade`";
  re-run `tray setup` to rotate). The spec wording is listed under Spec
  questions.

### M7. `tray setup` takes over every subdomain of the zone

- **Where:** `apps/cli/src/commands/setup.ts:203` (route `*.<domain>/*`).
- **Problem:** a Workers route on `*.<domain>/*` runs in front of existing
  proxied records such as `www`, `blog` or `app`. After setup, those hostnames
  serve the Tray 404 instead of their origin. Nothing warns about this.
- **Fix (here):** setup lists proxied subdomain records and warns, naming
  them. The docs say to use a dedicated domain. See also Spec questions.
  **(live)**

## Low

- **L1. Mixed-case `DOMAIN` in `onError`.** `apps/worker/src/app.ts:117`
  compares `hostOf(c)` to `tray.${DOMAIN}` without lowercasing; line 90
  lowercases. Fix: lowercase both.
- **L2. Unknown-`kid` JWTs refetch Access certs on every request.**
  `apps/worker/src/access.ts:34-43`. Any visitor can send
  `CF_Authorization=<jwt with random kid>` on a private site or 404, and each
  request costs an outbound fetch to `<team>.cloudflareaccess.com`. Fix:
  refetch at most once a minute on a miss.
- **L3. Duplicated `olderThan`.** It is in both `apps/cli/src/api.ts:72` and
  `apps/cli/src/setup/release.ts:60`. Fix: keep one.
- **L4. Dead or misleading code.** `getSiteRecord` (`apps/cli/src/config.ts:59`)
  is never called. `TokenResponse` (`packages/schema/src/index.ts:267`) is an
  unused deprecated alias. The comment at `apps/cli/src/ctx.ts:142` says "exit
  3" (it's 4). `apps/site/src/lib/skill.ts` silently serves a stale built-in
  fallback skill if the real file moves; it should fail the build instead.
- **L5. `TRAY_VERSION=0.1.0` 404s.** `scripts/install.sh:20` needs the `v`;
  normalise it.
- **L6. Docs don't match the CLI.** The home page shows
  `tray put ./out --json` → `"site": "out"`, but `out` is a generic build
  folder name, so the site gets the parent folder's name. `cli.md`'s `tray list`
  sample has no URL column. The troubleshooting text for `zone_not_in_account`
  doesn't match the real message. `privacy.md` says the CLI talks to Cloudflare
  during `domain add` (it's the Worker), and doesn't mention that `tray upgrade`
  talks to GitHub.
- **L7. Naming consistency.** `thts.app` appears throughout CLI help,
  placeholders, comments, tests and `skills/tray/guide.md`. Tests send a
  `Tray-Version` header with capitals. Fix: `acme.dev` and `q3-review`
  everywhere outside SPEC.md (see Spec questions).
- **L8. Checksums come from the same release.** `install.sh` and
  `tray upgrade` verify against `SHA256SUMS` from the release that serves the
  binary. That catches corruption, not a compromised release or account, so
  "tampered with" in `apps/cli/src/setup/release.ts:114` overclaims. Build
  provenance is attested (`release.yml:51`) but nothing verifies it. Suggest
  documenting `gh attestation verify`. Left as is.
- **L9. No `Range` support in serving.** `apps/worker/src/serve.ts`. Safari
  won't play or seek `<video>` without range responses, so video in an
  artifact breaks there. Left: it's a feature.
- **L10. `POST /auth/device` is unauthenticated and writes two R2 objects per
  call.** Expired records are only removed when touched again, so a spammer
  can grow `auth/` without bound (and Class A op costs). The spec says no rate
  limits. Suggest an R2 lifecycle rule on `auth/` from `tray setup`. Left; see
  Spec questions.
- **L11. `tray list` costs two R2 reads per site.**
  `apps/worker/src/routes/sites.ts:170`. Past about 495 sites it goes over the
  Free per-request limit. Needs a site index object. Left: no launch-day user
  has that many sites.
- **L12. Re-running `tray login` keeps the old key.** `tray setup` revokes the
  key it replaces; `tray login` doesn't, so keys pile up in `tray key list`.
  Left: a behaviour change, worth a decision.
- **L13. `bun add -g @tray-sh/cli`.** The launcher is
  `#!/usr/bin/env node`, so this install path (on the home page) needs Node on
  PATH. Left; document or drop.
- **L14. The site's `openapi.json` names a live server.** It advertises
  `https://tray.tray.sh/v1` as a real tray. **(live)** Check that it exists
  before launch.
- **L15. Folder walks follow file symlinks.** `apps/cli/src/collect.ts:149`. A
  symlink inside the folder can publish a file from outside it (e.g.
  `config -> ~/.ssh/config`). Left; see Spec questions.

## Tests: gaps and brittleness

- Nothing exercised `install.sh`'s download path or `detect_target`: that's C1.
- `safeNext` tests covered absolute URLs, not dot segments: that's H1.
- No test for response headers on Worker-rendered pages (H2), for wrong
  content types (M1), for deploys over the R2 op budget (H3), or that the
  three version sources agree (M5).
- The R2 fake doesn't model per-request op limits. The new H3 test counts ops
  on the fake bucket instead.
- The tests are well isolated otherwise: no network, injected fetch, temp
  config dirs.

## Spec questions

1. **`thts.app` in SPEC.md.** The spec uses `thts.app` in sixteen places,
   mixed with `acme.dev`. Everything outside the spec now uses `acme.dev` and
   `q3-review`; the spec should follow.
2. **`Cf-Access-Jwt-Assertion` (SPEC §4 Auth)** breaks the spec's own
   lowercase-header rule. It should be `cf-access-jwt-assertion`.
3. **`CLOUDFLARE_API_TOKEN` for `tray domain add`** (§3 Environment, §4
   `tray domain`): the implemented design, the Worker using the token stored by
   setup, is better (no Cloudflare token on agent machines). Suggest: "Used by
   `tray setup` and `tray upgrade`. Custom domains use the token setup stored
   on the Worker; re-run setup to rotate it."
4. **`curl -fsSL tray.sh/install | sh` has no scheme**, so curl's first request
   is plain HTTP, and anyone on the path can swap the script before any
   redirect. The skill already says `https://tray.sh/install`. Suggest making
   the https form canonical everywhere.
5. **The `*.<domain>/*` route takes over the whole zone** (M7). Should the spec
   say "a dedicated domain" outright, or should setup refuse when other
   proxied subdomains exist unless `--yes`?
6. **Isolation between sites.** Every site, and the API, share one registrable
   domain. Any published artifact is same-site with `tray.<domain>` and with
   every private site: it can toss cookies for `.<domain>`, and it can
   `<script src>` or `<img src>` a private site's assets with the viewer's
   cookies. H2 shows the risk is concrete. Options: send
   `cross-origin-resource-policy: same-origin` on private-site responses;
   recommend putting `tray.<domain>` on a separate domain; or document that
   people should only publish content they trust.
7. **Abandoned device codes** (L10): allow an R2 lifecycle rule (delete
   `auth/` after 1 day) as part of setup?
8. **Symlinks in `tray put` folders** (L15): follow, skip, or follow only
   inside the root?
9. **Setup output** shows `Worker  tray`; the implementation names it
   `tray-<domain-slug>`, so one account can hold several trays. Update the
   example.
10. **`tray login` re-login** (L12): should it revoke the key it replaces, as
    setup does?
11. **`auth/pending/<deviceCode>.json` in the §2 storage layout** lists
    `key?`. After M4 the record holds the approver's `email?` and never a key.
    The layout line should change to match.

## Fixed

Each group ended with `bun run fmt`, `lint`, `typecheck`, `test` and `build`,
all green. Tests went from 238 to 254.

| Finding | Commit | What changed |
|---|---|---|
| C1 | `546656d` | `detect_target` restored. `TRAY_VERSION` works without the `v`. Tests run the whole script against a stub `curl` and a fake release: install, checksum mismatch, version URL, every helper defined. |
| H1 | `1b7e26d` | `safeNext` rejects a normalised path that starts with `//`. Unit and end-to-end tests for each bypass. |
| H2 | `ca04c47` | `x-frame-options: DENY` and `frame-ancestors 'none'` on the approve page, its message pages, the sign-in error page and the Tray 404 (same headers in every 404 case, so they stay identical). The approve POST refuses `Origin: null`, foreign origins and cross-site `sec-fetch-site`. |
| H3 | `9d175eb` | `missingBlobs()`: HEADs for up to 500 hashes, sorted `list` sweeps above that. Test: a 3,000-file deploy into a bucket of 4,000 unrelated blobs takes under 100 R2 calls and still finds the 2 missing blobs. |
| M1, L1 | `4654a35` | 4xx `HTTPException` → `400 invalid_request` (`param: "content-type"` for 415). `onError` lowercases `DOMAIN`. |
| M4 | `5c27880` | Approval stores `{status, email}`. `/auth/token` deletes the pending record, then mints the key. Test: an uncollected approval leaves no key and no `tray_k_` at rest. |
| L2 | `e74fe0a` | An unknown `kid` refreshes the certs at most once a minute. |
| M2 | `40008ea` | `ApiFailure` carries `param`; `--json` errors include the API body's extra fields (`missing`). An existing test asserted the opposite ("param only when the CLI sets it"). It was changed to follow SPEC §3: shout if that was intended. |
| M3 | `77ead08` | `pollForKey` keeps going through network errors and 5xx until the deadline. |
| M5 | `01af801` | `VERSION` comes from `apps/cli/package.json`; the site's version does too. `test/version.test.ts` checks that the Worker and skill versions match. The release job checks all three against the tag and runs `bun run test`. |
| M7 | `4961a17` | Setup warns, naming them, when `*.<domain>/*` takes over proxied subdomains. |
| L3, L4 | `f5d621d` | One `olderThan`; `getSiteRecord` and `TokenResponse` removed; the comment fixed. |
| L7 | `61f50ab` | `thts.app` → `acme.dev` everywhere except SPEC.md; `q3-review` in the skill guide's JSON; lowercase headers in the tests. |
| M6, L6 | `1cfc4e0` | Help, skill guide and site docs match the CLI's real behaviour (token use, `put` example, `list` columns, error text, privacy). The home page says to use a dedicated domain. |
| L4 (site) | `ec24fc0` | The site build fails if `skills/tray/SKILL.md` is missing, instead of serving a built-in stale skill. |
| L5 | `546656d` | (with C1) |

Note: `423732e` and `1fda794` (README banner, OG image) are from a parallel
session, not this review.

## Deliberately left

- **L8 (checksums from the same release).** The fix is documentation or
  `gh attestation verify` in the installer, which is a product decision.
- **L9 (Range requests).** It's a feature, not a launch bug.
- **L10 (unauthenticated device-start writes).** The spec says no rate limits.
  A lifecycle rule is Spec question 7.
- **L11 (`tray list` past ~495 sites).** It needs a site index in R2 (a storage
  layout change). Nobody hits it on launch day.
- **L12 (`tray login` doesn't revoke the old key).** It changes behaviour;
  Spec question 10.
- **L13 (`bun add -g` needs Node).** Docs or launcher decision.
- **L14 (`tray.tray.sh` in the site's OpenAPI document).** **(live)** Check it
  answers before launch, or drop `servers` back to the templated form.
- **L15 (symlinks in folders).** A behaviour change; Spec question 8.
- **Plain-http install one-liner (Spec question 4).** The spec defines the
  one-liner, so it's left for the spec owner.
- **CORP on private sites (Spec question 6).** It adds a response header to
  user content, which is a product call.

## Needs a live test

- H3: R2 per-request op accounting on a Free account, and `list` with
  `startAfter` + `prefix` on real R2.
- `PUT /blobs` digest-mismatch detection matches R2's error *message*
  (`/sha-?256|checksum|digest/`). Confirm the real wording still matches.
- M7: `GET /zones/{z}/dns_records?proxied=true` filtering.
- Release: npm trusted publishing needs npm ≥ 11.5.1. Check the version that
  ships with `node-version: 24` on the runner, or add `npm i -g npm@latest`.
- H2: confirm Access doesn't strip or override `x-frame-options` on
  `tray.<domain>/approve` (Access sits in front of it).

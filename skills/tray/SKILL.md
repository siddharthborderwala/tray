---
name: tray
description: >-
  Publish a folder, build output, file (HTML, PDF, image) or several files to a URL with the `tray`
  CLI (self-hosted on the user's own Cloudflare domain). Use this whenever the
  user wants something viewable by someone else, such as "share this", "send
  me a link", "host this", "put this online", "publish the report", "make it
  viewable", "deploy this preview", or "give me a URL for this". Also use it
  when you've built an HTML report, dashboard, prototype or static site and a
  link would help. Use this even if the user doesn't mention tray.
license: MIT
compatibility: Needs the `tray` CLI on PATH and network access to tray.<domain> (the user's tray API host).
allowed-tools: Bash(tray:*)
metadata:
  version: 0.2.0-beta.4
  author: Siddharth Borderwala
---

# Tray: put it on a URL

`tray put <path>` uploads a folder, `.zip`, `.tar.gz`, `.html` file, any
single file (a PDF, an image) or several files, and returns its URL on the
user's own domain. Deploys are immutable (`tray rollback` always works).

## 1. Set up

Run `tray whoami`. Exit 0: go to step 2.

- `command not found`: run `curl -fsSL https://tray.sh/install | sh` (it
  installs to `~/.tray/bin/tray`), then `tray skill install`.
- Exit 4 (not logged in): ask for the domain of the user's tray. If they have
  one, log in. If not, set one up.

**Log in:** run `tray login <domain> --json` in the background, or with a
10-minute timeout. Its first stderr line is
`{"pending":{"approveUrl","userCode"}}`. Send the user the `approveUrl`. The
command exits 0 once they approve it.

**Set up** a new tray (the user runs this one): ask for their email
(`git config user.email` is a good guess), then give them this command to run
in their own terminal:

```sh
tray setup --domain <domain> --email <email>
```

It creates the Worker, bucket, DNS and sign-in on their Cloudflare account,
asks them for a Cloudflare token, and logs this machine in (about a minute).
When they say it's done, run `tray whoami` again.

## 2. Publish

```sh
tray put ./dist -s q3-revenue-report   # prints the URL
```

- Always pass `-s` with a specific kebab-case name for this content. The
  default comes from the folder name, and folders like `dist` or `build`
  collide across projects and worktrees.
- Sites are public. Add `--private` only when the user asks; then only the
  owner and people they share with can open it.
- Add `--spa` for client-routed apps (React Router, Vue Router), so deep
  links serve `index.html` instead of 404.
- Pass only the build output, or the file or files to share.

## 3. Reply

Give the user the URL, and say it's private if you passed `--private`. One
line is enough.

## When it fails

Errors go to stderr, ending with the command that fixes it. Run it, unless it
adds `--yes`: that confirms a deletion or access change, so ask the user first.

- "already exists": pick a new `-s`; `--replace` only if the user asked to.
- Exit 4: not logged in or the key was revoked. Log in again (step 1). But
  "The keychain didn't answer": ask the user to approve or unlock the prompt.
- Network or DNS errors (`Couldn't reach tray.…`) inside a sandbox: the
  sandbox is blocking the network. Tell the user the fix for their agent:
  - Codex: in `~/.codex/config.toml`, set `[sandbox_workspace_write]`
    `network_access = true`.
  - Cursor: add the tray domain to `networkPolicy.allow` in `.cursor/sandbox.json`.
  - Claude Code: run `/sandbox` and add `tray.<domain>` to `allowedDomains`.
  - claude.ai: allow network access to the domain in capability settings.

## Don't

- Don't run `tray remove`, `tray key …` or `tray edit --visibility public`
  unless the user asks. These delete things, mint credentials or expose
  content.
- Never run `tray setup` yourself, and never ask for or read the Cloudflare
  token. Only the user handles it, in their own terminal.
- Never run `tray approve`: only the user approves devices, in their browser.
- Never publish `.env` files, secrets or a whole repo root. A tray URL is
  meant to be shared, so treat everything you put as public to its viewers.
- Don't curl the URL to verify it. Private sites sit behind a login, and the
  CLI only prints the URL after the deploy is live.

For the full guide (every command, flag and exit code), run
`tray skill`. Docs: https://tray.sh/llms.txt

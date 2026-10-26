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
  version: 0.1.0
  author: Siddharth Borderwala
---

# Tray: put it on a URL

`tray put <path>` uploads a folder, `.zip`, `.tar.gz`, `.html` file, any
single file (a PDF, an image) or several files, and prints a URL on the user's
own domain. Deploys are immutable, so nothing is
lost (`tray rollback` always works).

## Setting up Tray

If the user asks you to set them up: install the CLI if `tray` is missing
(`curl -fsSL https://tray.sh/install | sh`), run `tray skill install`, then
`tray whoami`. If that fails, ask them to run one of these in their own
terminal (in Claude Code: `! <command>`), since both need them in a browser:
`tray setup` for a new tray (asks for a Cloudflare domain, an API token via a
pre-filled link, and their email; about a minute), or `tray login <domain>`.

## 1. Check state

```sh
tray whoami   # your domain and email
```

- Exit 0: you're good, so go to step 2.
- Exit 4 means you're not logged in. Ask the user to run `tray login <domain>`
  themselves, or to set `TRAY_API_KEY` and `TRAY_DOMAIN`. Don't run
  `tray login` yourself: it opens a browser approval meant for a human.

## 2. Publish

```sh
tray put ./dist -s q3-revenue-report   # prints the URL
```

- Always pass `-s` with a specific kebab-case name for this content. The
  default comes from the folder name, and folders like `dist` or `build`
  collide across projects and worktrees.
- Add `--private` for anything internal, personal or sensitive. Only the
  owner (and people they share with) can open it.
- Add `--spa` for client-routed apps (React Router, Vue Router), so deep
  links serve `index.html` instead of 404.
- Pass only the build output, or the file or files to share.

## 3. Reply

Give the user the URL, and say it's private if you passed `--private`. One
line is enough.

## When it fails

Errors print `error: <message>` and a hint on the next line. Follow the hint.

- "already exists (last put from …)": that name belongs to another folder. Pick a new `-s`.
  Use `--replace` only if the user asked to overwrite it; the old deploy stays
  available to `tray rollback`.
- Exit 4: not logged in or the key was revoked (see step 1).
- `command not found: tray`: ask the user to install it with
  `curl -fsSL https://tray.sh/install | sh`.
- Network or DNS errors (`could not reach tray.…`) inside a sandbox: the
  sandbox is blocking the network. Tell the user the fix for their agent:
  - Codex: in `~/.codex/config.toml`, set `[sandbox_workspace_write]`
    `network_access = true`.
  - Cursor: add the tray domain to `networkPolicy.allow` in `.cursor/sandbox.json`.
  - Claude Code: run `/sandbox` and add `tray.<domain>` to `allowedDomains`.
  - claude.ai: allow network access to the domain in capability settings.

## Don't

- Don't run `tray setup`, `tray remove`, `tray key …` or
  `tray edit --visibility public` unless the user asks. These change the
  user's account or expose content.
- Never publish `.env` files, secrets or a whole repo root. A tray URL is
  meant to be shared, so treat everything you put as public to its viewers.
- Don't curl the URL to verify it. Private sites sit behind a login, and the
  CLI only prints the URL after the deploy is live.

For the full guide (every command, flag and exit code), run
`tray skill`. Docs: https://tray.sh/llms.txt

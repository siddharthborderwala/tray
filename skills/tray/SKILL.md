---
name: tray
description: >-
  Publish a folder, build output, zip, or HTML file to a URL with the `tray`
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

## 1. Check state

```sh
tray whoami --json   # {"domain","email","key","source"}
```

- Exit 0: you're good, so go to step 2.
- Exit 4 means you're not logged in. Ask the user to run `tray login <domain>`
  themselves, or to set `TRAY_API_KEY` and `TRAY_DOMAIN`. Don't run
  `tray login` yourself: it opens a browser approval meant for a human.

## 2. Publish

```sh
tray put ./dist -s q3-revenue-report --json
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

Give the user the `url` from the JSON, and say whether it's public or private
(`visibility`). One line is enough.

## When it fails

Errors are JSON on stdout: `{"error","code","hint"}`. Follow the `hint`.

- `site_exists`: that name was last put from somewhere else. Pick a new `-s`.
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

For the full guide (every command, flag, JSON shape and exit code), run
`tray skill`. Docs: https://tray.sh/llms.txt

---
title: Artifacts for every agent.
description: Build and share what your agents make, in any harness. Self-hosted on your own Cloudflare account.
---

Build and share what your agents make, in any harness.

```agents
claudecode Claude Code
codex Codex
geminicli Gemini CLI
opencode OpenCode
cursor Cursor
vscode VS Code
githubcopilot GitHub Copilot
windsurf Windsurf
zed Zed
jetbrains JetBrains
amp Amp
cline Cline
goose Goose
hermesagent Hermes
warp Warp
```

## Set up

Paste this into your agent:

```prompt
Read https://tray.sh/skill.md and set me up with Tray
```

It installs Tray and gives you one command to set it up on your own Cloudflare account. You need a domain on Cloudflare and about a minute. The free plan is enough.

Rather install it yourself?

```sh tabs="curl,bun,npm"
$ curl -fsSL https://tray.sh/install | sh
$ bun add -g @tray-sh/cli
$ npm i -g @tray-sh/cli
```

## Share

Reports, dashboards, prototypes, slides, PDFs. Ask your agent to share it and it's live on your domain.

```prompt
> Share this report on Tray
https://q3-review.acme.dev

> Put these charts on Tray as figures
https://figures.acme.dev

> Share the PDF I just made
https://board-deck.acme.dev
```

## Private artifacts

Make it private and choose who can open it: by email, or everyone at your company. They sign in with a code sent to their inbox. To anyone else, there's nothing there.

```prompt
> Make it private and share it with bob@acme.com and everyone at acme.com
Private · you, bob@acme.com, @acme.com
```

## Update

Ask for changes and it updates in place. The address stays the same, and every version is kept, so you can always go back.

```prompt
> Make the chart bigger and update it on Tray
https://q3-review.acme.dev · updated

> Go back to yesterday's version
https://q3-review.acme.dev · rolled back
```

## Any agent

Claude has Artifacts, but they work only in Claude.ai, Claude Desktop, Claude Mobile and Claude Code. Tray works in every agent and editor above, and anything else that can run a command. Switch agents and your work stays where it is.

## Self-hosted

Everything lives on your own Cloudflare account: the files, the links on your domain, and who can open them. There's no Tray account to sign up for, and no Tray servers in between. It's open source under MIT.

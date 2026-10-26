---
title: Agents
description: Set up Tray in Claude Code, Codex, Cursor, Gemini CLI, OpenCode or any agent that can run a command.
---

Claude has Artifacts and ChatGPT has sites, but each works only inside its own app. Tray works with any agent that can run a command, and every link it makes is on your own domain.

## Set up

Tell your agent:

```prompt
Read https://tray.sh/skill.md and set me up with Tray
```

It installs the CLI and the Tray skill, then asks you to run one command yourself: `tray setup` for a new tray, or `tray login` for one you already have. Both need you to click in a browser.

## skill.md

The skill is one Markdown file, [tray.sh/skill.md](/skill.md). It tells your agent when to reach for Tray, how to name and publish a site, when to make it private, and how to recover from errors.

## Sandboxes

Some agents run commands in a sandbox that blocks the network. Allow your tray's API host, `tray.<your-domain>`:

- **Claude Code:** run `/sandbox` and add it to `allowedDomains`.
- **Codex:** in `~/.codex/config.toml`, set `network_access = true` under `[sandbox_workspace_write]`.
- **Cursor:** add it to `networkPolicy.allow` in `.cursor/sandbox.json`.

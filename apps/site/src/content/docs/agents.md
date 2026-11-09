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

It installs the CLI and the Tray skill. For a new tray, it gives you one command to run yourself, `tray setup`. For a tray you already have, it logs in and sends you a link to approve.

On macOS, the first command an agent runs after you install or upgrade tray can stop at a keychain prompt it can’t click. Run `tray whoami` once in a terminal and click Always Allow: see [Troubleshooting](/troubleshooting#tray-cant-read-my-saved-key-after-an-install-or-upgrade).

## skill.md

The skill is one Markdown file, [tray.sh/skill.md](/skill.md). It tells your agent when to reach for Tray, how to name and publish a site, when to make it private, and how to recover from errors.

## Sandboxes

Some agents run commands in a sandbox that blocks the network. Allow your tray's API host, `tray.<your-domain>`:

- **Claude Code:** run `/sandbox` and add it to `allowedDomains`.
- **Codex:** in `~/.codex/config.toml`, set `network_access = true` under `[sandbox_workspace_write]`.
- **Cursor:** add it to `networkPolicy.allow` in `.cursor/sandbox.json`.

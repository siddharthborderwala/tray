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

## What your agent does

It runs the same CLI you do, picks a name for the site and prints one line: the link.

```sh
$ tray put ./dist -s q3-review
https://q3-review.acme.dev
```

The skill tells it to keep anything internal or personal private with `--private`, and never to put secrets or a whole repo. You can also ask it for a private link. Every command and flag is on the [CLI](/cli) page.

## skill.md

The skill is one Markdown file, [tray.sh/skill.md](/skill.md). It tells your agent when to reach for Tray, how to name and publish a site, when to make it private, and how to recover from errors.

## Where the skill lives

The skill tells your agent when to put something on a tray and how. Agents look for it in two places:

- **Claude Code** reads `~/.claude/skills`.
- **Codex, Cursor, Gemini CLI, OpenCode, Amp** and other agents that support skills read `~/.agents/skills`.

`tray skill install` writes to both. For one project only, run `tray skill install --project` in its folder and commit the skill with your code.

## Sandboxes

Some agents run commands in a sandbox that blocks the network. Allow your tray's API host, `tray.<your-domain>`:

- **Claude Code:** run `/sandbox` and add it to `allowedDomains`.
- **Codex:** in `~/.codex/config.toml`, set `network_access = true` under `[sandbox_workspace_write]`.
- **Cursor:** add it to `networkPolicy.allow` in `.cursor/sandbox.json`.

---
title: Artifacts for every agent.
description: Tray turns a folder, a file or a few files into a link you can share. Self-hosted on your Cloudflare account.
---

Tray turns a folder, a file or a few files into a link you can share. Put it on a tray, pass it around. For you, your agents and your friends.

It runs on your own Cloudflare account, so your sites and data stay yours.

## Install

Tell your agent:

```prompt
Read https://tray.sh/skill.md and set me up with Tray
```

It installs Tray and walks you through setup. Or install it yourself:

```sh tabs="curl,bun,npm"
$ curl -fsSL https://tray.sh/install | sh
$ bun add -g @tray-sh/cli
$ npm i -g @tray-sh/cli
```

## Set up

Tray runs on your own Cloudflare account. A Worker serves your sites, R2 stores the files, with private sharing through Cloudflare Access.

```sh
$ tray setup
```

Setup takes 60 seconds and asks for three things:

- **A domain on Cloudflare.** Use one just for Tray. Every site gets its own subdomain, like q3-review.acme.dev.
- **A Cloudflare API token.** Setup opens a link that fills in everything Tray needs. You only click Create.
- **Your email.** You own every site, and you sign in with it to see private ones.

The free plan on Cloudflare is enough.

## Put it on a tray

A folder, a zip, one HTML file, a PDF, a few images. Whatever it is, you get a link.

```sh
$ tray put ./q3-review
https://q3-review.acme.dev

$ tray put report.pdf
https://report.acme.dev

$ tray put chart.png diagram.png -s figures
https://figures.acme.dev
```

Change it and put it again. The link stays the same.

## Keep it private

Sites are public by default. Add `--private` and only you can see it.

```sh
$ tray put ./q3-review --private
```

## Share it

Share a private site with whoever you want, by email or a whole domain. They sign in with a code sent to their email.

```sh
$ tray share q3-review bob@acme.com @acme.com
```

[Every command and flag →](/cli)

## For agents

Tray works with Claude Code, Codex, Cursor, Gemini CLI, OpenCode and any agent that can run a command. Your agent puts things on a tray and replies with the link.

[Set up your agent →](/agents)

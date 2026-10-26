---
title: Artifacts for every agent.
description: Tray turns a folder or an HTML file into a link you can share. Self-hosted on your Cloudflare account.
---

Tray turns a folder or an HTML file into a link you can share. Put it on a tray, pass it around. For you, your agents and your friends.

## Install

```sh tabs="curl,bun,npm"
$ curl -fsSL tray.sh/install | sh
$ bun add -g @tray-sh/cli
$ npm i -g @tray-sh/cli
```

## What it does

Put something on a tray and you get a link. Send it to anyone. Change it and the link stays the same.

```sh
# Put a folder, a zip or one HTML file
$ tray put ./q3-review
https://q3-review.acme.dev

# Only let certain people see it
$ tray put ./q3-review --private
$ tray share q3-review bob@acme.com @acme.com

# Use your own domain
$ tray domain add docs.acme.com -s q3-review

# Changed your mind? Go back a version
$ tray rollback q3-review
```

[Every command and flag →](/cli)

## For agents

Agents use the same CLI. Point yours at [tray.sh/skill.md](/skill.md) and it knows when to put something on a tray. It prints one line: the link.

```sh
$ tray put ./dist -s q3-review --json
{
  "site": "q3-review",
  "url": "https://q3-review.acme.dev",
  "visibility": "public",
  "deploy": "lq3m9-2c7e",
  "files": 12,
  "uploaded": 12,
  "bytes": 482133
}
```

## Your Cloudflare

Tray runs on your own Cloudflare account. One Worker, one R2 bucket, your domain. Set it up once. Use a domain just for Tray: every subdomain of it becomes a site.

```sh
$ tray setup --domain acme.dev
```

---
title: Artifacts for every agent.
description: Tray turns a folder, a file or a few files into a link you can share. Self-hosted on your Cloudflare account.
---

Tray turns a folder, a file or a few files into a link you can share. Put it on a tray, pass it around. For you, your agents and your friends.

It runs on your own Cloudflare account, so your sites and data stay yours.

## Install

```sh tabs="curl,bun,npm"
$ curl -fsSL https://tray.sh/install | sh
$ bun add -g @tray-sh/cli
$ npm i -g @tray-sh/cli
```

## Set up

Tray runs on your own Cloudflare account. A Worker serves your sites, R2 stores the files and Cloudflare Access signs people in to private ones.

```sh
$ tray setup
```

Setup asks for three things:

- **A domain on Cloudflare.** Use one just for Tray. Every site gets its own subdomain, like q3-review.acme.dev.
- **A Cloudflare API token.** Setup opens a link that fills in everything Tray needs. You only click Create.
- **Your email.** You own every site, and you sign in with it to see private ones.

If Zero Trust isn't on yet, setup walks you through turning it on. The free plan is enough. It takes about 60 seconds in all.

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

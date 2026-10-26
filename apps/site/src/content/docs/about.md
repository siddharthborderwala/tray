---
title: About
description: What Tray is, who makes it, and where the code lives.
---

## What Tray is

Tray turns a folder, a zip or a single HTML file into a link. You put something on a tray, and you get a URL you can send to anyone. Put it again and the link stays the same. Every version is kept, so you can always go back.

It is built for people and for agents. The same CLI that prints a friendly summary in your terminal prints one clean line, or one JSON object, when an agent runs it. Agents never get stuck on a prompt.

## Self-hosted on Cloudflare

There is no Tray service. Each tray runs on your own Cloudflare account: one Worker, one R2 bucket and your domain. `tray setup` creates them for you. Your sites, files and visitors stay on your account, and you can remove all of it at any time.

## Open source

Tray is open source under the MIT license. The CLI, the Worker and this website live in one repository: [siddharthborderwala/tray on GitHub](https://github.com/siddharthborderwala/tray). Issues and pull requests are welcome.

## Who makes it

Tray is made by Sid. You can find him on X as [@sidborderwala](https://x.com/sidborderwala).

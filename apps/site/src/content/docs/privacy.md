---
title: Privacy
description: What tray.sh and the Tray CLI collect. In short, nothing.
---

## This website

tray.sh sets no cookies. It has no analytics, no tracking pixels and no third-party scripts. The pages, fonts and images are served from the same domain.

Like any website, the servers that host it may keep standard request logs for a short time, such as the IP address and the page requested. We don't use them to track you.

## Your tray

Each tray is self-hosted on your own Cloudflare account. Your sites, your files and the people who visit them live there, under your account and your control. Tray's makers never see any of it, and there is no Tray service in between.

Sign-in for private sites is handled by Cloudflare Access on your account. Tray doesn't store passwords.

## The CLI

The `tray` CLI sends no telemetry. It only talks to your own tray and, during `tray setup` and `tray domain add`, to the Cloudflare API with your token.

The install script at tray.sh/install downloads the CLI from the project's GitHub releases and checks its SHA-256 checksum.

## Questions

Ask on [GitHub](https://github.com/siddharthborderwala/tray/issues), or see [Contact](/contact).

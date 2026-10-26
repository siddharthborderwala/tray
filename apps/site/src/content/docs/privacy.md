---
title: Privacy
description: What tray.sh and the Tray CLI collect. In short, almost nothing.
---

## This website

tray.sh sets no cookies and has no tracking pixels or ad scripts. We count page views with Cloudflare Web Analytics, which doesn't use cookies or fingerprinting and doesn't track you across sites. The pages, fonts and images are served from the same domain.

Like any website, the servers that host it may keep standard request logs for a short time, such as the IP address and the page requested. We don't use them to track you.

## Your tray

Each tray is self-hosted on your own Cloudflare account. Your sites, your files and the people who visit them live there, under your account and your control. Tray's makers never see any of it, and there is no Tray service in between.

Sign-in for private sites is handled by Cloudflare Access on your account. Tray doesn't store passwords.

If Cloudflare Web Analytics is on for your domain, Cloudflare adds its script to your sites too. That data goes to your Cloudflare account, not to us. See [Troubleshooting](/troubleshooting#a-script-you-didnt-add) to turn it off.

## The CLI

The `tray` CLI sends no telemetry. It only talks to your own tray, to the Cloudflare API with your token during `tray setup` and `tray upgrade`, and to GitHub when `tray upgrade` looks for a new release.

The install script at https://tray.sh/install downloads the CLI from the project's GitHub releases and checks its SHA-256 checksum.

## Questions

Ask on [GitHub](https://github.com/siddharthborderwala/tray/issues), or see [Contact](/contact).

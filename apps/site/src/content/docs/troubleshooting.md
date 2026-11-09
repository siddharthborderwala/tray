---
title: Troubleshooting
description: Fixes for the errors you’re most likely to see.
toc: false
---

Every error says what went wrong and ends with the command that fixes it. With `--json`, the same comes as one JSON line on stderr: branch on its `code`.

## Logging in

### tray says I’m not logged in on this machine

`Error: Not logged in to acme.dev.`

Log in once on this machine. For agents and CI, an API key works too.

```sh
$ tray login acme.dev
$ export TRAY_API_KEY=tray_k_…
```

If you just installed or upgraded tray, read the next one first: your key may be saved but waiting on a keychain prompt.

### tray can’t read my saved key after an install or upgrade

`Error: The keychain didn't answer in time.`

Tray keeps your key, and the Cloudflare token setup saved, in the OS keychain. After you install or upgrade tray, macOS asks once whether the new version can read them. An agent can’t click that prompt, so the command gives up after a few seconds instead of hanging. Run this in a terminal and click **Always Allow**:

```sh
$ tray whoami
```

`tray upgrade` and `tray setup` say the same about the Cloudflare token. On Linux, your keyring is probably locked: unlock it and try again. Clicked **Deny** by mistake? macOS then reports the key as missing, so tray says you’re not logged in. Run `tray whoami` in a terminal and allow it.

## Publishing

### A command stopped with “didn’t answer in time”

`Error: tray.acme.dev didn't answer in time.`

Tray waits 60 seconds for each request, longer for big uploads, instead of hanging forever. The change may have landed anyway, so check, then run the same command again. Putting the same files twice creates nothing new.

```sh
$ tray list
$ tray deploys q3-review
```

### tray put says the site already exists

`Error: q3-review already exists (last put from /Users/bob/work/q3 on bob-mbp).`

Someone put a site with this name from another folder or machine. Replace it, or pick another name. Old versions are kept, so you can roll back.

```sh
$ tray put ./q3-review --replace
$ tray put ./q3-review --site q3-review-v2
```

### tray put says the deploy is too large

`Error: Deploy is 128 MB, over the 100 MB limit.`

The error lists the biggest files under it. Remove what you don’t need, like videos or source maps, and put it again.

### tray put skipped a file I linked to

`warning: Skipped config.txt: links to files outside the folder aren't published.`

A link (symlink) in a folder is published only when it points at another file in that folder. One that points outside, like `config.txt -> ~/.env`, is left out, so nothing private leaks by accident. Want that file on the site? Copy it into the folder.

## Private sites

### I can’t share a site because it’s public

`Error: q3-review is public.`

Only private sites can be shared. Make it private first, then share it.

```sh
$ tray edit q3-review --visibility private
$ tray share q3-review bob@acme.com
```

### Someone sees “Nothing here” on a private site

Private sites look like they don’t exist until you sign in. Ask them to click **Sign in to view** and use the email you shared with. Signed in and still nothing? They aren’t on the share list yet.

```sh
$ tray share q3-review
$ tray share q3-review bob@acme.com
```

### Someone never got a sign-in code

Cloudflare emails a code only to people a site is shared with, by email or by `@domain`. Everyone else sees the same “check your email” page, but no email is sent, so strangers can’t tell whether a site exists. Share with their exact address, or their whole domain, and ask them to try again. Also check spam.

## Custom domains

### tray domain add says the domain isn’t on this account

`Error: docs.acme.com isn't on this Cloudflare account.`

Custom domains must be on the same Cloudflare account as your tray. Add the domain to that account, then try again.

### tray domain add says a Worker route catches the host

`Error: docs.acme.dev is caught by the Worker route *.acme.dev/* (tray-acme-dev).`

Every tray serves `*.<its domain>`, so a hostname under another tray’s domain would never reach this one. Pick a hostname outside it, like `docs.acme.com`.

## Setup and upgrades

### Setup says Zero Trust isn’t enabled

`Error: Cloudflare Zero Trust isn't enabled on this account.`

Tray uses Zero Trust for sign-in. Open [one.dash.cloudflare.com](https://one.dash.cloudflare.com/), choose a team name and pick the Free plan. Cloudflare asks for payment details even on the Free plan, but doesn’t charge it. Then run `tray setup` again. In a terminal, setup waits for you instead.

### Setup says R2 isn’t enabled

`Error: R2 isn't enabled on this Cloudflare account.`

Enable R2 once with the link in the error (the free tier is enough), then run `tray setup` again.

### tray upgrade skipped one of my trays

`warning: acme.dev: Worker is 0.1.3; set CLOUDFLARE_API_TOKEN (or re-run tray setup) to redeploy it`

`tray upgrade` redeploys the Workers of trays this machine set up, with the token setup saved. This machine has none for `acme.dev`. Run `tray upgrade` on the machine that set it up, or set `CLOUDFLARE_API_TOKEN` and run it here.

## Agents and Cloudflare

### My agent can’t reach my tray

Some agents run commands in a sandbox that blocks the network. Allow `tray.<your-domain>`: see [Agents › Sandboxes](/agents#sandboxes).

### My site has a script I didn’t add

`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" …></script>`

That’s Cloudflare Web Analytics. When it’s on for your domain, Cloudflare adds this script to HTML pages, including your sites. It reports to your own Cloudflare account and sets no cookies. Tray doesn’t add it and doesn’t block it.

Don’t want it? In the Cloudflare dashboard, open Web Analytics, find your domain and turn off automatic setup. Want it on only some sites? Turn off automatic setup and add the snippet to those sites yourself.

---
title: Troubleshooting
description: Fixes for the errors you’re most likely to see.
---

Every error says what went wrong and ends with the command that fixes it. With `--json`, the same comes as one JSON line on stderr: branch on `code`.

## Not logged in

```text
Error: Not logged in to acme.dev.

Log in, or set TRAY_API_KEY:
    tray login acme.dev
```

Log in once on this machine, or give agents and CI an API key.

```sh
$ tray login acme.dev
$ export TRAY_API_KEY=tray_k_…
```

Just upgraded, or an agent ran it? See the next section first: the key may be saved but locked behind a keychain prompt.

## The keychain didn’t answer in time

```text
Error: The keychain didn't answer in time.

Your key for acme.dev may be saved, but macOS is probably asking whether tray can use it. Click Always Allow, then try again. No prompt? Run this in a terminal once:
    tray whoami --domain acme.dev
```

Tray keeps your key, and the Cloudflare token setup saved, in the OS keychain. After you install or upgrade tray, macOS asks once whether the new version can read them. An agent can’t click that prompt, so the CLI gives up after a few seconds instead of hanging. Run `tray whoami` in a terminal, click **Always Allow**, and the agent works again. `tray upgrade` and `tray setup` say the same about the Cloudflare token.

On Linux, the keyring is usually locked: unlock it and try again. Clicked **Deny** by mistake? macOS then reports the key as missing, and tray says you’re not logged in. Run `tray whoami` in a terminal and allow it, or open Keychain Access and give tray access to the `sh.tray.cli` items.

## A request didn’t answer in time

```text
Error: tray.acme.dev didn't answer in time.

It may have gone through anyway: check with tray list, then retry (repeating tray put is safe).
```

Tray waits 60 seconds for each request, longer for big uploads, instead of hanging forever. Check whether the change landed with `tray list` or `tray deploys <site>`, then run it again. Putting the same files twice creates nothing new.

## Zero Trust isn’t enabled

```text
Error: Cloudflare Zero Trust isn't enabled on this account.
```

Tray uses Zero Trust for sign-in. Open [one.dash.cloudflare.com](https://one.dash.cloudflare.com/), choose a team name and pick the Free plan. Cloudflare asks for payment details even on the Free plan, but doesn’t charge it. Then run `tray setup` again. In a terminal, setup waits for you instead.

## R2 isn’t enabled

```text
Error: R2 isn't enabled on this Cloudflare account.
```

Enable R2 once with the link in the error (the free tier is enough), then run `tray setup` again.

## Site already exists

```text
Error: q3-review already exists (last put from /Users/bob/work/q3 on bob-mbp).

Overwrite it, or pick another name:
    tray put ./q3-review --replace
    tray put ./q3-review --site <OTHER>
```

Someone put a site with this name from another folder or machine. Replace it, or pick another name. Old versions are kept, so you can roll back.

## Too large

```text
Error: Deploy is 128 MB, over the 100 MB limit.

Largest files:
   96 MB  /demo.mp4
```

Tray lists the biggest files. Remove what you don’t need, like videos or source maps, and put it again.

## A link was skipped

```text
warning: Skipped config.txt: links to files outside the folder aren't published.
```

Links (symlinks) inside a folder are published only when they point at another file in that folder. One that points outside, like `config.txt -> ~/.env`, is left out, so nothing private leaks by accident. Want that file on the site? Copy it into the folder.

## Site is public

```text
Error: q3-review is public.

Make it private first: tray edit q3-review --visibility private
```

Only private sites can be shared.

## Can’t open a private site

```text
Nothing here · Sign in to view
```

Private sites look like they don’t exist until you sign in. Ask them to click **Sign in to view** and use the email you shared with. Signed in and still nothing? They aren’t on the share list yet.

```sh
$ tray share q3-review
$ tray share q3-review bob@acme.com
```

## No sign-in code arrived

Cloudflare emails a sign-in code only to people a site is shared with, by email or by `@domain`. Everyone else sees the same “check your email” page, but no email is sent, so strangers can’t tell whether a site exists. If an email you expect never arrives, share with that exact address (or its domain) and try again. Also check spam.

## Domain isn’t on this account

```text
Error: docs.acme.com isn't on this Cloudflare account.
```

Custom domains must be on the same Cloudflare account as your tray. Add the domain to Cloudflare, then try again.

## A Worker route catches the domain

```text
Error: docs.acme.dev is caught by the Worker route *.acme.dev/* (tray-acme-dev).

Cloudflare sends it to that route, not to this tray. Pick a hostname the route doesn't match, or remove the route.
```

Every tray serves `*.<its domain>`, so a hostname under another tray’s domain would never reach this one. Pick a hostname outside it, like `docs.acme.com`.

## Upgrade skipped a tray

```text
warning: acme.dev: Worker is 0.1.3; set CLOUDFLARE_API_TOKEN (or re-run tray setup) to redeploy it
```

`tray upgrade` redeploys the Workers of trays this machine set up, using the token setup saved. This machine has no token for `acme.dev`. Run `tray upgrade` on the machine that set it up, or set `CLOUDFLARE_API_TOKEN` and run it here.

## An agent can’t reach your tray

Some agents run commands in a sandbox that blocks the network. Allow `tray.<your-domain>`: see [Agents › Sandboxes](/agents#sandboxes).

## A script you didn’t add

```html
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" …></script>
```

That’s Cloudflare Web Analytics. When it’s on for your domain, Cloudflare adds this script to HTML pages, including your sites. It reports to your own Cloudflare account and sets no cookies. Tray doesn’t add it and doesn’t block it.

Don’t want it? In the Cloudflare dashboard, open Web Analytics, find your domain and turn off automatic setup. Want it on only some sites? Turn off automatic setup and add the snippet to those sites yourself.

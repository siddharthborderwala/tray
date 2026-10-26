---
title: Troubleshooting
description: Fixes for the errors you’re most likely to see.
---

## Not logged in

```text
error: not logged in to acme.dev
```

Log in once on this machine, or set an API key.

```sh
$ tray login acme.dev
$ export TRAY_API_KEY=tray_k_…
```

## Site already exists

```text
error: q3-review already exists (last put from ~/work/x)
```

Someone put a site with this name from another folder. Replace it, or pick another name. Old versions are kept, so you can roll back.

```sh
$ tray put ./q3-review --replace
$ tray put ./q3-review -s q3-review-v2
```

## Too large

```text
error: deploy is 63 MB, over the 50 MB limit
```

tray lists the biggest files. Remove what you don’t need, like videos or source maps, and put it again.

## Site is public

```text
error: q3-review is public
```

Only private sites can be shared. Make it private first.

```sh
$ tray edit q3-review --visibility private
```

## Domain not found

```text
error: acme.com isn't on this Cloudflare account
```

Custom domains must be on the same Cloudflare account as your tray. Add the domain to Cloudflare, then try again.

## Can’t open a private site

```text
404 · Sign in to view
```

Private sites look like they don’t exist until you sign in. Ask them to click Sign in to view and use the email you shared with. Still 404? They aren’t on the share list yet.

```sh
$ tray share q3-review
$ tray share q3-review bob@acme.com
```

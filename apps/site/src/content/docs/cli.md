---
title: CLI
description: Every command, flag and exit code.
---

## put

### `tray put <path...>`

Publish a folder, `.zip`, `.tar.gz`, `.html` file, any other file (a PDF, an image…), several files, or `-` for HTML on stdin. Prints the URL.

One file opens straight from the link. Several files, or a folder without `index.html`, get a page that lists them. Several files have no default name, so pass `-s`.

| Flag                | Meaning                                         |
| ------------------- | ----------------------------------------------- |
| `-s, --site <name>` | Site name. Defaults to the folder or file name. |
| `--private`         | Only you can see it. Applies to new sites.      |
| `--spa`             | Unknown paths serve /index.html.                |
| `--replace`         | Overwrite a site put from somewhere else.       |

```sh
$ tray put ./q3-review --json
{
  "site": {
    "name": "q3-review",
    "url": "https://q3-review.acme.dev",
    "visibility": "public",
    "deploy": "lq3k2-8f1a"
  },
  "outcome": "created",
  "files": 42,
  "uploaded": 3,
  "bytes": 3145728
}
```

## list

### `tray list`

Your sites, with visibility, domains and when they changed. Piped, the table is tab-separated with ISO times.

```sh
$ tray list
SITE        URL                          VISIBILITY    DOMAINS         UPDATED
q3-review   https://q3-review.acme.dev   private (3)   —               2m ago
docs        https://docs.acme.dev        public        docs.acme.com   3d ago
```

## open

### `tray open <site>`

Opens the site in your browser and prints its URL. Without a terminal (or with `--no-open`), only prints the URL.

## edit

### `tray edit <site>`

Change a site’s visibility. Making a site public asks first.

| Flag               | Meaning                |
| ------------------ | ---------------------- |
| `--visibility <v>` | public or private.     |
| `-y, --yes`        | Skip the confirmation. |

## deploys

### `tray deploys <site>`

Every version of a site, newest first. The live one is marked `*`.

| Flag              | Meaning                                    |
| ----------------- | ------------------------------------------ |
| `--limit <n>`     | How many to show (default 20, up to 100).  |
| `--next <deploy>` | The next page, after this deploy.          |

## rollback

### `tray rollback <site> [deploy]`

Go back to an earlier version: `tray rollback q3-review mh7q2k1c-8f1a`. The deploy id comes from `tray deploys`. Without it, you pick from recent ones; in scripts and agents it's required. `--to <deploy>` does the same.

## remove

### `tray remove <site>`

Take a site down, with its deploys, domains and sharing. It shows what goes, then asks. This can't be undone.

| Flag        | Meaning                |
| ----------- | ---------------------- |
| `-y, --yes` | Skip the confirmation. |

## share

### `tray share <site> [who...]`

Who can see a private site. Add emails or @domain. With no one listed, prints who has access. Use `tray unshare` to remove people (it asks first, or pass `--yes`).

```sh
$ tray share q3-review bob@acme.com @acme.com
$ tray unshare q3-review bob@acme.com
```

## domain

### `tray domain`

Custom domains. The domain must be on the same Cloudflare account. Your tray uses the Cloudflare token `tray setup` saved; run setup again to change it.

| Command                | Meaning                   |
| ---------------------- | ------------------------- |
| `add <host> -s <site>` | Point a domain at a site. |
| `remove <host>`        | Remove it.                |
| `list [-s <site>]`     | List domains.             |

## login

### `tray login [domain]`

Log this machine in to a tray. Opens your browser, or prints a code to approve somewhere else.

| Command              | Meaning                                          |
| -------------------- | ------------------------------------------------ |
| `approve <code>`     | Approve a login, at a terminal on a machine that’s logged in. |
| `logout [domain]`    | Log out.                                         |
| `account list`       | Trays you’re logged in to.                       |
| `account switch <d>` | Change the default tray.                         |

## key

### `tray key`

API keys for agents and CI. Use one with `TRAY_API_KEY`.

| Command               | Meaning                           |
| --------------------- | --------------------------------- |
| `create [--name <n>]` | Print a new key. It’s shown once. |
| `list`                | Your keys.                        |
| `revoke <name>`       | Turn a key off (asks first).      |

## setup

### `tray setup`

Create or update your tray on Cloudflare. Safe to run again. `tray upgrade` (or `tray upgrade latest`) updates the CLI and your Workers to the latest stable release; `tray upgrade beta` the newest beta, and `tray upgrade 0.2.0-beta.1` that exact release. To install a beta from scratch: `curl -fsSL https://tray.sh/install | TRAY_VERSION=beta sh`.

Without `CLOUDFLARE_API_TOKEN`, setup prints a link that pre-fills a token with everything it needs, opens it, and asks you to paste the token. It saves the token in your OS keychain for re-runs and `tray upgrade`. If Cloudflare later rejects it (revoked or expired), setup asks for a new one. It also needs Cloudflare Zero Trust turned on (the Free plan is enough).

| Flag           | Meaning                            |
| -------------- | ---------------------------------- |
| `--domain <d>` | Domain on your Cloudflare account. |
| `--email <e>`  | Your email, for logging in.        |
| `--new-token`  | Ask for a new Cloudflare token instead of the saved one. |

## Global flags

| Flag                | Meaning                                           |
| ------------------- | ------------------------------------------------- |
| `--json`            | The result as one JSON object. Implies --non-interactive. |
| `--non-interactive` | Never prompt. Missing input is an error.          |
| `-y, --yes`         | Accept confirmations.                             |
| `--domain <d>`      | Use this tray instead of the default.             |
| `--no-color`        | No colors.                                        |
| `--no-open`         | Print URLs; never open a browser.                 |
| `--debug`           | Print each API call on stderr.                    |
| `-h, --help`        | Help for any command (or `tray help <command>`).  |
| `-v, --version`     | Print the version.                                |

## Environment

| Variable               | Meaning                                    |
| ---------------------- | ------------------------------------------ |
| `TRAY_DOMAIN`          | Tray to use.                               |
| `TRAY_API_KEY`         | API key. Overrides your login.             |
| `CLOUDFLARE_API_TOKEN` | Used by setup and upgrade.                 |
| `CI`                   | Set: never prompt.                         |
| `AGENT`, `AI_AGENT`    | Set: an agent is running. Never prompt.    |
| `TRAY_INTERACTIVE`     | 1: prompt anyway, even under an agent.     |
| `NO_COLOR`             | Set: no colors.                            |

## Exit codes

| Code  | Meaning                                          |
| ----- | ------------------------------------------------ |
| `0`   | Done.                                            |
| `1`   | Something failed: network, server or a conflict. |
| `2`   | Bad usage or missing input.                      |
| `4`   | Not logged in, or not allowed.                   |
| `130` | Canceled: Ctrl-C, or no at a prompt.             |

Errors go to stderr: what went wrong, then the command that fixes it. With `--json`, stdout stays empty and stderr gets one JSON line:

```json
{"error":"q3-review already exists","code":"site_exists","hint":"Overwrite it, or pick another name:","next":["tray put ./q3-review --replace","tray put ./q3-review --site <OTHER>"]}
```

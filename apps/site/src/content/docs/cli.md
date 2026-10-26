---
title: CLI
description: Every command, flag and exit code.
---

## put

### `tray put <path>`

Publish a folder, `.zip`, `.tar.gz`, `.html` file, or `-` for HTML on stdin. Prints the URL.

| Flag                | Meaning                                         |
| ------------------- | ----------------------------------------------- |
| `-s, --site <name>` | Site name. Defaults to the folder or file name. |
| `--private`         | Only you can see it. Applies to new sites.      |
| `--spa`             | Unknown paths serve /index.html.                |
| `--replace`         | Overwrite a site put from somewhere else.       |

```sh
$ tray put ./q3-review --json
{
  "site": "q3-review",
  "url": "https://q3-review.acme.dev",
  "visibility": "public",
  "deploy": "lq3k2-8f1a",
  "files": 42,
  "uploaded": 3,
  "bytes": 3145728
}
```

## list

### `tray list` (alias `ls`)

Your sites, with visibility, domains and when they changed.

```sh
$ tray list
SITE       VISIBILITY   DOMAINS        UPDATED
q3-review  private (3)  —              2m ago
docs       public       docs.acme.com  3d ago
```

## open

### `tray open <site>`

Opens the site in your browser. Without a terminal, prints the URL.

## edit

### `tray edit <site>`

Change a site’s visibility. Making a site public asks first.

| Flag               | Meaning                |
| ------------------ | ---------------------- |
| `--visibility <v>` | public or private.     |
| `-y, --yes`        | Skip the confirmation. |

## rollback

### `tray rollback <site>`

Go back to the previous version, or to a specific one.

| Flag            | Meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| `--to <deploy>` | Deploy id to go back to. Without it, you pick from recent ones. |

## remove

### `tray remove <site>` (alias `rm`)

Take a site down, with its domains and sharing. Asks first.

| Flag        | Meaning                |
| ----------- | ---------------------- |
| `-y, --yes` | Skip the confirmation. |

## share

### `tray share <site> [who...]`

Who can see a private site. Add emails or @domain. With no one listed, prints who has access. Use `tray unshare` to remove.

```sh
$ tray share q3-review bob@acme.com @acme.com
$ tray unshare q3-review bob@acme.com
```

## domain

### `tray domain`

Custom domains. The domain must be on the same Cloudflare account.

| Command                | Meaning                   |
| ---------------------- | ------------------------- |
| `add <host> -s <site>` | Point a domain at a site. |
| `remove <host>`        | Remove it. Alias rm.      |
| `list [-s <site>]`     | List domains. Alias ls.   |

## login

### `tray login [domain]`

Log this machine in to a tray. Opens your browser, or prints a code to approve somewhere else.

| Command              | Meaning                                          |
| -------------------- | ------------------------------------------------ |
| `approve <code>`     | Approve a login from a machine that’s logged in. |
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
| `revoke <name>`       | Turn a key off.                   |

## setup

### `tray setup`

Create or update your tray on Cloudflare. Safe to run again. `tray upgrade` updates the CLI.

| Flag           | Meaning                            |
| -------------- | ---------------------------------- |
| `--domain <d>` | Domain on your Cloudflare account. |
| `--email <e>`  | Your email, for logging in.        |

## Global flags

| Flag                | Meaning                                           |
| ------------------- | ------------------------------------------------- |
| `--json`            | Print one JSON object. Implies --non-interactive. |
| `--non-interactive` | Never prompt. Missing input is an error.          |
| `-y, --yes`         | Accept confirmations.                             |
| `--domain <d>`      | Use this tray instead of the default.             |
| `-h, --help`        | Help for any command.                             |
| `-v, --version`     | Print the version.                                |

## Environment

| Variable               | Meaning                                    |
| ---------------------- | ------------------------------------------ |
| `TRAY_DOMAIN`          | Tray to use.                               |
| `TRAY_API_KEY`         | API key. Overrides your login.             |
| `CLOUDFLARE_API_TOKEN` | Used by setup and domain add.              |
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
| `130` | Cancelled: Ctrl-C, or no at a prompt.            |

With `--json`, errors are JSON too:

```json
{
  "error": "q3-review already exists",
  "code": "site_exists",
  "hint": "use --replace or -s <other>"
}
```

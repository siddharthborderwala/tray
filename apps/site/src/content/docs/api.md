---
title: API
description: Your tray’s HTTP API, at https://tray.<domain>/v1. The CLI uses it. So can you.
note: GET /v1/openapi.json for the full schema.
---

## Authentication

Send an API key as a bearer token. Make one with `tray key create`.

```sh
$ curl https://tray.acme.dev/v1/sites \
    -H "authorization: Bearer $TRAY_API_KEY"
```

## Publishing

Uploads are content-addressed, so unchanged files are never sent twice. Publishing takes four steps.

| Step | Call                         | What                                             |
| ---- | ---------------------------- | ------------------------------------------------ |
| 1    | Hash                         | SHA-256 every file.                              |
| 2    | `POST /blobs/check`          | Send up to 512 hashes. Get back the missing ones. |
| 3    | `PUT /blobs/<hash>`          | Upload each missing file.                        |
| 4    | `POST /sites/<site>/deploys` | Send the file list. Get the URL.                 |

```json title="REQUEST · POST /sites/q3-review/deploys"
{
  "files": {
    "/index.html": {
      "hash": "9f86d081884c7d65…",
      "size": 5120,
      "type": "text/html;charset=utf-8"
    }
  },
  "spa": false,
  "source": {
    "path": "/Users/sid/work/q3-review",
    "machine": "mbp-3f9a"
  }
}
```

```json response title="RESPONSE · 201"
{
  "site": {
    "name": "q3-review",
    "url": "https://q3-review.acme.dev",
    "visibility": "public",
    "currentDeploy": "mh7q2k1c-8f1a",
    "domains": [],
    "shareCount": 1,
    "createdAt": "2026-10-26T09:12:03Z",
    "updatedAt": "2026-10-26T09:12:03Z"
  },
  "deploy": {
    "id": "mh7q2k1c-8f1a",
    "files": 1,
    "bytes": 5120,
    "spa": false,
    "createdAt": "2026-10-26T09:12:03Z",
    "createdBy": "sid@acme.com"
  }
}
```

## Endpoints

### Sites

| Method   | Path                      | What                                       |
| -------- | ------------------------- | ------------------------------------------ |
| `POST`   | `/blobs/check`            | Which hashes are missing. Up to 512.       |
| `PUT`    | `/blobs/<sha256>`         | Upload one file. Checked against its hash. |
| `POST`   | `/sites/<site>/deploys`   | Publish a site. Returns the URL.           |
| `GET`    | `/sites`                  | Your sites.                                |
| `GET`    | `/sites/<site>`           | One site.                                  |
| `PATCH`  | `/sites/<site>`           | Change visibility.                         |
| `DELETE` | `/sites/<site>`           | Remove a site.                             |
| `GET`    | `/sites/<site>/deploys`   | Recent versions.                           |
| `POST`   | `/sites/<site>/rollback`  | Go back a version.                         |

### Sharing, domains, keys

| Method | Path                   | What                                                       |
| ------ | ---------------------- | ---------------------------------------------------------- |
| `GET`  | `/sites/<site>/shares` | Who can see a private site. POST to add, DELETE to remove. |
| `GET`  | `/domains`             | Custom domains. POST to add, DELETE to remove.             |
| `GET`  | `/keys`                | API keys (`current` marks the one asking). POST to create. |
| `DELETE` | `/keys/<id>`         | Revoke a key.                                              |
| `DELETE` | `/keys/current`      | Revoke the key making the request (log out).               |

### Login

| Method | Path                       | What                                     |
| ------ | -------------------------- | ---------------------------------------- |
| `POST` | `/auth/device`             | Start a login. Returns a code. No key.   |
| `POST` | `/auth/token`              | Poll for the key once approved. No key.  |
| `GET`  | `/auth/device/<code>`      | Who is asking, before you approve.       |
| `POST` | `/auth/approve`            | Approve a code.                          |

## Errors

Errors return a status code and a JSON body.

```json response title="RESPONSE · 409"
{
  "error": "q3-review already exists (last put from /Users/bob/work/q3 on bob-mbp)",
  "code": "site_exists",
  "hint": "Pass replace: true (CLI: --replace) or use another site name.",
  "param": "site"
}
```

Branch on `code`, never on `error`: the wording can change.

| Status | Codes                                                                                 |
| ------ | ------------------------------------------------------------------------------------- |
| `400`  | `invalid_request` (`param` names the field), `digest_mismatch`; during login `authorization_pending`, `slow_down`, `expired_token`, `access_denied`. |
| `401`  | `unauthenticated`: missing or wrong key.                                              |
| `403`  | `forbidden`.                                                                          |
| `404`  | `site_not_found`, `deploy_not_found`, `domain_not_found`, `key_not_found`.            |
| `409`  | `site_exists`, `domain_taken`, `host_taken_by_route` (another Worker's route catches the host), `missing_blobs` (upload them, then deploy again), `site_public` (only private sites are shared). |
| `411`  | `length_required`: blob uploads need a Content-Length.                                |
| `413`  | `too_large`: a deploy is over 100 MB.                                                 |
| `422`  | `zone_not_in_account`: a custom domain's zone isn't on this Cloudflare account.       |
| `5xx`  | `internal`.                                                                           |

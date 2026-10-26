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
      "type": "text/html"
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
    "currentDeploy": "lq3k2-8f1a",
    "domains": [],
    "shareCount": 1,
    "createdAt": "2026-10-26T09:12:03Z",
    "updatedAt": "2026-10-26T09:12:03Z"
  },
  "deploy": {
    "id": "lq3k2-8f1a",
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
| `GET`  | `/keys`                | API keys. POST to create, DELETE to revoke.                |

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
  "error": "q3-review already exists",
  "code": "site_exists",
  "hint": "Pass replace: true, or use another name.",
  "param": "site"
}
```

| Status | Meaning                                    |
| ------ | ------------------------------------------ |
| `400`  | Bad input. `param` names the field.        |
| `401`  | Missing or wrong key.                      |
| `404`  | No such site, domain or key.               |
| `409`  | Name taken. Code site_exists.              |
| `413`  | Over 50 MB.                                |

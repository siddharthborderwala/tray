# tray

**Artifacts for every agent.**

Tray turns a folder or an HTML file into a link you can share. Put it on a tray, pass it around. For you, your agents and your friends.

It runs on your own Cloudflare account (one Worker, one R2 bucket), so your sites and data stay yours.

## Install

```sh
curl -fsSL tray.sh/install | sh
```

Or with npm: `npm i -g @tray-sh/cli`. Either way, the command is `tray`.

## Quick start

```sh
tray setup --domain acme.dev        # once: creates the Worker, bucket, DNS and TLS
tray put ./q3-review                # → https://q3-review.acme.dev
tray put ./q3-review --private      # only you can see it
tray share q3-review bob@acme.com   # …and Bob
```

Agents use the same CLI: `tray put ./out --json` prints the result as JSON and never prompts. Docs for agents live at [tray.sh/llms.txt](https://tray.sh/llms.txt).

Full docs: [tray.sh](https://tray.sh).

## Development

```sh
bun install
bun test          # all tests
bun run build     # worker → cli → site
bun run lint && bun run fmt:check
```

The repo is a Bun workspace:

| Path | What |
|---|---|
| `apps/cli` | The `tray` CLI (Bun, compiled to a single binary) |
| `apps/worker` | The Cloudflare Worker: API and site serving (Hono) |
| `apps/site` | tray.sh (Astro) |
| `packages/schema` | Shared zod schemas for the API |

See [SPEC.md](SPEC.md) for how it all works. Issues and PRs welcome.

## License

[MIT](LICENSE)

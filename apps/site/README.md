# tray.sh

The Tray website and docs: a standard Astro project on Cloudflare Workers, with the
[`@astrojs/cloudflare`](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)
adapter. Astro runs on Bun's runtime (`bun --bun astro …`), so Node isn't needed.

```sh
bun run dev       # astro dev
bun run build     # astro build → dist/client (assets) + dist/server (Worker)
bun run preview   # astro preview, in workerd
bun run deploy    # build, then wrangler deploy (wrangler.jsonc)
```

`bunx wrangler dev` after a build serves the production Worker locally on :8787.

## How it's served

- The docs pages (`/`, `/cli`, `/api`, `/troubleshooting`, `/about`, `/contact`, `/privacy`) and
  the 404 render on demand, so `src/middleware.ts` can answer `Accept: text/markdown` on the same
  URL (with `vary: accept`) and add the homepage `link` header.
- Everything else is prerendered to static assets: the Markdown twins (`/cli.md`, …),
  `/llms.txt`, `/llms-full.txt`, `/skill.md`, `/openapi.json`, `/og.png`, `/install`,
  `/sitemap.xml`, `/robots.txt` and `/.well-known/*`.
- `public/_headers` sets content types for the extensionless files.

## Font

The site is set in Berkeley Mono, which is licensed per person and is **not** in this repo
(`public/fonts/` is gitignored). Without it the site uses a metric-matched system monospace.

To use your own copy, subset it to woff2 (needs `brew install fonttools`):

```sh
bun run font                                   # reads ~/Library/Fonts/Berkeley Mono Variable.otf
bun run font /path/to/BerkeleyMonoVariable.otf # or any path
```

This writes `public/fonts/BerkeleyMonoVariable.woff2`. The build adds the `@font-face` and the
preload only when that file exists. For a deploy, put it there in CI before `bun run build`.

## Content

Pages are Markdown in `src/content/docs/`. The same files produce the HTML pages, the `.md`
twins and `/llms-full.txt`. `/llms.txt` is a short index (`src/pages/llms.txt.ts`).

- `/skill.md` serves `skills/tray/SKILL.md` from the repo root verbatim; its digest is in
  `/.well-known/agent-skills/index.json`.
- `/openapi.json` is `apps/worker/dist/openapi.json` (built by the Worker) with `servers`
  pointed at the demo tray.
- `/install` is `scripts/install.sh`.
- `/og.png` is rasterized from `src/assets/og.svg` (text as outlines, so no font is needed).

Conventions the renderer (`src/lib/docs-plugin.ts`) understands:

- `## Heading` starts a section (anchor, sidebar entry, scroll-spy).
- `` ### `tray list` (alias `ls`) `` is a command signature; a plain `### Label` is a small label.
- In code fences, `$ ` starts a command (shown with `›` and copied), `# ` is a comment, anything
  else is output. Fence meta: `tabs="curl,bun,npm"`, `title="…"`, `response` (blue JSON).
- A table's first column becomes row headers. A first header of `Method` or `Step` gets the
  endpoint or step layout.

Site-wide links (GitHub, the footer's author link, version) are in `src/lib/site.ts`.

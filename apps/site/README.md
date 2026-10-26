# tray.sh

The Tray website and docs, built with Astro. Run everything from this folder (or with
`bun run --filter @tray-sh/site <script>` from the repo root). Astro runs on Bun's runtime
(`bun --bun astro …`), so Node isn't needed.

```sh
bun run dev       # http://localhost:4321
bun run build     # → dist/ (also copies scripts/install.sh to /install)
bun run preview
```

## Font

The site is set in Berkeley Mono, which is licensed per person and is **not** in this repo
(`public/fonts/` is gitignored). Without it the site falls back to the system monospace font.

To use your own copy, convert it to woff2 (needs `brew install woff2`):

```sh
bun run font                                   # reads ~/Library/Fonts/Berkeley Mono Variable.otf
bun run font /path/to/BerkeleyMonoVariable.otf # or any path
```

This writes `public/fonts/BerkeleyMonoVariable.woff2`, which the build picks up (and preloads).
For a deploy, put the file there in CI before `bun run build`.

## Content

The docs pages are Markdown in `src/content/docs/` (`index`, `cli`, `api`, `troubleshooting`).
The same files produce:

- the HTML pages (`/`, `/cli`, `/api`, `/troubleshooting`),
- a Markdown copy of each (`/index.md`, `/cli.md`, …),
- `/llms.txt`, the full docs in one file.

`/skill.md` (the agent skill) lives in `src/pages/skill.md.ts`.

Conventions the renderer (`src/lib/docs-plugin.ts`) understands:

- `## Heading` starts a section (anchor, sidebar entry, scroll-spy).
- `` ### `tray list` (alias `ls`) `` is a command signature with an alias badge.
- In code fences, `$ ` starts a command (shown with `›` and copied), `# ` is a comment, anything
  else is output. Fence meta: `tabs="curl,bun,npm"`, `title="…"`, `response` (deep-blue JSON).
- A table whose first header is `Method` or `Step` gets the endpoint or step layout.
- `#### Label` is a small uppercase label.

Site-wide links (GitHub, the footer's author link, version) are in `src/lib/site.ts`.

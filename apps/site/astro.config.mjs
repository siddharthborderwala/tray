import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { satteri } from "@astrojs/markdown-satteri";
import { trayHast } from "./src/lib/docs-plugin.ts";

export default defineConfig({
  site: "https://tray.sh",
  output: "server",
  adapter: cloudflare({
    imageService: "passthrough",
    // Build-time routes read files from the repo (skill, install script, OpenAPI).
    prerenderEnvironment: "node",
  }),
  session: false,
  build: { format: "file" },
  trailingSlash: "never",
  markdown: {
    syntaxHighlight: false,
    processor: satteri({
      features: { smartPunctuation: false },
      hastPlugins: [trayHast],
    }),
  },
});

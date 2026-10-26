import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";
import { trayHast } from "./src/lib/docs-plugin.ts";

export default defineConfig({
  site: "https://tray.sh",
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

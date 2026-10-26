// `import source from "@tray-sh/worker/bundle" with { type: "text" }`: the built
// Worker (dist/worker.js) as a string. The CLI embeds it for `tray setup`.
declare const source: string;
export default source;

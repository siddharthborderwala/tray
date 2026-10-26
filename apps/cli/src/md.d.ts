// `import x from "./file.md" with { type: "text" }` (Bun embeds it at build time).
declare module "*.md" {
  const text: string;
  export default text;
}

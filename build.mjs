import { build } from "esbuild";
await build({
  entryPoints: { app: "src/app.js", confirmar: "src/confirmar.js", extrato: "src/extrato.js" },
  bundle: true, format: "esm", minify: true, target: "es2020", outdir: "public", logLevel: "info",
});

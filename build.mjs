import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = {
  bundle: true,
  nodePaths: [path.join(here, "node_modules")],
  loader: { ".svg": "text" },
  logLevel: "info",
};

await esbuild.build({
  ...shared,
  entryPoints: [path.join(here, "src/main.js")],
  format: "esm",
  outfile: path.join(here, "dist/app.js"),
});

await esbuild.build({
  ...shared,
  entryPoints: [path.join(here, "src/custody.test.js")],
  format: "esm",
  platform: "node",
  external: ["node:test"],
  outfile: path.join(here, "dist/custody.test.js"),
});

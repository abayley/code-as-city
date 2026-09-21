// Builds the plugin bundle.
require("esbuild").buildSync({ entryPoints: ["src/index.ts"], bundle: true });

import { build } from "esbuild";
import fs from "node:fs";

await build({
	entryPoints: ["./src/index.ts"],
	bundle: true,
	minify: true,
	platform: "node",
	target: "node18",
	outfile: "./build/index.js",
	format: "esm",
	banner: {
		js: `#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);`,
	},
	external: ["jsdom"],
	resolveExtensions: [".ts", ".js", ".json"],
});

// Set executable permission
fs.chmodSync("./build/index.js", "755");

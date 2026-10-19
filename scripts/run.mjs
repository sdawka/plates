// Bundles a TypeScript script with esbuild (the test fakes use extensionless imports) and runs it.
// Usage: node scripts/run.mjs scripts/local-e2e.ts [args...]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error("usage: node scripts/run.mjs <entry.ts> [args]");

const dir = mkdtempSync(join(tmpdir(), "plates-script-"));
const stubVitest = join(dir, "vitest-stub.mjs");
writeFileSync(stubVitest, "export const vi = new Proxy({}, { get: () => () => { throw new Error('vitest is not available here'); } });\n");
const outfile = join(dir, "bundle.mjs");

await build({
  entryPoints: [resolve(entry)],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  alias: { vitest: stubVitest },
  logLevel: "warning",
  // CJS deps (the shape of some bundled code) need require in an ESM output.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const child = spawn(process.execPath, [outfile, ...args], { stdio: "inherit", cwd: process.cwd() });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

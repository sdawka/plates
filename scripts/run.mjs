// Bundles a TypeScript script with esbuild (the test fakes use extensionless imports) and runs it.
// Usage: node scripts/run.mjs scripts/local-e2e.ts [args...]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error("usage: node scripts/run.mjs <entry.ts> [args]");

// Bundled next to the scripts (not in a temp dir) so `import.meta.url`-relative paths in the test helpers
// (e.g. the migrations directory) still point into the repo. Ignored by git.
const dir = resolve("scripts/.bundle");
mkdirSync(dir, { recursive: true });
const stubVitest = join(dir, "vitest-stub.mjs");
writeFileSync(
  stubVitest,
  [
    "// Enough of vitest's `vi` for the test harness to run outside vitest: spies that replace a method, global stubs.",
    "const undo = [];",
    "const RealDate = Date; let fakeNow = RealDate.now();",
    "export const vi = {",
    "  spyOn(obj, key) { const orig = obj[key]; undo.push(() => { obj[key] = orig; }); const s = { mockImplementation(fn) { obj[key] = fn; return s; } }; obj[key] = () => {}; return s; },",
    "  stubGlobal(name, value) { const orig = globalThis[name]; undo.push(() => { globalThis[name] = orig; }); globalThis[name] = value; },",
    "  unstubAllGlobals() { for (const u of undo.splice(0)) u(); },",
    "  restoreAllMocks() { for (const u of undo.splice(0)) u(); },",
    "  // Fake Date only (what the harness Clock asks for): Date.now and `new Date()` with no arguments follow the fake time.",
    "  useFakeTimers() { const Real = RealDate; const F = class extends Real { constructor(...a) { super(...(a.length ? a : [F.now()])); } static now() { return fakeNow; } }; globalThis.Date = F; },",
    "  setSystemTime(ms) { fakeNow = typeof ms === 'number' ? ms : new RealDate(ms).getTime(); },",
    "  useRealTimers() { globalThis.Date = RealDate; },",
    "};",
    "export const expect = (v, msg) => ({ toBeTruthy() { if (!v) throw new Error(msg ?? 'expected a value'); } });",
    "",
  ].join("\n"),
);
const outfile = join(dir, `${basename(entry, ".ts")}.mjs`);

await build({
  entryPoints: [resolve(entry)],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // The Workers runtime provides cloudflare:workers; scripts get the same in-memory stand-in as the tests.
  alias: { vitest: stubVitest, "cloudflare:workers": resolve("test/helpers/cloudflare-workers.ts") },
  logLevel: "warning",
  // CJS deps (the shape of some bundled code) need require in an ESM output.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const child = spawn(process.execPath, [outfile, ...args], { stdio: "inherit", cwd: process.cwd() });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

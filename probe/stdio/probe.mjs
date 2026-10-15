// Runs inside the container with no network: starts the server command given on
// the command line, lists its tools, prints the probe result and the raw tool
// definitions as JSON on stdout. Nothing else writes to stdout.
import { createRequire } from 'node:module';
const require = createRequire('/usr/local/lib/node_modules/mcpcost/package.json');
const { probeStdioRaw } = await import(require.resolve('mcpcost'));
const [command, ...args] = process.argv.slice(2);
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 45000);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PROBE_')));
let out;
try {
  const { result, tools } = await probeStdioRaw({ command, args, env, cwd: '/work' }, { timeoutMs });
  out = JSON.stringify({ result, tools });
} catch (e) {
  out = JSON.stringify({ result: { status: 'error', error: String(e).slice(0, 400), latencyMs: {} }, tools: [] });
}
// stdout is a pipe: wait for the write to drain before exiting, or a big tool list is cut at 64 KB.
process.stdout.write(out, () => process.exit(0));

/**
 * Probes a sample of remote servers from the MCP registry and writes the results
 * to data/. Usage:
 *   npm run probe -- --sample 200 --per-host 2 --concurrency 16
 *   npm run probe -- --all --out data/raw/probe-all.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fetchRegistry, hostOf, primaryRemote, CLAUDE_MODEL } from '../packages/mcptop/src/index.js';
import { probeRemoteRaw } from '../packages/mcptop/src/core.js';
import { priceTools } from '../packages/mcptop/src/probe.js';
import { createClaudeCounter, payloadHash } from './claude-cache.js';
import type { ProbeResult, RegistryEntry } from '../packages/mcptop/src/index.js';

const { values: args } = parseArgs({
  options: {
    sample: { type: 'string', default: '200' },
    'per-host': { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '16' },
    timeout: { type: 'string', default: '15000' },
    all: { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
    cache: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string' },
    /** servers.json of the previous run. Servers whose tools did not change keep their Claude count from it. */
    'claude-cache': { type: 'string' },
    'claude-model': { type: 'string', default: CLAUDE_MODEL },
    /** count_tokens requests a minute. Small organisations get 100. */
    'claude-rpm': { type: 'string', default: '90' },
    /** Minutes after start when counting stops. Servers left over are counted next run. */
    'claude-deadline-min': { type: 'string', default: '270' }
  }
});
const started = Date.now();

const sampleSize = Number(args.sample);
const perHost = Number(args['per-host']);
const concurrency = Number(args.concurrency);
const timeoutMs = Number(args.timeout);

interface Target {
  name: string;
  url: string;
  type: 'streamable-http' | 'sse';
  host: string;
  updatedAt: string;
  status: string;
}

const claude = await createClaudeCounter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  cachePath: args['claude-cache'],
  model: args['claude-model'],
  rpm: Number(args['claude-rpm']) || 90,
  deadline: started + (Number(args['claude-deadline-min']) || 270) * 60_000
});

/** Runs probes with a global concurrency limit and at most one in flight per host. */
async function runAll(targets: Target[]): Promise<Array<Target & { result: ProbeResult; payloadHash?: string }>> {
  const out: Array<Target & { result: ProbeResult; payloadHash?: string }> = [];
  const busyHosts = new Set<string>();
  const queue = [...targets];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const idx = queue.findIndex((t) => !busyHosts.has(t.host));
      if (idx === -1) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const [target] = queue.splice(idx, 1);
      busyHosts.add(target.host);
      try {
        const { result, tools } = await probeRemoteRaw({ url: target.url, type: target.type }, { timeoutMs });
        priceTools(result, tools);
        let hash: string | undefined;
        if (result.status === 'ok' && tools.length) {
          hash = payloadHash(tools);
          busyHosts.delete(target.host);
          result.claude = await claude.count(target.name, tools, hash);
        }
        out.push({ ...target, result, payloadHash: hash });
      } finally {
        busyHosts.delete(target.host);
        done++;
        if (done % 25 === 0 || done === targets.length) {
          const s = Math.round((Date.now() - started) / 1000);
          console.error(`  ${done}/${targets.length} probed (${s}s)`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

function summarize(rows: Array<Target & { result: ProbeResult }>) {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.result.status] = (byStatus[r.result.status] ?? 0) + 1;
  const ok = rows.filter((r) => r.result.status === 'ok');
  const tokens = ok.map((r) => r.result.toolsTokens ?? 0).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : 0);
  const init = ok.map((r) => r.result.latencyMs.initialize ?? 0).sort((a, b) => a - b);
  const top = [...ok].sort((a, b) => (b.result.toolsTokens ?? 0) - (a.result.toolsTokens ?? 0)).slice(0, 10)
    .map((r) => ({ name: r.name, tools: r.result.toolCount, tokens: r.result.toolsTokens }));
  const protocols: Record<string, number> = {};
  for (const r of ok) protocols[r.result.protocolVersion ?? 'unknown'] = (protocols[r.result.protocolVersion ?? 'unknown'] ?? 0) + 1;
  const authSchemes: Record<string, number> = {};
  for (const r of rows.filter((r) => r.result.status === 'auth')) {
    const k = r.result.authScheme ?? 'none';
    authSchemes[k] = (authSchemes[k] ?? 0) + 1;
  }
  return {
    probed: rows.length,
    byStatus,
    ok: ok.length,
    toolsTokens: { median: median(tokens), p90: tokens[Math.floor(tokens.length * 0.9)] ?? 0, max: tokens.at(-1) ?? 0 },
    initializeMs: { median: median(init), p90: init[Math.floor(init.length * 0.9)] ?? 0 },
    protocols,
    authSchemes,
    top
  };
}

const entries = await loadRegistry();
const targets = pickTargets(entries);
console.error(`${entries.length} registry entries, ${targets.length} targets, concurrency ${concurrency}, timeout ${timeoutMs}ms`);
const rows = await runAll(targets);
const summary = summarize(rows);
if (claude.enabled) { const c = claude.stats(); console.error(`Claude counts: ${c.counted} servers counted now, ${c.reused} reused from the previous run, ${c.skipped} left for the next run (deadline)`); }
else console.error('ANTHROPIC_API_KEY is not set: no exact Claude counts in this run.');
const stamp = new Date().toISOString().slice(0, 10);
await mkdir('data/samples', { recursive: true });
const file = args.out ?? `data/samples/probe-${stamp}${args.all ? '-all' : `-n${targets.length}`}.json`;
await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
await writeFile(file, JSON.stringify({ probedAt: new Date().toISOString(), options: { ...args }, summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 2));
console.error(`written ${file}`);

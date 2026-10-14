/**
 * Prototype: probes npm-packaged (stdio) servers from the registry, each in its
 * own container. Install with the network on, run with it off. Usage:
 *   node --import tsx probe/stdio-run.ts --sample 200 --concurrency 4 --out data/raw/stdio-run.json
 * Needs the image: docker build -t mcp-pulse-stdio probe/stdio
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import type { RegistryEntry, RegistryPackage, ProbeResult } from '../packages/mcptop/src/index.js';
import { priceTools } from '../packages/mcptop/src/probe.js';
import type { RawTool } from '../packages/mcptop/src/core.js';

const run = promisify(execFile);
const { values: args } = parseArgs({
  options: {
    /** Probe only this many of the selected targets; empty means all. */
    sample: { type: 'string', default: '' },
    /** npm, pypi or both. */
    kind: { type: 'string', default: 'npm,pypi' },
    /** Only the shard of names whose hash falls on this day of a 7-day cycle (0-6); empty means all. */
    shard: { type: 'string', default: '' },
    /** Split the (sharded) list into this many parts and take one: "3/20". */
    part: { type: 'string', default: '' },
    /** A file with one registry name per line; overrides sample. */
    names: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '4' },
    seed: { type: 'string', default: '7' },
    image: { type: 'string', default: 'mcp-pulse-stdio' },
    registry: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string', default: 'data/raw/stdio-run.json' },
    'install-timeout': { type: 'string', default: '180000' },
    'probe-timeout': { type: 'string', default: '45000' }
  }
});

type StdioStatus = ProbeResult['status'] | 'install_failed' | 'no_bin' | 'needs_env' | 'needs_args' | 'needs_network' | 'crashed';
interface Target { name: string; pkg: RegistryPackage; updatedAt: string }
type Kind = 'npm' | 'pypi';
interface Row {
  name: string;
  kind: Kind;
  identifier: string;
  version?: string;
  command?: string[];
  env?: string[];
  status: StdioStatus;
  installMs?: number;
  result?: ProbeResult;
  tools?: RawTool[];
  error?: string;
}

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function loadTargets(): Promise<Target[]> {
  const raw = JSON.parse(await readFile(args.registry, 'utf8')) as Array<{ server: RegistryEntry['server']; _meta: Record<string, RegistryEntry['meta']> }>;
  const kinds = new Set(args.kind.split(','));
  let all: Target[] = [];
  for (const r of raw) {
    if (r.server.remotes?.length) continue;
    const pkg = r.server.packages?.find((p) => kinds.has(p.registryType) && (p.transport?.type ?? 'stdio') === 'stdio');
    if (!pkg) continue;
    all.push({ name: r.server.name, pkg, updatedAt: r._meta['io.modelcontextprotocol.registry/official']?.updatedAt ?? '' });
  }
  if (args.names) {
    const want = new Set((await readFile(args.names, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean));
    return all.filter((t) => want.has(t.name));
  }
  if (args.shard !== '') all = all.filter((t) => shardOf(t.name) === Number(args.shard));
  all.sort((a, b) => a.name.localeCompare(b.name));
  if (args.part) {
    const [k, n] = args.part.split('/').map(Number);
    all = all.filter((_, i) => i % n === k);
    return args.sample ? all.slice(0, Number(args.sample)) : all;
  }
  const rand = mulberry32(Number(args.seed));
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  return args.sample ? all.slice(0, Number(args.sample)) : all;
}

/** Which day of a seven-day cycle a server is probed on: a stable hash of its name. */
export function shardOf(name: string): number {
  let h = 2166136261;
  for (const c of name) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 7;
}

/** Command-line arguments from the registry entry: fixed values and defaults; a required one without a value stops the probe. */
function buildArgs(pkg: RegistryPackage): { args: string[]; missing: string[] } {
  const out: string[] = [];
  const missing: string[] = [];
  for (const a of [...(pkg.runtimeArguments ?? []), ...(pkg.packageArguments ?? [])]) {
    const value = a.value ?? a.default;
    if (a.type === 'flag') { if (a.name) out.push(a.name); continue; }
    if (a.type === 'named') {
      if (value != null && a.name) out.push(a.name, value);
      else if (a.isRequired) missing.push(a.name ?? '?');
      continue;
    }
    if (value != null) out.push(value);
    else if (a.isRequired) missing.push(a.valueHint ?? a.name ?? 'positional');
  }
  return { args: out, missing };
}

/** Placeholder values for the environment the server expects, so it starts and lists its tools. */
function buildEnv(pkg: RegistryPackage): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of pkg.environmentVariables ?? []) env[v.name] = v.default ?? (v.isSecret ? 'mcp-pulse-placeholder-secret' : 'mcp-pulse-placeholder');
  return env;
}

function dockerArgs(extra: string[]): string[] {
  return ['run', '--rm', '--memory', '512m', '--cpus', '1', '--pids-limit', '256', '--security-opt', 'no-new-privileges', ...extra];
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

/** Installs the package into the work directory with the network on. Returns the command that starts it. */
async function install(t: Target, dir: string): Promise<{ command: string[] } | { status: StdioStatus; error: string }> {
  const kind = t.pkg.registryType as Kind;
  const id = t.pkg.identifier;
  if (kind === 'npm') {
    const spec = t.pkg.version ? `${id}@${t.pkg.version}` : id;
    try {
      await withTimeout(run('docker', dockerArgs(['-v', `${dir}:/work`, '-w', '/work', args.image, 'npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', '/work', '--loglevel', 'error', spec]), { maxBuffer: 4e6 }), Number(args['install-timeout']), 'install');
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? e);
      return { status: /E404|404 Not Found|ETARGET|No matching version|notarget/.test(msg) ? 'not_found' : 'install_failed', error: msg.trim().split('\n').slice(-3).join(' ').slice(0, 300) };
    }
    let pkgJson: { bin?: string | Record<string, string> };
    try { pkgJson = JSON.parse(await readFile(join(dir, 'node_modules', id, 'package.json'), 'utf8')); } catch { return { status: 'install_failed', error: 'package.json missing after install' }; }
    const bins = typeof pkgJson.bin === 'string' ? { [id.split('/').pop()!]: pkgJson.bin } : (pkgJson.bin ?? {});
    const binName = Object.keys(bins).find((b) => b === id.split('/').pop()) ?? Object.keys(bins)[0];
    if (!binName) return { status: 'no_bin', error: 'package declares no bin' };
    return { command: ['node', `/work/node_modules/${id}/${bins[binName]}`] };
  }
  // PyPI: a uv tool install into the work directory; the console script is the command. Python 3.12 first, 3.13 when the package asks for it.
  const spec = t.pkg.version ? `${id}==${t.pkg.version}` : id;
  const uvCache = join(tmpdir(), 'mcp-pulse-uv-cache');
  let lastError = '';
  for (const py of ['3.12', '3.13']) {
    try {
      await withTimeout(run('docker', dockerArgs(['-v', `${dir}:/work`, '-v', `${uvCache}:/root/.cache/uv`, '-w', '/work', args.image, 'uv', 'tool', 'install', '--quiet', '--python', py, spec]), { maxBuffer: 4e6 }), Number(args['install-timeout']), 'install');
      lastError = '';
      break;
    } catch (e) {
      lastError = String((e as { stderr?: string }).stderr ?? e);
      if (!/does not satisfy Python|requires-python|Python>=3\.13/i.test(lastError)) break;
    }
  }
  if (lastError) {
    const notFound = /there is no version of|not found in the package registry|was not found in|No matching distribution|Package `[^`]+` was not found/i.test(lastError) && !/does not satisfy Python/i.test(lastError);
    return { status: notFound ? 'not_found' : 'install_failed', error: lastError.trim().split('\n').slice(-3).join(' ').slice(0, 300) };
  }
  const { readdir } = await import('node:fs/promises');
  const bins = (await readdir(join(dir, 'bin')).catch(() => [] as string[])).filter((b) => !b.startsWith('.'));
  const want = id.toLowerCase().replace(/_/g, '-');
  const binName = bins.find((b) => b.toLowerCase().replace(/_/g, '-') === want) ?? bins.find((b) => want.includes(b.toLowerCase().replace(/_/g, '-'))) ?? bins[0];
  if (!binName) return { status: 'no_bin', error: 'package installs no console script' };
  return { command: [`/work/bin/${binName}`] };
}

async function probeOne(t: Target): Promise<Row> {
  const row: Row = { name: t.name, kind: t.pkg.registryType as Kind, identifier: t.pkg.identifier, version: t.pkg.version, status: 'error' };
  const dir = await mkdtemp(join(tmpdir(), 'mcp-pulse-stdio-'));
  try {
    const { args: cliArgs, missing } = buildArgs(t.pkg);
    if (missing.length) { row.status = 'needs_args'; row.error = `requires ${missing.join(', ')}`; return row; }
    const t0 = Date.now();
    const installed = await install(t, dir);
    if ('status' in installed) { row.status = installed.status; row.error = installed.error; return row; }
    row.installMs = Date.now() - t0;
    const command = [...installed.command, ...cliArgs];
    row.command = command;
    const env = buildEnv(t.pkg);
    row.env = Object.keys(env);
    // 3. run with the network off, read-only install, then list the tools
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const { stdout } = await withTimeout(
      run('docker', dockerArgs(['--network', 'none', '-v', `${dir}:/work:ro`, '--tmpfs', '/tmp', '-e', `PROBE_TIMEOUT_MS=${args['probe-timeout']}`, ...envArgs, args.image, 'node', '/app/probe.mjs', ...command]), { maxBuffer: 64e6 }),
      Number(args['probe-timeout']) + 20_000, 'probe'
    );
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { result: ProbeResult; tools: RawTool[] };
    priceTools(parsed.result, parsed.tools);
    row.result = parsed.result;
    row.tools = parsed.tools;
    row.status = parsed.result.status;
    const text = `${parsed.result.error ?? ''}`;
    if (row.status !== 'ok' && /api[_ -]?key|token|credential|unauthori[sz]ed|missing required|environment variable|must be set|must use|is required|not configured|is invalid|invalid url|not recognized|placeholder|please set|config/i.test(text)) row.status = 'needs_env';
    if (row.status !== 'ok' && /^usage:|\busage:|unknown command|missing argument|expected a command|too few arguments/im.test(text)) row.status = 'needs_args';
    // Closed before initialize with a stack trace or an import error: the server crashed on start.
    if (row.status === 'error' && /Connection closed/.test(text)) row.status = 'crashed';
    // A bridge to a remote server (mcp-remote and friends) cannot work with the network off; that is a remote server in disguise.
    if (row.status !== 'ok' && /mcp-remote|ENOTFOUND|getaddrinfo|ECONNREFUSED|fetch failed|StreamableHTTPClientTransport|SSEClientTransport|Temporary failure in name resolution|Network is unreachable/.test(text)) row.status = 'needs_network';
    if (row.status !== 'ok' && /ModuleNotFoundError|ImportError|Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|TypeError|ReferenceError|Traceback/.test(text)) row.status = 'crashed';
    if (row.status !== 'ok') row.error = text.slice(0, 300);
    return row;
  } catch (e) {
    row.status = /timed out/.test(String(e)) ? 'timeout' : 'error';
    row.error = String((e as { stderr?: string }).stderr ?? e).slice(-300);
    return row;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const targets = await loadTargets();
console.error(`${targets.length} npm targets, concurrency ${args.concurrency}`);
const rows: Row[] = [];
let i = 0;
const started = Date.now();
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (i < targets.length) {
    const t = targets[i++];
    const r = await probeOne(t);
    rows.push(r);
    console.error(`  ${rows.length}/${targets.length} ${r.status.padEnd(14)} ${r.kind}:${t.pkg.identifier} ${r.result?.toolCount != null ? `${r.result.toolCount} tools ${r.result.toolsTokens} tok` : ''} ${r.installMs ? `(install ${Math.round(r.installMs / 1000)}s)` : ''}`);
  }
}));
const byStatus: Record<string, number> = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const ok = rows.filter((r) => r.status === 'ok');
const tok = ok.map((r) => r.result!.toolsTokens ?? 0).sort((a, b) => a - b);
const summary = { probed: rows.length, byStatus, ok: ok.length, medianTokens: tok[Math.floor(tok.length / 2)] ?? 0, maxTokens: tok.at(-1) ?? 0, seconds: Math.round((Date.now() - started) / 1000), secondsPerPackage: Math.round((Date.now() - started) / 1000 / Math.max(1, rows.length) * Number(args.concurrency) * 10) / 10 };
await mkdir(args.out.slice(0, args.out.lastIndexOf('/')), { recursive: true });
await writeFile(args.out, JSON.stringify({ probedAt: new Date().toISOString(), summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 2));

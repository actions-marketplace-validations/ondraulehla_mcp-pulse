/**
 * mcpcost as an MCP server over stdio: the same measurements as the CLI, for
 * an agent that wants to know what a server costs before it is added to a
 * config. Two tools work offline (they probe the server themselves); two ask
 * the public board for registry data.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION, probeRemote } from './probe.js';
import { probeStdio } from './stdio.js';
import { readConfigFile } from './configs.js';
import type { ProbeResult } from './types.js';

const BOARD = 'https://mcpcost.ulehla.dev';

function compact(r: ProbeResult, window: number) {
  return {
    status: r.status,
    error: r.error,
    protocolVersion: r.protocolVersion,
    serverInfo: r.serverInfo,
    toolCount: r.toolCount,
    toolsTokensEstimate: r.toolsTokens,
    claudeTokens: r.claude?.tokens,
    claudeTokensClaudeCode: r.claude?.tokensClaudeCode,
    claudeError: r.claude?.error,
    shareOfWindow: r.toolsTokens != null ? Number((((r.claude?.tokens ?? r.toolsTokens) / window) * 100).toFixed(2)) : undefined,
    latencyMs: r.latencyMs,
    topTools: r.tools ? [...r.tools].sort((a, b) => b.tokens - a.tokens).slice(0, 10).map((t) => ({ name: t.name, tokens: t.tokens })) : undefined
  };
}

const claudeOptions = (serverName: string) => (process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY, serverName } : undefined);
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });

const TOOLS = [
  {
    name: 'measure_server',
    title: 'Measure one server',
    description: 'Starts or connects to one MCP server, lists its tools and reports the result, the protocol version and the token cost of its tool definitions. Give either a remote URL or a local command.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Remote endpoint, https://…/mcp or an SSE URL' },
        command: { type: 'string', description: 'Local server command with its arguments, for example "npx -y @modelcontextprotocol/server-filesystem /tmp"' },
        window: { type: 'integer', minimum: 1, description: 'Context window for the share, default 200000' }
      }
    }
  },
  {
    name: 'measure_config',
    title: 'Measure a config file',
    description: 'Measures every server in an MCP config file (.mcp.json, Claude Desktop, Cursor, VS Code or Windsurf format): starts each one the way the client would and reports tokens per server and in total.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the config file' },
        window: { type: 'integer', minimum: 1 },
        noStdio: { type: 'boolean', description: 'Measure remote servers only, do not start local ones' }
      },
      required: ['path']
    }
  },
  {
    name: 'lookup_server',
    title: 'Look up a registry server on the board',
    description: 'Latest daily probe of a server in the official MCP registry: status, exact token cost in Claude, tool count, latency, history. Accepts the registry name (io.github.owner/name) or the server URL.',
    inputSchema: { type: 'object', properties: { nameOrUrl: { type: 'string' } }, required: ['nameOrUrl'] }
  },
  {
    name: 'search_servers',
    title: 'Search the board',
    description: 'Finds registry servers by words in their name, title, description or host, sorted by exact Claude token cost by default. Twenty per page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        status: { type: 'string', enum: ['ok', 'auth', 'payment', 'newer_protocol', 'down'] },
        sort: { type: 'string', enum: ['claude', 'claude-asc', 'tokens', 'tools', 'latency', 'name', 'updated'] },
        page: { type: 'integer', minimum: 1, maximum: 20 }
      }
    }
  }
] as const;

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const num = (a: Args, k: string) => (typeof a[k] === 'number' ? (a[k] as number) : undefined);
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

async function call(name: string, a: Args) {
  const w = num(a, 'window') ?? 200_000;
  switch (name) {
    case 'measure_server': {
      const url = str(a, 'url');
      const command = str(a, 'command');
      if (url) {
        const r = await probeRemote({ url, type: /\/sse\/?$/.test(url) ? 'sse' : 'streamable-http' }, { timeoutMs: 15_000, claude: claudeOptions(new URL(url).hostname) });
        return text({ target: url, ...compact(r, w) });
      }
      if (command) {
        const [cmd, ...args] = command.trim().split(/\s+/);
        const r = await probeStdio({ command: cmd, args }, { timeoutMs: 20_000, claude: claudeOptions(cmd) });
        return text({ target: command, ...compact(r, w) });
      }
      return fail('Give url or command.');
    }
    case 'measure_config': {
      const path = str(a, 'path');
      if (!path) return fail('Give path.');
      const cfg = await readConfigFile(path, 'config');
      if (!cfg) return fail(`Cannot read ${path}`);
      const noStdio = a.noStdio === true;
      const servers = await Promise.all(
        cfg.servers.map(async (s) => {
          if (s.disabled) return { name: s.name, skipped: 'disabled in config' };
          if (s.kind === 'stdio' && noStdio) return { name: s.name, skipped: 'local server, noStdio' };
          const r =
            s.kind === 'remote'
              ? await probeRemote({ url: s.url!, type: s.type ?? 'streamable-http' }, { timeoutMs: 15_000, headers: s.headers, claude: claudeOptions(s.name) })
              : await probeStdio({ command: s.command!, args: s.args, env: s.env, cwd: s.cwd }, { timeoutMs: 20_000, claude: claudeOptions(s.name) });
          return { name: s.name, kind: s.kind, ...compact(r, w) };
        })
      );
      const measured = servers.filter((s) => 'status' in s && s.status === 'ok') as Array<{ toolsTokensEstimate?: number; claudeTokens?: number }>;
      const total = measured.reduce((t, s) => t + (s.claudeTokens ?? s.toolsTokensEstimate ?? 0), 0);
      return text({ path, total: { servers: measured.length, tokens: total, shareOfWindow: Number(((total / w) * 100).toFixed(2)) }, servers });
    }
    case 'lookup_server': {
      const nameOrUrl = str(a, 'nameOrUrl');
      if (!nameOrUrl) return fail('Give nameOrUrl.');
      const url = /^https?:\/\//.test(nameOrUrl) ? `${BOARD}/api/check.json?url=${encodeURIComponent(nameOrUrl)}` : `${BOARD}/api/s/${nameOrUrl}.json`;
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': `mcpcost/${VERSION}` } });
      if (!res.ok) return fail(`The board has no server ${nameOrUrl} (HTTP ${res.status}). Use measure_server to probe it now.`);
      return text(await res.json());
    }
    case 'search_servers': {
      const u = new URL(`${BOARD}/api/servers.json`);
      const query = str(a, 'query');
      if (query) u.searchParams.set('q', query);
      const status = str(a, 'status');
      if (status) u.searchParams.set('status', status);
      u.searchParams.set('sort', str(a, 'sort') ?? 'claude');
      u.searchParams.set('page', String(num(a, 'page') ?? 1));
      u.searchParams.set('per_page', '20');
      const res = await fetch(u, { headers: { accept: 'application/json', 'user-agent': `mcpcost/${VERSION}` } });
      if (!res.ok) return fail(`The board did not answer (HTTP ${res.status}).`);
      return text(await res.json());
    }
    default:
      return fail(`Unknown tool ${name}`);
  }
}

export function buildServer(): Server {
  const server = new Server(
    { name: 'mcpcost', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Measures what MCP servers cost in context tokens. measure_server probes one server (remote URL or local command) now. measure_config measures every server in a config file. lookup_server and search_servers read the public board at mcpcost.ulehla.dev, which probes the whole registry daily. Token numbers are o200k_base estimates; with ANTHROPIC_API_KEY set, claudeTokens is the exact count from the free count_tokens endpoint.'
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await call(req.params.name, (req.params.arguments ?? {}) as Args);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });
  return server;
}

/** Serves the tools over stdio until the client closes the pipe. */
export async function serveStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

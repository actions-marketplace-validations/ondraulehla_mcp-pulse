/**
 * Exact Claude counts with a cache: a server is counted again only when its
 * tool payload changed. The cache is the previous run's servers.json. Shared
 * by the remote probe (probe/run.ts) and the stdio counter (probe/count-tools.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { countForServer, createLimiter, ClaudeCountError, CLAUDE_MODEL, toolPayload } from '../packages/mcpcost/src/index.js';
import type { ClaudeTokens } from '../packages/mcpcost/src/index.js';
import type { RawTool } from '../packages/mcpcost/src/core.js';

type CachedClaude = ClaudeTokens & { payloadHash?: string };

/** Hash of the full tool payloads. Equal hashes mean the same definitions, byte for byte. */
export function payloadHash(tools: RawTool[]): string {
  return createHash('sha1').update(tools.map(toolPayload).join('\u0000')).digest('hex').slice(0, 16);
}

export interface ClaudeCounter {
  enabled: boolean;
  count(name: string, tools: RawTool[], hash: string): Promise<ClaudeTokens | undefined>;
  stats(): { counted: number; reused: number; skipped: number };
}

export async function createClaudeCounter(options: { apiKey?: string; cachePath?: string; model?: string; rpm?: number; deadline?: number }): Promise<ClaudeCounter> {
  const apiKey = options.apiKey;
  const model = options.model ?? CLAUDE_MODEL;
  const cache = new Map<string, CachedClaude>();
  if (options.cachePath && existsSync(options.cachePath)) {
    const prev = JSON.parse(await readFile(options.cachePath, 'utf8')) as Array<{ name: string; payloadHash?: string; claudeModel?: string; claudeTokens?: number; claudeTokensCc?: number; claudeMeasuredAt?: string; claudeError?: string }>;
    for (const p of prev) {
      if (p.payloadHash && p.claudeModel === model && p.claudeMeasuredAt && (p.claudeTokens != null || p.claudeError)) {
        cache.set(p.name, { payloadHash: p.payloadHash, model: p.claudeModel, tokens: p.claudeTokens, tokensClaudeCode: p.claudeTokensCc, measuredAt: p.claudeMeasuredAt, error: p.claudeError });
      }
    }
    console.error(`${cache.size} Claude counts loaded from ${options.cachePath}`);
  }
  const limiter = createLimiter(options.rpm ?? 90);
  const deadline = options.deadline ?? Infinity;
  let counted = 0, reused = 0, skipped = 0;
  return {
    enabled: Boolean(apiKey),
    stats: () => ({ counted, reused, skipped }),
    async count(name, tools, hash) {
      if (!apiKey) return undefined;
      const cached = cache.get(name);
      if (cached && cached.payloadHash === hash) {
        reused++;
        const { payloadHash: _h, ...rest } = cached;
        return rest;
      }
      if (Date.now() > deadline) { skipped++; return undefined; }
      counted++;
      const measuredAt = new Date().toISOString();
      try {
        const c = await countForServer(tools, name, { apiKey, model, limiter });
        // The same numbers as before: keep the old date, so the row does not change for nothing.
        if (cached && cached.tokens === c.tokens && cached.tokensClaudeCode === c.tokensClaudeCode) return { model: c.model, tokens: c.tokens, tokensClaudeCode: c.tokensClaudeCode, measuredAt: cached.measuredAt };
        return { model: c.model, tokens: c.tokens, tokensClaudeCode: c.tokensClaudeCode, measuredAt };
      } catch (e) {
        const message = e instanceof ClaudeCountError ? e.message : String(e);
        // A refused schema is a stable fact about the server; a transport failure is not, so leave it out and retry next run.
        if (e instanceof ClaudeCountError && e.status >= 400 && e.status < 500 && e.status !== 429) return { model, measuredAt, error: message };
        console.error(`  count_tokens failed for ${name}: ${message}`);
        return undefined;
      }
    }
  };
}

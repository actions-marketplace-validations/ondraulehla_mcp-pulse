import type { APIRoute } from 'astro';
import { getHistory, getServer } from '../../lib/db';
import { label } from '../../lib/format';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('en-US').replace(/,/g, ' '));

/**
 * One server as an Atom feed: an entry for every probe that changed something
 * (result, tool count or token cost), newest first. For the people who run the
 * server and want to know when it stops answering or its tool set grows.
 */
export const GET: APIRoute = async ({ params, site }) => {
  const name = (params.name ?? '').replace(/\.xml$/, '');
  const server = name ? await getServer(name) : null;
  if (!server) return new Response('Not found', { status: 404 });
  const base = (site ?? new URL('https://mcp-pulse.ulehla.dev')).toString().replace(/\/$/, '');
  const history = await getHistory(name, 30);
  const page = `${base}/s/${name}`;
  const entries = history.map((h, i) => {
    const prev = history[i + 1];
    const cost = h.claude_tokens ?? h.tools_tokens;
    // Compare like with like: the exact count against the exact count, the estimate against the estimate.
    const prevCost = !prev ? null : h.claude_tokens != null && prev.claude_tokens != null ? prev.claude_tokens : h.claude_tokens == null ? prev.tools_tokens : null;
    const parts: string[] = [label(h.status)];
    if (h.status === 'ok') parts.push(`${num(h.tool_count)} tools`, `${num(cost)} tokens`);
    if (prev && prev.status !== h.status) parts.push(`was ${label(prev.status)}`);
    if (prev && prevCost != null && cost != null && prevCost !== cost) parts.push(`${cost > prevCost ? '+' : ''}${num(cost - prevCost)} tokens since the previous probe`);
    const title = `${h.probed_at.slice(0, 10)}: ${parts.join(', ')}`;
    const html = `<p>${esc(parts.join('. '))}.</p><p>Probed ${esc(h.probed_at.slice(0, 16).replace('T', ' '))} UTC. <a href="${page}">Server page</a>.</p>`;
    return `  <entry>
    <id>${page}#${h.probed_at}</id>
    <title>${esc(title)}</title>
    <link href="${page}"/>
    <updated>${h.probed_at}</updated>
    <content type="html">${esc(html)}</content>
  </entry>`;
  });
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(name)} on mcp-pulse</title>
  <subtitle>Every probe that changed the result, the tool count or the token cost of this MCP server.</subtitle>
  <id>${page}.xml</id>
  <link href="${page}.xml" rel="self"/>
  <link href="${page}"/>
  <updated>${history[0]?.probed_at ?? server.probed_at}</updated>
  <author><name>mcp-pulse</name></author>
${entries.join('\n')}
</feed>
`;
  return new Response(xml, { headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=10800' } });
};

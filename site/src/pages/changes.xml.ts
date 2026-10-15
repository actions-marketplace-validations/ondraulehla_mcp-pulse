import type { APIRoute } from 'astro';
import { recentRuns } from '../lib/db';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');

/** One Atom entry per run: the counts and the biggest tool set changes. */
export const GET: APIRoute = async ({ site }) => {
  const base = (site ?? new URL('https://mcpcost.ulehla.dev')).toString().replace(/\/$/, '');
  const runs = (await recentRuns(14)).filter((r) => r.changes);
  const entries = runs.map((run) => {
    const c = run.changes!;
    const day = run.probedAt.slice(0, 10);
    const title = `${day}: ${num(c.counts.added)} new, ${num(c.counts.removed)} removed, ${num(c.counts.wentDown)} down, ${num(c.counts.cameBack)} back, ${num(c.counts.tokenChanges)} tool sets changed`;
    const rows = c.tokenChanges.slice(0, 15).map((t) => `<li><a href="${base}/s/${esc(t.name)}">${esc(t.name)}</a>: ${num(t.before)} → ${num(t.after)} tokens${t.exact ? '' : ' (estimate)'}</li>`).join('');
    const down = c.wentDown.slice(0, 15).map((s) => `<li><a href="${base}/s/${esc(s.name)}">${esc(s.name)}</a>: ${esc(s.to)}</li>`).join('');
    const html = `<p>Against the run of ${esc(c.since.slice(0, 16).replace('T', ' '))} UTC.</p>${rows ? `<h3>Tool sets that changed most</h3><ul>${rows}</ul>` : ''}${down ? `<h3>Stopped answering</h3><ul>${down}</ul>` : ''}<p><a href="${base}/changes#${day}">Everything from this run</a></p>`;
    return `  <entry>
    <id>${base}/changes#${day}</id>
    <title>${esc(title)}</title>
    <link href="${base}/changes#${day}"/>
    <updated>${run.probedAt}</updated>
    <content type="html">${esc(html)}</content>
  </entry>`;
  });
  const updated = runs[0]?.probedAt ?? new Date().toISOString();
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>mcpcost: what changed in the MCP registry</title>
  <subtitle>Daily: new and removed servers, servers that went down or came back, tool sets that grew or shrank.</subtitle>
  <id>${base}/changes.xml</id>
  <link href="${base}/changes.xml" rel="self"/>
  <link href="${base}/changes"/>
  <updated>${updated}</updated>
  <author><name>mcpcost</name></author>
${entries.join('\n')}
</feed>
`;
  return new Response(xml, { headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=10800' } });
};

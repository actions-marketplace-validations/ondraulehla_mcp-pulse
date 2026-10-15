import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';

describe('mcptop as an MCP server', () => {
  it('lists its four tools and answers measure_server for a local command', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['lookup_server', 'measure_config', 'measure_server', 'search_servers']);
    const res = await client.callTool({ name: 'measure_server', arguments: { command: 'definitely-not-a-command-xyz' } });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text) as { status: string };
    expect(parsed.status).toBe('not_found');
    await client.close();
    await server.close();
  }, 30_000);
});

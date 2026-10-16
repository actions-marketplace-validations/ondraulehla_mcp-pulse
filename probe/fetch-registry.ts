/** Downloads the registry into data/raw/registry-latest.json when it is not there yet. */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fetchRegistry } from '../packages/mcpcost/src/index.js';
const file = process.argv[2] ?? 'data/raw/registry-latest.json';
if (existsSync(file)) {
  console.error(`${file} exists`);
} else {
  const entries = await fetchRegistry({ onPage: (n) => n % 5000 === 0 && console.error(`  ${n} entries`) });
  await mkdir('data/raw', { recursive: true });
  await writeFile(file, JSON.stringify(entries.map((e) => ({ server: e.server, _meta: { 'io.modelcontextprotocol.registry/official': e.meta } }))));
  console.error(`${entries.length} entries written to ${file}`);
}

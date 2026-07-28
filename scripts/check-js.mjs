import {readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {spawnSync} from 'node:child_process';

const roots = ['web'];
const files = [];

function collect(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
}

roots.forEach(collect);
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
  process.stdout.write(`✓ ${relative(process.cwd(), file)}\n`);
}

process.stdout.write(`Checked ${files.length} JavaScript files.\n`);

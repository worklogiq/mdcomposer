import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = fs.readdirSync('tests').filter(name => name.endsWith('.test.cjs')).sort().map(name => `tests/${name}`);
const result = spawnSync(process.execPath, ['--test', ...files], {stdio:'inherit'});
process.exit(result.status ?? 1);

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const notices = [];
const moduleRoot = path.join(root, 'node_modules');
const packages = fs.readdirSync(moduleRoot, {withFileTypes:true}).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).flatMap(entry => entry.name.startsWith('@') ? fs.readdirSync(path.join(moduleRoot, entry.name)).map(name => path.join(moduleRoot, entry.name, name)) : [path.join(moduleRoot, entry.name)]);
for (const directory of packages.sort()) {
  const manifest = path.join(directory, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const filename of fs.readdirSync(directory).filter(name => /^(?:licen[sc]e|copying)(?:\.|$)/i.test(name))) {
    const file = path.join(directory, filename);
    if (fs.statSync(file).isFile()) notices.push(`${metadata.name}@${metadata.version}\n${fs.readFileSync(file,'utf8').trim()}\n`);
  }
}
fs.writeFileSync(path.join(root,'dist/THIRD-PARTY-NOTICES.txt'),notices.join('\n--------------------\n\n'));
const common = { absWorkingDir: root, bundle: true, platform: 'node', target: 'node20.19', legalComments: 'external', sourcemap: true };
await Promise.all([
  build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/index.js', banner: {js:'import { createRequire as mdcomposerCreateRequire } from "node:module"; const require = mdcomposerCreateRequire(typeof __filename === "string" ? __filename : import.meta.url);'} }),
  build({ ...common, entryPoints: ['src/index.ts'], format: 'cjs', outfile: 'dist/index.cjs' }),
  build({ ...common, entryPoints: ['src/mdcomposer.cli.ts'], format: 'cjs', outfile: 'dist/mdcomposer.cli.cjs' }),
]);
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--emitDeclarationOnly'], { cwd: root, stdio: 'inherit' });

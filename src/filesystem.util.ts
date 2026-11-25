import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ComposePlan, ComposerConfig } from './composer.types.js';

export const sha256 = (content: string | Buffer): string => crypto.createHash('sha256').update(content).digest('hex');
export const posix = (value: string): string => value.split(path.sep).join('/');
export const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

const rejectLinks = (file: string): void => {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink or junction is not allowed: ${current}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      continue;
    }
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink or junction is not allowed: ${current}`);
  }
};

export const safeRoot = (root: string): string => {
  if (typeof root !== 'string' || !root.trim()) throw new Error('An explicit repository root is required.');
  const absolute = path.resolve(root);
  rejectLinks(absolute);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new Error(`Root is not a directory: ${absolute}`);
  return fs.realpathSync(absolute);
};

export const safePath = (root: string, relative: string): string => {
  if (typeof relative !== 'string' || !relative || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) {
    throw new Error(`Expected a contained relative path: ${relative}`);
  }
  const absolute = path.resolve(root, relative.replace(/\\/g, '/'));
  if (!inside(root, absolute)) throw new Error(`Path leaves repository root: ${relative}`);
  rejectLinks(absolute);
  return absolute;
};

export const globMatch = (filename: string, pattern: string): boolean => {
  const value = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let expression = '^';
  for (let index = 0; index < value.length; index += 1) {
    if (value.slice(index, index + 3) === '**/') { expression += '(?:.*/)?'; index += 2; }
    else if (value.slice(index, index + 2) === '**') { expression += '.*'; index += 1; }
    else if (value[index] === '*') expression += '[^/]*';
    else if (value[index] === '?') expression += '[^/]';
    else expression += value[index].replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${expression}$`).test(filename);
};

export const markdownFiles = (root: string, inputs?: string[], config: ComposerConfig = {}): string[] => {
  const roots = inputs?.length ? inputs : config.roots?.length ? config.roots : ['.'];
  const found = new Set<string>();
  const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage']);
  const customIgnore = config.ignore ?? [];
  const scan = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = path.join(directory, entry.name);
      const relative = posix(path.relative(root, absolute));
      if (ignored.has(entry.name) || customIgnore.some(pattern => globMatch(relative, pattern) || globMatch(`${relative}/`, pattern))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symlink or junction is not allowed: ${relative}`);
      if (entry.isDirectory()) scan(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.add(relative);
    }
  };
  for (const input of roots) {
    if (/[*?]/.test(input)) {
      const all = new Set(found);
      found.clear();
      scan(root);
      const matched = [...found].filter(file => globMatch(file, input));
      found.clear();
      for (const file of [...all, ...matched]) found.add(file);
    } else {
      const target = safePath(root, input);
      if (!fs.existsSync(target)) throw new Error(`Input does not exist: ${input}`);
      if (fs.statSync(target).isDirectory()) scan(target);
      else if (target.toLowerCase().endsWith('.md')) found.add(posix(path.relative(root, target)));
    }
  }
  return [...found].sort();
};

export const applyChanges = (plan: ComposePlan): { changed: string[] } => {
  if (!plan || plan.format !== 1 || !Array.isArray(plan.changes) || !Array.isArray(plan.diagnostics) || typeof plan.sources !== 'object' || !plan.sources) {
    throw new Error('Invalid mdcomposer plan.');
  }
  if (plan.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new Error('Plan contains errors; no changes were applied.');
  const root = safeRoot(plan.root);
  const names = new Set<string>();
  for (const [relative, expected] of Object.entries(plan.sources)) {
    const source = safePath(root, relative);
    if (!/^[a-f0-9]{64}$/.test(expected) || !fs.existsSync(source) || !fs.statSync(source).isFile() || sha256(fs.readFileSync(source)) !== expected) {
      throw new Error(`Stale plan source: ${relative}`);
    }
  }
  for (const change of plan.changes) {
    const target = safePath(root, change.path);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (names.has(key) || typeof change.content !== 'string') throw new Error(`Invalid or duplicate planned change: ${change.path}`);
    names.add(key);
    if (change.beforeHash !== null && !/^[a-f0-9]{64}$/.test(change.beforeHash)) throw new Error(`Invalid hash: ${change.path}`);
    const actual = fs.existsSync(target) ? (fs.statSync(target).isFile() ? sha256(fs.readFileSync(target)) : 'directory') : null;
    if (actual !== change.beforeHash) throw new Error(`Stale plan destination or conflict: ${change.path}`);
    let parent = path.dirname(target);
    while (inside(root, parent)) {
      if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) throw new Error(`Destination parent is a file: ${change.path}`);
      if (parent === root) break;
      parent = path.dirname(parent);
    }
    for (const other of plan.changes) {
      if (other !== change && inside(target, safePath(root, other.path))) throw new Error(`Planned file/directory collision: ${change.path}`);
    }
  }
  const changed: string[] = [];
  for (const change of plan.changes) {
    const target = safePath(root, change.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, change.content, 'utf8');
    changed.push(change.path);
  }
  return { changed };
};

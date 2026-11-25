import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import type { ComposeOptions, ComposePlan, ComposerConfig, ComposerOptions, Diagnostic, LintResult, Operation } from './composer.types.js';
import { globMatch, inside, markdownFiles, posix, safePath, safeRoot, sha256 } from './filesystem.util.js';
import { decodePath, externalLink, extractMarkdownLinks, headings, headingSlugs, nodeText, parseMarkdown, parseMetadata, rebaseMarkdownLinks, splitLink, validateMetadata, visit } from './markdown.parser.js';
import type { AstNode } from './markdown.parser.js';
import type { MetadataResult } from './composer.types.js';

const message = (ruleId: string, file: string, error: unknown): Diagnostic => ({ ruleId, severity: 'error', path: file, message: error instanceof Error ? error.message : String(error) });
const audienceOf = (contents: string, config: ComposerConfig): string => String(parseMetadata(contents).data.audience ?? config.defaultAudience ?? 'internal');
const hasPublicMarker = (contents: string): boolean => {
  let found = false;
  visit(parseMarkdown(contents), node => { if (node.type === 'html' && node.value?.trim() === '<!-- @public -->') found = true; });
  return found;
};
const titleOf = (contents: string, filename: string): string => {
  const node = parseMarkdown(contents).children?.find(child => child.type === 'heading');
  return node ? nodeText(node) : path.basename(filename, '.md').replace(/[-_]/g, ' ');
};
const normalize = (contents: string): string => contents.replace(/\r\n/g, '\n');

interface Region { start: number; end: number; kind: string }
const managedRegions = (contents: string, kinds: string[]): Region[] => {
  const result: Region[] = [];
  let open: { start: number; kind: string } | undefined;
  visit(parseMarkdown(contents), node => {
    if (node.type !== 'html' || !node.position) return;
    const value = node.value?.trim() ?? '';
    const match = /^<!--\s*mdcomposer:([a-z]+):(start|end)(?:\s+[^>]*?)?\s*-->$/.exec(value);
    if (!match || !kinds.includes(match[1])) return;
    if (match[2] === 'start') {
      if (open) throw new Error(`Nested or mismatched generated markers: ${match[1]}`);
      open = { start: node.position.start.offset!, kind: match[1] };
    } else {
      if (!open || open.kind !== match[1]) throw new Error(`Generated end marker has no matching start: ${match[1]}`);
      result.push({ start: open.start, end: node.position.end.offset!, kind: open.kind });
      open = undefined;
    }
  });
  if (open) throw new Error(`Generated start marker has no matching end: ${open.kind}`);
  return result;
};

const stripImportPayloads = (contents: string): string => {
  let output = contents;
  for (const region of managedRegions(contents, ['include', 'embed']).sort((a, b) => b.start - a.start)) {
    const start = region.start > 0 && contents[region.start - 1] === '\n' ? region.start - 1 : region.start;
    output = output.slice(0, start) + output.slice(region.end);
  }
  return output;
};

const stripMachineContent = (contents: string): string => {
  const ranges = managedRegions(contents, ['nav', 'index']);
  visit(parseMarkdown(contents), node => {
    if (node.type === 'html' && node.position && /^<!--\s*mdcomposer:meta(?:\s|$)/.test(node.value ?? '')) ranges.push({ start: node.position.start.offset!, end: node.position.end.offset!, kind: 'metadata' });
  });
  const frontmatter = /^(?:\uFEFF)?---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(contents);
  if (frontmatter) ranges.push({ start: 0, end: frontmatter[0].length, kind: 'frontmatter' });
  let output = contents;
  for (const region of ranges.sort((a, b) => b.start - a.start)) output = output.slice(0, region.start) + output.slice(region.end);
  return output.trim();
};

const relativeTarget = (root: string, source: string, destination: string, validatePath = true): { file: string; fragment: string } => {
  const parts = splitLink(destination);
  if (externalLink(destination)) throw new Error(`External imports are not allowed: ${destination}`);
  const pathname = decodePath(parts.pathname);
  const absolute = pathname.startsWith('/') ? path.resolve(root, `.${pathname}`) : pathname ? path.resolve(root, path.dirname(source), pathname) : path.resolve(root, source);
  if (!inside(root, absolute)) throw new Error(`Reference leaves repository root: ${destination}`);
  const file = posix(path.relative(root, absolute)) || '.';
  if (validatePath) safePath(root, file);
  return { file, fragment: decodePath(parts.fragment) };
};

const readVirtual = (root: string, documents: Map<string, string>, file: string): string | undefined => {
  if (documents.has(file)) return documents.get(file);
  const absolute = safePath(root, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return;
  return fs.readFileSync(absolute, 'utf8');
};

const lintVirtual = (root: string, documents: Map<string, string>, files: string[], config: ComposerConfig, readSource?: (file: string) => string): LintResult => {
  const diagnostics: Diagnostic[] = [];
  const analyses = new Map<string, { contents: string; tree: AstNode; metadata: MetadataResult; slugs?: Set<string> }>();
  const contentCache = new Map(documents);
  const pathCache = new Map<string, string>();
  const targetCache = new Map<string, { file: string; directoryOnly: boolean }>();
  const checkedPath = (file: string): string => {
    if (!pathCache.has(file)) pathCache.set(file, safePath(root, file));
    return pathCache.get(file)!;
  };
  const readDocument = (file: string): string => {
    if (!contentCache.has(file)) contentCache.set(file, (readSource ? readSource(file) : readVirtual(root, documents, file))!);
    return contentCache.get(file)!;
  };
  const analyze = (file: string, contents: string) => {
    const cached = analyses.get(file);
    if (cached?.contents === contents) return cached;
    const tree = parseMarkdown(contents);
    const result = { contents, tree, metadata: parseMetadata(contents, tree), slugs: undefined as Set<string> | undefined };
    analyses.set(file, result);
    return result;
  };
  const documentAudience = (analysis: ReturnType<typeof analyze>): string => String(analysis.metadata.data.audience ?? config.defaultAudience ?? 'internal');
  const resolveTarget = (file: string): { file: string; directoryOnly: boolean } => {
    if (targetCache.has(file)) return targetCache.get(file)!;
    let targetFile = file;
    let absolute = checkedPath(targetFile);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      const document = ['index.md', 'README.md'].map(name => posix(path.normalize(`${targetFile}/${name}`)).replace(/^\.\//, '')).find(candidate => {
        const resolved = checkedPath(candidate);
        return documents.has(candidate) || (fs.existsSync(resolved) && fs.statSync(resolved).isFile());
      });
      if (!document) {
        const result = { file, directoryOnly: true }; targetCache.set(file, result); return result;
      }
      targetFile = document;
      absolute = checkedPath(targetFile);
    }
    if (!documents.has(targetFile) && !fs.existsSync(absolute) && !path.extname(targetFile)) {
      const markdown = `${targetFile}.md`;
      if (documents.has(markdown) || fs.existsSync(checkedPath(markdown))) targetFile = markdown;
      absolute = checkedPath(targetFile);
    }
    if (!documents.has(targetFile) && !fs.existsSync(absolute)) throw new Error(`Missing local target: ${file}`);
    const result = { file: targetFile, directoryOnly: false };
    targetCache.set(file, result);
    return result;
  };
  for (const file of files) {
    const contents = documents.get(file)!;
    const sourceAnalysis = analyze(file, contents);
    diagnostics.push(...validateMetadata(contents, config.requiredMetadata, sourceAnalysis.metadata).map(diagnostic => ({ ...diagnostic, path: file })));
    const definitions = new Map<string, string>();
    visit(sourceAnalysis.tree, node => {
      if (node.type !== 'definition') return;
      const id = node.identifier!.toLowerCase();
      if (definitions.has(id) && definitions.get(id) !== node.url) diagnostics.push(message('duplicate-reference', file, `Reference '${id}' has conflicting destinations.`));
      definitions.set(id, node.url!);
    });
    for (const link of extractMarkdownLinks(contents, sourceAnalysis.tree)) {
      if (link.unresolvedReference) { diagnostics.push({ ...message('links', file, `Reference has no definition: ${link.unresolvedReference}`), line: link.line, column: link.column }); continue; }
      if (!link.destination || externalLink(link.destination)) continue;
      try {
        const target = relativeTarget(root, file, link.destination, false);
        const resolved = resolveTarget(target.file);
        if (resolved.directoryOnly) {
          if (target.fragment) throw new Error(`Cannot validate heading fragment in a directory without index.md or README.md: ${link.destination}`);
          continue;
        }
        const targetFile = resolved.file;
        if (targetFile.toLowerCase().endsWith('.md')) {
          const targetContents = readDocument(targetFile);
          const targetAnalysis = analyze(targetFile, targetContents);
          if (target.fragment) targetAnalysis.slugs ??= headingSlugs(targetContents, targetAnalysis.tree);
          if (target.fragment && !targetAnalysis.slugs!.has(target.fragment)) throw new Error(`Missing heading fragment: ${link.destination}`);
          if (documentAudience(sourceAnalysis) === (config.publicAudience ?? 'public') && documentAudience(targetAnalysis) !== (config.publicAudience ?? 'public')) {
            throw new Error(`Public document references an internal document: ${link.destination}`);
          }
        }
      } catch (error) { diagnostics.push({ ...message('links', file, error), line: link.line, column: link.column }); }
    }
  }
  return { ok: !diagnostics.some(diagnostic => diagnostic.severity === 'error'), diagnostics };
};

export const lintDocuments = (options: ComposerOptions): LintResult => {
  try {
    const root = safeRoot(options.root);
    const files = markdownFiles(root, options.inputs, options.config);
    const documents = new Map(files.map(file => [file, fs.readFileSync(safePath(root, file), 'utf8')]));
    return lintVirtual(root, documents, files, options.config ?? {});
  } catch (error) { return { ok: false, diagnostics: [message('filesystem', '', error)] }; }
};

const metadataBlock = (data: Record<string, unknown>, format: 'comment' | 'frontmatter'): string => format === 'frontmatter' ? `---\n${stringify(data).trimEnd()}\n---` : `<!-- mdcomposer:meta\n${stringify(data).trimEnd()}\n-->`;
const addMetadata = (contents: string, file: string, config: ComposerConfig): string => {
  if (parseMetadata(contents).hasMetadata) return contents;
  const data: Record<string, unknown> = { title: titleOf(contents, file), audience: config.defaultAudience ?? 'internal', index: { include: path.basename(file) !== 'index.md' } };
  if (config.requiredMetadata?.includes('state')) data.state = 'draft';
  const block = metadataBlock(data, config.metadataFormat ?? 'comment');
  if (config.metadataFormat === 'frontmatter') return `${block}\n\n${contents.trimStart()}`;
  const heading = parseMarkdown(contents).children?.find(node => node.type === 'heading');
  if (!heading?.position) return `${block}\n\n${contents.trimStart()}`;
  const offset = heading.position.end.offset!;
  return `${contents.slice(0, offset)}\n\n${block}\n\n${contents.slice(offset).trimStart()}`;
};

export const planCompose = (options: ComposeOptions): ComposePlan => {
  const plan: ComposePlan = { format: 1, root: path.resolve(options.root), sources: {}, changes: [], diagnostics: [], operations: options.operations ?? ['include', 'embed', 'index'] };
  const config = options.config ?? {};
  try {
    plan.root = safeRoot(options.root);
    const root = plan.root;
    if (plan.operations.some(operation => !['include', 'embed', 'index', 'metadata'].includes(operation))) throw new Error('Unknown composition operation.');
    const originals = new Map<string, string>();
    const files = markdownFiles(root, options.inputs, config);
    const load = (file: string): string => {
      if (!originals.has(file)) {
        const absolute = safePath(root, file);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`Import does not exist: ${file}`);
        const bytes = fs.readFileSync(absolute);
        originals.set(file, bytes.toString('utf8'));
        plan.sources[file] = sha256(bytes);
      }
      return originals.get(file)!;
    };
    for (const file of files) load(file);
    const configuredRoots = config.roots?.length ? config.roots : ['.'];
    const ownerRoot = (file: string): string => configuredRoots.filter(candidate => inside(safePath(root, candidate), safePath(root, file))).sort((a, b) => b.length - a.length)[0] ?? '.';
    const expand = (file: string, stack: string[], wrap: boolean, section?: string): string => {
      if (stack.includes(file)) throw new Error(`Import cycle: ${[...stack, file].join(' -> ')}`);
      if (stack.length >= (config.maxDepth ?? 32)) throw new Error(`Import depth exceeds ${config.maxDepth ?? 32}.`);
      const original = normalize(load(file));
      let contents = stripImportPayloads(original);
      if (!wrap) contents = stripMachineContent(contents);
      if (section) {
        const entries = headings(contents);
        const index = entries.findIndex(entry => entry.slug === section);
        if (index < 0) throw new Error(`Missing heading fragment: ${file}#${section}`);
        const next = entries.slice(index + 1).find(entry => entry.depth <= entries[index].depth);
        const selected = contents.slice(entries[index].start, next?.start ?? contents.length).trimEnd();
        const definitions: string[] = [];
        visit(parseMarkdown(contents), node => { if (node.type === 'definition' && node.position) {
          const raw = contents.slice(node.position.start.offset!, node.position.end.offset!);
          if (!selected.includes(raw)) definitions.push(raw);
        } });
        contents = selected + (definitions.length ? `\n\n${definitions.join('\n')}` : '');
      }
      const replacements: { start: number; end: number; content: string }[] = [];
      let expandedBytes = Buffer.byteLength(contents, 'utf8');
      visit(parseMarkdown(contents), node => {
        if (node.type !== 'html' || !node.position) return;
        const directive = /^<!--\s*@(include|embed)\(([^)]+)\)\s*-->$/.exec(node.value?.trim() ?? '');
        if (!directive || !plan.operations.includes(directive[1] as Operation)) return;
        const start = node.position.start.offset!;
        const end = node.position.end.offset!;
        const lineStart = contents.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = contents.indexOf('\n', end);
        if (contents.slice(lineStart, start).trim() || contents.slice(end, lineEnd < 0 ? contents.length : lineEnd).trim()) throw new Error('Composition directives must occupy a standalone line.');
        const destination = directive[2].trim();
        if (!destination || destination.startsWith('/') || externalLink(destination)) throw new Error(`Import must be a relative Markdown path: ${destination}`);
        const parsed = splitLink(destination);
        if (parsed.query) throw new Error(`Import queries are not supported: ${destination}`);
        if (directive[1] === 'include' && parsed.fragment) throw new Error('Include accepts a complete Markdown file; use embed for a heading section.');
        const target = relativeTarget(root, file, destination);
        if (!target.file.toLowerCase().endsWith('.md')) throw new Error(`Import must target a Markdown file: ${destination}`);
        const source = load(target.file);
        if (audienceOf(original, config) === (config.publicAudience ?? 'public')) {
          if (audienceOf(source, config) !== (config.publicAudience ?? 'public')) throw new Error(`Public composition imports internal content: ${destination}`);
          if (config.publication?.requirePublicMarkerForCrossRoot && ownerRoot(file) !== ownerRoot(target.file)) {
            if (parseMetadata(source).data.audience !== (config.publicAudience ?? 'public')) throw new Error(`Public cross-root import requires explicit public audience metadata: ${destination}`);
            if (!hasPublicMarker(source)) throw new Error(`Public cross-root import requires <!-- @public -->: ${destination}`);
          }
        }
        const payload = rebaseMarkdownLinks(expand(target.file, [...stack, file], false, target.fragment || undefined), path.resolve(root, target.file), path.resolve(root, file), root).trim();
        const provenance = sha256(stripMachineContent(stripImportPayloads(normalize(source))));
        const content = wrap ? `${node.value?.trim()}\n<!-- mdcomposer:${directive[1]}:start source="${encodeURI(target.file)}" sha256="${provenance}" -->\n${payload}\n<!-- mdcomposer:${directive[1]}:end -->` : payload;
        expandedBytes += Buffer.byteLength(content, 'utf8') - Buffer.byteLength(contents.slice(start, end), 'utf8');
        if (expandedBytes > (config.maxExpansionBytes ?? 10 * 1024 * 1024)) throw new Error(`Expanded document exceeds ${config.maxExpansionBytes ?? 10 * 1024 * 1024} bytes.`);
        replacements.push({ start, end, content });
      });
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) contents = contents.slice(0, replacement.start) + replacement.content + contents.slice(replacement.end);
      if (Buffer.byteLength(contents, 'utf8') > (config.maxExpansionBytes ?? 10 * 1024 * 1024)) throw new Error(`Expanded document exceeds ${config.maxExpansionBytes ?? 10 * 1024 * 1024} bytes.`);
      return contents;
    };
    const documents = new Map<string, string>();
    for (const file of files) {
      try {
        let contents = plan.operations.some(operation => operation === 'include' || operation === 'embed') ? expand(file, [], true) : load(file);
        if (plan.operations.includes('metadata')) contents = addMetadata(contents, file, config);
        documents.set(file, contents);
      } catch (error) { plan.diagnostics.push(message('composition', file, error)); documents.set(file, load(file)); }
    }
    if (plan.operations.includes('index')) {
      const directories = new Set<string>();
      for (const file of files) {
        if (config.audience && config.audience !== 'all' && audienceOf(documents.get(file)!, config) !== config.audience) continue;
        const limit = path.resolve(root, ownerRoot(file));
        let directory = path.dirname(path.resolve(root, file));
        while (inside(limit, directory)) {
          directories.add(posix(path.relative(root, directory)) || '.');
          if (directory === limit) break;
          directory = path.dirname(directory);
        }
      }
      for (const directory of [...directories].sort((a, b) => b.length - a.length || a.localeCompare(b, 'en'))) {
        const index = posix(path.join(directory, 'index.md')).replace(/^\.\//, '');
        const existing = documents.get(index) ?? (fs.existsSync(safePath(root, index)) ? load(index) : undefined);
        const children = [...documents.keys()].filter(file => posix(path.dirname(file)) === directory.replace(/^\.\//, '') || (directory === '.' && path.dirname(file) === '.')).filter(file => file !== index);
        const subdirectories = [...directories].filter(candidate => candidate !== directory && posix(path.dirname(candidate)) === directory);
        const rootPath = path.resolve(root, ownerRoot(index));
        const up = posix(path.relative(path.resolve(root, directory), path.dirname(path.resolve(root, directory))));
        const home = posix(path.relative(path.resolve(root, directory), rootPath));
        const lines: string[] = [];
        if (path.resolve(root, directory) !== rootPath) lines.push('## Navigation', '', `- [Home](${home ? `${home}/` : './'}index.md)`, `- [Up](${up || '.'}/index.md)`, '');
        const allowedChildren = children.filter(file => !config.audience || config.audience === 'all' || audienceOf(documents.get(file)!, config) === config.audience).filter(file => (parseMetadata(documents.get(file)!).data.index as Record<string, unknown> | undefined)?.include !== false);
        const descendantAudiences = [...documents].filter(([file]) => file !== index && inside(path.resolve(root, directory), path.resolve(root, file))).map(([, content]) => audienceOf(content, config));
        const indexAudience = config.audience && config.audience !== 'all' ? config.audience : descendantAudiences.length > 0 && descendantAudiences.every(audience => audience === (config.publicAudience ?? 'public')) ? (config.publicAudience ?? 'public') : (config.defaultAudience ?? 'internal');
        if (subdirectories.length) lines.push('## Subdirectories', '', ...subdirectories.sort().map(child => `- [${path.basename(child).replace(/[-_]/g, ' ')}](./${encodeURI(path.basename(child))}/index.md)`), '');
        if (allowedChildren.length) lines.push('## Pages', '', ...allowedChildren.sort().map(file => `- [${titleOf(documents.get(file)!, file).replace(/\[/g, '\\[').replace(/\]/g, '\\]')}](./${encodeURI(path.basename(file)).replace(/[()]/g, value => `%${value.charCodeAt(0).toString(16)}`)})`), '');
        const block = `<!-- mdcomposer:index:start -->\n\n${lines.length ? lines.join('\n').trimEnd() : '_No Markdown pages._'}\n\n<!-- mdcomposer:index:end -->`;
        try {
          if (existing !== undefined) {
            const regions = managedRegions(existing, ['index']);
            if (regions.length > 1) throw new Error('An index document may have only one generated index block.');
            if (regions.length) {
              const updated = `${existing.slice(0, regions[0].start).trimEnd()}\n\n${block}${existing.slice(regions[0].end).trim() ? `\n\n${existing.slice(regions[0].end).trim()}` : ''}\n`;
              documents.set(index, addMetadata(updated, index, { ...config, defaultAudience: indexAudience }));
            }
          } else {
            let created = `# ${directory === '.' ? 'Documentation index' : path.basename(directory).replace(/[-_]/g, ' ')}\n\n${block}\n`;
            created = addMetadata(created, index, { ...config, defaultAudience: indexAudience });
            documents.set(index, created);
          }
        } catch (error) { plan.diagnostics.push(message('index', index, error)); }
      }
      for (const file of files.filter(file => path.basename(file) !== 'index.md')) {
        try {
          const contents = documents.get(file)!;
          const regions = managedRegions(contents, ['nav']);
          if (regions.length > 1) throw new Error('A document may have only one generated navigation block.');
          const relativeHome = posix(path.relative(path.dirname(path.resolve(root, file)), path.resolve(root, ownerRoot(file))));
          const block = `<!-- mdcomposer:nav:start -->\n[Home](${relativeHome ? `${relativeHome}/` : './'}index.md) | [Up](./index.md)\n<!-- mdcomposer:nav:end -->`;
          if (regions.length) documents.set(file, `${contents.slice(0, regions[0].start).trimEnd()}\n\n${block}${contents.slice(regions[0].end).trim() ? `\n\n${contents.slice(regions[0].end).trim()}` : ''}\n`);
          else {
            const heading = parseMarkdown(contents).children?.find(node => node.type === 'heading');
            const end = heading?.position?.end.offset ?? 0;
            documents.set(file, `${contents.slice(0, end).trimEnd()}${end ? '\n\n' : ''}${block}\n\n${contents.slice(end).trim()}\n`.replace(/\n+$/, '\n'));
          }
        } catch (error) { plan.diagnostics.push(message('navigation', file, error)); }
      }
    }
    plan.diagnostics.push(...lintVirtual(root, documents, [...documents.keys()], config, load).diagnostics);
    const projected = new Map<string, string>();
    const outputTargets = options.outputDir ? Object.fromEntries([...documents.keys()].map(file => [path.resolve(root, file), path.resolve(root, options.outputDir!, file)])) : undefined;
    for (const [file, contents] of documents) {
      const destination = options.outputDir ? posix(path.join(options.outputDir, file)) : file;
      const absolute = safePath(root, destination);
      if (options.outputDir && inside(path.resolve(root, options.outputDir), path.resolve(root, file))) throw new Error('Output directory overlaps composition inputs.');
      const relocated = options.outputDir ? rebaseMarkdownLinks(contents, path.resolve(root, file), absolute, root, outputTargets) : contents;
      projected.set(destination, relocated);
      const before = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
      if (before !== relocated) plan.changes.push({ path: destination, beforeHash: before === undefined ? null : sha256(fs.readFileSync(absolute)), content: relocated });
    }
    if (options.outputDir) plan.diagnostics.push(...lintVirtual(root, new Map([...documents, ...projected]), [...projected.keys()], config, load).diagnostics);
    plan.changes.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  } catch (error) { plan.diagnostics.push(message('filesystem', '', error)); }
  return plan;
};

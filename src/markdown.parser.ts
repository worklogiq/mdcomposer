import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parse, postprocess, preprocess } from 'micromark';
import GithubSlugger from 'github-slugger';
import { parseDocument } from 'yaml';
import type { Diagnostic, MarkdownLink, MetadataResult } from './composer.types.js';
import { posix } from './filesystem.util.js';

export interface AstNode {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  depth?: number;
  children?: AstNode[];
  position?: { start: { offset?: number; line: number; column: number }; end: { offset?: number; line: number; column: number } };
}
export const parseMarkdown = (contents: string): AstNode => fromMarkdown(contents) as unknown as AstNode;
export const visit = (node: AstNode, callback: (node: AstNode) => void): void => {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
};
export const nodeText = (node: AstNode): string => node.value ?? (node.children ?? []).map(nodeText).join('');

export const headings = (contents: string, tree?: AstNode): { slug: string; depth: number; start: number; end: number }[] => {
  const slugger = new GithubSlugger();
  const result: { slug: string; depth: number; start: number; end: number }[] = [];
  visit(tree ?? parseMarkdown(contents), node => {
    if (node.type === 'heading' && node.position) result.push({ slug: slugger.slug(nodeText(node)), depth: node.depth!, start: node.position.start.offset!, end: node.position.end.offset! });
  });
  return result;
};
export const headingSlugs = (contents: string, tree?: AstNode): Set<string> => new Set(headings(contents, tree).map(heading => heading.slug));

export const parseMetadata = (contents: string, tree?: AstNode): MetadataResult => {
  const normalized = contents.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const issues: string[] = [];
  const data: Record<string, unknown> = {};
  const blocks: string[] = [];
  if (normalized.startsWith('---\n')) {
    const delimiter = /^---[ \t]*(?=\n|$)/gm;
    delimiter.lastIndex = 4;
    const end = delimiter.exec(normalized);
    if (!end) issues.push('Frontmatter metadata block is incomplete.');
    else blocks.push(normalized.slice(4, end.index));
  }
  const marker = '<!-- mdcomposer:meta';
  const comments: AstNode[] = [];
  visit(tree ?? parseMarkdown(normalized), node => { if (node.type === 'html' && node.value?.trimStart().startsWith(marker)) comments.push(node); });
  if (comments.length) {
    const comment = comments[0].value!;
    const start = comment.indexOf(marker);
    const body = comment.indexOf('\n', start);
    const end = comment.indexOf('-->', start);
    if (body < 0 || end < body) issues.push('Comment metadata block is incomplete.');
    else blocks.push(comment.slice(body + 1, end));
    if (comments.length > 1) issues.push('Multiple mdcomposer metadata blocks are not allowed.');
  }
  if (!blocks.length) {
    const status = /^##[ \t]+Status[ \t]*$/im.exec(normalized);
    if (status) {
      const lines = normalized.slice(status.index + status[0].length).split('\n');
      const end = lines.findIndex(line => /^##\s|^---\s*$/.test(line));
      const fields = lines.slice(0, end < 0 ? undefined : end).flatMap(line => {
        const match = /^\s*-?\s*([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
        if (!match) return [];
        const inlineCode = /^(`+)([\s\S]*?)\1$/.exec(match[2]);
        const value = inlineCode ? inlineCode[2] : match[2];
        return [`${JSON.stringify(match[1])}: ${JSON.stringify(value)}`];
      });
      if (fields.length) blocks.push(fields.join('\n'));
    }
  }
  for (const block of blocks) {
    try {
      const document = parseDocument(block, { uniqueKeys: true });
      issues.push(...document.errors.map(error => error.message));
      const parsed: unknown = document.toJS({ maxAliasCount: 100 });
      if (parsed === null && !block.trim()) continue;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { issues.push('Metadata must be a mapping.'); continue; }
      for (const [key, value] of Object.entries(parsed)) {
        if (Object.prototype.hasOwnProperty.call(data, key)) issues.push(`Metadata key is defined in both comment and frontmatter: ${key}`);
        Object.defineProperty(data, key, { value, enumerable: true, configurable: true });
      }
    } catch (error) { issues.push((error as Error).message); }
  }
  return { data, hasMetadata: blocks.length > 0, issues };
};

export const validateMetadata = (contents: string, requiredFields: string[] = [], parsed = parseMetadata(contents)): Diagnostic[] => {
  const diagnostics: Diagnostic[] = parsed.issues.map(message => ({ ruleId: 'metadata', severity: 'error', message }));
  for (const field of requiredFields) {
    const value = field.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, parsed.data);
    if (value === undefined || value === null || value === '') diagnostics.push({ ruleId: 'metadata', severity: 'error', message: `Missing required metadata: ${field}` });
  }
  return diagnostics;
};

const referenceId = (identifier: string): string => identifier.toLowerCase().replace(/\s+/g, ' ');
export const extractMarkdownLinks = (contents: string, tree = parseMarkdown(contents)): MarkdownLink[] => {
  const definitions = new Map<string, string>();
  visit(tree, node => { if (node.type === 'definition') definitions.set(referenceId(node.identifier!), node.url!); });
  const result: MarkdownLink[] = [];
  visit(tree, node => {
    if (!node.position) return;
    const position = { line: node.position.start.line, column: node.position.start.column, start: node.position.start.offset!, end: node.position.end.offset! };
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') result.push({ destination: node.url!, kind: node.type as MarkdownLink['kind'], ...position });
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const id = referenceId(node.identifier!);
      const destination = definitions.get(id);
      result.push({ destination: destination ?? '', kind: 'reference', ...position, ...(destination === undefined ? { unresolvedReference: id } : {}) });
    }
    if (node.type === 'text') {
      const raw = contents.slice(position.start, position.end);
      for (const match of raw.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
        const before = raw.slice(0, match.index);
        const slashes = /\\*$/.exec(before)?.[0].length ?? 0;
        if (slashes % 2) continue;
        const id = referenceId(match[2] || match[1]);
        if (definitions.has(id)) continue;
        const start = position.start + match.index!;
        const preceding = contents.slice(0, start).split('\n');
        result.push({ destination: '', kind: 'reference', line: preceding.length, column: preceding.at(-1)!.length + 1, start, end: start + match[0].length, unresolvedReference: id });
      }
    }
  });
  return result;
};

export const externalLink = (url: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
export const splitLink = (url: string): { pathname: string; fragment: string; query: string } => {
  const hash = url.indexOf('#');
  const withoutHash = hash >= 0 ? url.slice(0, hash) : url;
  const queryIndex = withoutHash.indexOf('?');
  return { pathname: queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash, query: queryIndex >= 0 ? withoutHash.slice(queryIndex) : '', fragment: hash >= 0 ? url.slice(hash + 1) : '' };
};
export const decodePath = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };

const destinationRanges = (contents: string): { start: number; end: number }[] => {
  const events = postprocess(parse().document().write(preprocess()(contents, undefined, true)));
  return events.flatMap(([event, token]) => event === 'enter' && ['resourceDestinationString', 'definitionDestinationString'].includes(token.type) && token.start.offset !== undefined && token.end.offset !== undefined ? [{ start: token.start.offset, end: token.end.offset }] : []);
};

export const rebaseMarkdownLinks = (contents: string, sourceFile: string, destinationFile: string, root?: string, targets?: Record<string, string>): string => {
  const changes: { start: number; end: number; value: string }[] = [];
  const ranges = destinationRanges(contents);
  for (const link of extractMarkdownLinks(contents)) {
    if (link.kind === 'reference' || externalLink(link.destination)) continue;
    const parts = splitLink(link.destination);
    const range = ranges.filter(candidate => candidate.start >= link.start && candidate.end <= link.end).at(-1);
    if (!range) continue;
    const originalTarget = parts.pathname.startsWith('/') && root ? path.resolve(root, `.${decodePath(parts.pathname)}`) : parts.pathname ? path.resolve(path.dirname(sourceFile), decodePath(parts.pathname)) : sourceFile;
    const target = targets?.[originalTarget] ?? originalTarget;
    let relative = posix(path.relative(path.dirname(destinationFile), target));
    if (!relative.startsWith('.')) relative = `./${relative}`;
    const value = encodeURI(relative).replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) + parts.query + (parts.fragment ? `#${parts.fragment}` : '');
    changes.push({ start: range.start, end: range.end, value });
  }
  let output = contents;
  for (const change of changes.sort((a, b) => b.start - a.start)) output = output.slice(0, change.start) + change.value + output.slice(change.end);
  return output;
};

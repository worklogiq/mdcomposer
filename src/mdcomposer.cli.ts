#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { applyChanges, lintDocuments, planCompose, validateMetadata } from './index.js';
import { markdownFiles, safeRoot, safePath, sha256 } from './filesystem.util.js';
import type { ComposerConfig, ComposePlan, Diagnostic, Operation } from './composer.types.js';

const help = `mdcomposer — portable Markdown tooling

Usage: mdcomposer <command> --root PATH [options]

Commands:
  compose                  Expand imports, generate indexes/navigation, validate.
  index                    Generate directory indexes and Home/Up navigation.
  include                  Expand whole-document @include directives.
  embed                    Expand @embed directives, optionally selecting #heading.
  lint [links|metadata|all] Read-only link, heading, audience and metadata checks.
  metadata init            Add missing metadata blocks with draft defaults.
  plan                     Print a JSON composition plan without writing.
  apply --plan FILE        Apply a previously reviewed JSON plan.
  export-skill --output DIR  Export a standalone skill with bundled CLI.

Options:
  --root PATH              Explicit consumer repository root (required for docs).
  --input PATH             Relative file/directory/glob; repeat to select inputs.
  --config FILE            JSON ComposerConfig, relative to root unless absolute.
  --out DIR                Stage generated Markdown under a relative directory.
  --output-plan FILE       Write a new JSON plan file; refuses differing files.
  --format comment|frontmatter  Metadata initialization format.
  --audience all|public|internal  Select audience for indexes/navigation.
  --dry-run, -n            Preview the complete validated plan; write nothing.
  --json                   Emit structured JSON results and diagnostics.
  --help, -h               Show this help without operating on documents.

Exit codes: 0 success, 1 validation/refusal, 2 invalid arguments.
No command installs packages, executes target code, performs Git operations,
or accesses the network. Runtime: Node 20.19+; Node 24 LTS recommended.
`;

class ArgumentError extends Error {}
const parseOptions = (args: string[]): { values: Record<string, string>; inputs: string[]; flags: Set<string>; positional: string[] } => {
  const values: Record<string, string> = {};
  const inputs: string[] = [];
  const flags = new Set<string>();
  const positional: string[] = [];
  const allowedValues = new Set(['root', 'input', 'config', 'out', 'output-plan', 'format', 'audience', 'output', 'plan']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (['--json', '--dry-run', '-n', '--help', '-h'].includes(argument)) { flags.add(argument); continue; }
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    const equal = argument.indexOf('=');
    const key = argument.slice(2, equal < 0 ? undefined : equal);
    if (!allowedValues.has(key)) throw new ArgumentError(`Unknown option: ${argument}`);
    const value = equal < 0 ? args[++index] : argument.slice(equal + 1);
    if (!value || value.startsWith('--')) throw new ArgumentError(`Missing value for --${key}`);
    if (key === 'input') inputs.push(value); else values[key] = value;
  }
  return { values, inputs, flags, positional };
};

const exportSkill = (output: string, dryRun: boolean): ComposePlan => {
  const packageRoot = path.resolve(__dirname, '..');
  const source = path.join(packageRoot, 'skills', 'mdcomposer');
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error('Export from the installed npm package or source checkout; the standalone skill is already an export.');
  const destination = path.resolve(output);
  let existingParent = destination;
  while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
  const root = safeRoot(existingParent);
  const planned: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Skill sources must not contain symlinks.');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) planned[path.relative(source, absolute)] = fs.readFileSync(absolute, 'utf8');
    }
  };
  visit(source);
  planned['scripts/mdcomposer.cli.cjs'] = fs.readFileSync(path.join(packageRoot, 'dist/mdcomposer.cli.cjs'), 'utf8');
  const notices = path.join(packageRoot, 'dist/mdcomposer.cli.cjs.LEGAL.txt');
  if (fs.existsSync(notices)) planned['scripts/mdcomposer.cli.cjs.LEGAL.txt'] = fs.readFileSync(notices, 'utf8');
  const thirdParty = path.join(packageRoot, 'dist/THIRD-PARTY-NOTICES.txt');
  if (fs.existsSync(thirdParty)) planned['scripts/THIRD-PARTY-NOTICES.txt'] = fs.readFileSync(thirdParty, 'utf8');
  planned.LICENSE = fs.readFileSync(path.join(packageRoot, 'LICENSE'), 'utf8');
  planned['assets/manifest.json'] = JSON.stringify({ package: '@worklogiq/mdcomposer', version: '0.1.0', files: Object.fromEntries(Object.entries(planned).map(([file, content]) => [file.replace(/\\/g, '/'), sha256(content)])) }, null, 2) + '\n';
  const plan: ComposePlan = { format: 1, root, sources: {}, changes: [], diagnostics: [], operations: [] };
  for (const [relative, content] of Object.entries(planned)) {
    const file = path.relative(root, path.join(destination, relative)).replace(/\\/g, '/');
    const target = safePath(root, file);
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isFile() || fs.readFileSync(target, 'utf8') !== content) throw new Error(`Export conflict: ${file}`);
    } else plan.changes.push({ path: file, beforeHash: null, content });
  }
  if (!dryRun) applyChanges(plan);
  return plan;
};

const display = (value: unknown, json: boolean): void => {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  const result = value as { diagnostics?: Diagnostic[]; changes?: unknown[]; ok?: boolean; changed?: string[] };
  for (const diagnostic of result.diagnostics ?? []) console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.path ?? ''}${diagnostic.line ? `:${diagnostic.line}` : ''} [${diagnostic.ruleId}] ${diagnostic.message}`);
  console.log(result.changes ? `${result.changes.length} planned file change(s).` : result.changed ? `${result.changed.length} file(s) changed.` : result.ok ? 'Markdown checks passed.' : 'Markdown checks failed.');
};

const main = (): void => {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  let json = args.includes('--json');
  try {
    const command = args.shift()!;
    const { values, inputs, flags, positional } = parseOptions(args);
    json = flags.has('--json');
    const dryRun = flags.has('--dry-run') || flags.has('-n');
    if (command === 'export-skill') {
      if (!values.output) throw new ArgumentError('export-skill requires --output DIR.');
      display(exportSkill(values.output, dryRun), json); return;
    }
    if (command === 'apply') {
      if (!values.plan) throw new ArgumentError('apply requires --plan FILE.');
      const plan = JSON.parse(fs.readFileSync(values.plan, 'utf8')) as ComposePlan;
      if (values.root && path.resolve(values.root) !== plan.root) throw new Error('Plan root does not match --root.');
      if (dryRun) display(plan, json); else display(applyChanges(plan), json);
      return;
    }
    if (!['compose', 'index', 'include', 'embed', 'lint', 'metadata', 'plan'].includes(command)) throw new ArgumentError(`Unknown command: ${command}`);
    if (!values.root) throw new ArgumentError('An explicit --root PATH is required.');
    const root = safeRoot(values.root);
    const config: ComposerConfig = values.config ? JSON.parse(fs.readFileSync(path.resolve(root, values.config), 'utf8')) : {};
    if (values.format) {
      if (!['comment', 'frontmatter'].includes(values.format)) throw new ArgumentError('Format must be comment or frontmatter.');
      config.metadataFormat = values.format as 'comment' | 'frontmatter';
    }
    if (values.audience) {
      if (!['all', 'public', 'internal'].includes(values.audience)) throw new ArgumentError('Audience must be all, public or internal.');
      config.audience = values.audience as ComposerConfig['audience'];
    }
    if (command === 'lint') {
      const check = positional[0] ?? 'all';
      if (!['links', 'metadata', 'all'].includes(check) || positional.length > 1) throw new ArgumentError('Lint target must be links, metadata or all.');
      const diagnostics = check === 'metadata' ? markdownFiles(root, inputs.length ? inputs : undefined, config).flatMap(file => validateMetadata(fs.readFileSync(safePath(root, file), 'utf8'), config.requiredMetadata).map(diagnostic => ({ ...diagnostic, path: file }))) : lintDocuments({ root, inputs: inputs.length ? inputs : undefined, config: check === 'links' ? { ...config, requiredMetadata: [] } : config }).diagnostics;
      const result = { ok: !diagnostics.some(diagnostic => diagnostic.severity === 'error'), diagnostics };
      display(result, json); if (!result.ok) process.exitCode = 1; return;
    }
    if (command === 'metadata' && (positional[0] !== 'init' || positional.length !== 1)) throw new ArgumentError('Use metadata init.');
    if (command !== 'metadata' && positional.length) throw new ArgumentError(`Unexpected argument: ${positional[0]}`);
    const operations: Operation[] = command === 'metadata' ? ['metadata'] : ['compose', 'plan'].includes(command) ? ['include', 'embed', 'index'] : [command as Operation];
    const plan = planCompose({ root, inputs: inputs.length ? inputs : undefined, config, operations, outputDir: values.out });
    if (values['output-plan'] && !dryRun) {
      const target = safePath(root, values['output-plan']);
      const content = JSON.stringify(plan, null, 2) + '\n';
      applyChanges({ format: 1, root, sources: {}, changes: fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content ? [] : [{ path: values['output-plan'], beforeHash: null, content }], diagnostics: [], operations: [] });
    }
    if (dryRun || command === 'plan' || plan.diagnostics.some(diagnostic => diagnostic.severity === 'error')) display(plan, json || command === 'plan');
    else display({ ...applyChanges(plan), diagnostics: plan.diagnostics }, json);
    if (plan.diagnostics.some(diagnostic => diagnostic.severity === 'error')) process.exitCode = 1;
  } catch (error) {
    if (json) console.log(JSON.stringify({ ok: false, diagnostics: [{ ruleId: error instanceof ArgumentError ? 'arguments' : 'refusal', severity: 'error', message: (error as Error).message }] }, null, 2));
    else console.error((error as Error).message);
    process.exitCode = error instanceof ArgumentError ? 2 : 1;
  }
};
main();

# mdcomposer

Portable Markdown composition and validation, extracted from MenuLogiq and maintained by WorkLogiq. Use it independently or through Constitutional Dev.

## What is this?

`@worklogiq/mdcomposer` provides a TypeScript library and CLI for directory indexes, Home/Up navigation, metadata, local links and heading fragments, and whole-document or section imports. Repository policy comes from consumer configuration; it does not assume a programming language, application stack, or MenuLogiq directory layout.

## How to run locally

Use Node 24 LTS for development. Published JavaScript also supports Node 20.19, 22, 24 and 26; Node 20 compatibility preserves existing consumers and is not a recommendation for new deployments.

```sh
npm ci
npm run check
node dist/mdcomposer.cli.cjs --help
node dist/mdcomposer.cli.cjs lint --root /path/to/repository
node dist/mdcomposer.cli.cjs compose --root /path/to/repository --input docs --dry-run
```

After publication, install `@worklogiq/mdcomposer` as a development dependency and use `npx mdcomposer`. No postinstall hooks run. Generation plans and checks do not use the network, execute application code, or operate Git.

## Canonical documentation

- [Composition and configuration](skills/mdcomposer/references/composition.guide.md)
- [Extraction provenance and verification boundaries](docs/internal/dev/mdcomposer-provenance.overview.md)
- [Agent skill](skills/mdcomposer/SKILL.md)
- [MIT license](LICENSE)

## Library

```js
import { lintDocuments, planCompose, applyChanges } from '@worklogiq/mdcomposer';

const result = lintDocuments({ root: '/path/to/repository', config: { roots: ['docs'] } });
const plan = planCompose({ root: '/path/to/repository', config: { roots: ['docs'] } });
if (!plan.diagnostics.some(item => item.severity === 'error')) applyChanges(plan);
```

CommonJS `require('@worklogiq/mdcomposer')` exposes the same API. Both builds bundle parser dependencies. Type declarations describe the configuration, diagnostics, and serializable plan. `parseMetadata`, `validateMetadata`, `extractMarkdownLinks`, `rebaseMarkdownLinks`, `headings`, `headingSlugs`, `splitLink`, `decodePath`, and `externalLink` are also exported.

`applyChanges` preflights every destination and source hash before writing. A validation failure leaves all files unchanged. An operating-system failure during writes may leave a partially applied plan; this library does not promise transactional rollback. Constitutional Dev adds its own migration journal where needed.

## Standalone skill

```sh
npm run build
node dist/mdcomposer.cli.cjs export-skill --output /path/to/skills/mdcomposer --dry-run
node dist/mdcomposer.cli.cjs export-skill --output /path/to/skills/mdcomposer
```

The export contains the skill, references, bundled CLI, provenance manifest and licenses. It works after relocation without this checkout, npm installation, or network access. It still requires a compatible Node runtime. Place it in your agent's supported skill directory; exporting does not change agent settings.

## Contributing

Use a branch and preserve behavior with independently meaningful fixtures. Update command help and owning documentation with interface changes. Run `npm run check` and inspect `npm pack --dry-run`. Do not edit generated distributions as source. Report the scope of actual checks rather than claiming semantic or agent compliance from file/link validation.

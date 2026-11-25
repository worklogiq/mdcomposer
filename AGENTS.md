# mdcomposer contributor instructions

Read the [composition contract](skills/mdcomposer/references/composition.guide.md) and [provenance](docs/internal/dev/mdcomposer-provenance.overview.md) relevant to the task.

Preserve manual prose and metadata, explicit consumer roots, local-only execution, preview behavior, source-hash checks and whole-plan conflict preflight. Parser correctness must cover actual Markdown AST behavior, including reference links and heading fragments. Keep policy vocabularies and application paths in consumer configuration.

Source files use descriptive role suffixes, documents use `<topic>.<doc-kind>.md`, and host-defined names such as `AGENTS.md`, `SKILL.md`, `README.md`, `index.ts` and package manifests retain their required spelling.

Run `npm run check` for code changes. Check maintained Markdown links with `node dist/mdcomposer.cli.cjs lint --root . --input README.md --input AGENTS.md --input docs --input skills`. Exercise changed commands and refusal paths. Publishing, merging, and pushing to main require explicit task authorization.

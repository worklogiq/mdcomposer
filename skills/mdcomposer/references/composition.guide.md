# Markdown composition and configuration

<!-- mdcomposer:meta
title: Markdown composition and configuration
state: draft
audience: public
owner: WorkLogiq
-->

## Commands and library

The CLI requires an explicit `--root PATH` for document work. Select relative files, directories or globs with repeated `--input`; supported glob operators are `*`, `**` and `?`. `--config FILE` loads declarative JSON. Use `--help` for every supported option.

- `compose`: include, embed, indexes/navigation and final validation.
- `index`, `include`, `embed`: targeted generation followed by validation.
- `lint links|metadata|all`: read-only diagnostics.
- `metadata init`: add missing comment or YAML frontmatter metadata; existing metadata is retained.
- `plan`: emit a JSON composition plan. `--output-plan FILE` saves a new plan file, refusing differing existing content; `--dry-run` writes nothing.
- `apply --plan FILE`: preflight and apply a reviewed plan. Optional `--root` must match its recorded root.
- `export-skill --output DIR`: preflight and export a self-contained skill. Identical files are reused and differing files refuse before writes.

`lintDocuments({root,inputs?,config?})` returns `{ok,diagnostics}`. `planCompose({root,inputs?,config?,outputDir?,operations?})` returns a JSON-serializable format-1 plan with `root`, source hashes, planned changes, operations and diagnostics. Operations are `include`, `embed`, `index` and `metadata`; default composition runs the first three. A planned change contains a relative `path`, `beforeHash` or null for a new file, and UTF-8 `content`. `applyChanges(plan)` refuses any error diagnostic or stale source/destination before writing. No function executes repository code or performs Git/network operations.

Diagnostic fields are `ruleId`, `severity`, `message`, and optional relative `path`, `line` and `column`. Library calls do not print or terminate the process. CLI exits are 0 success, 1 validation/refusal, 2 argument errors.

## Configuration

```json
{
  "roots": ["docs/internal", "docs/public"],
  "ignore": ["docs/internal/_archive/**", "**/templates/**"],
  "audience": "all",
  "defaultAudience": "internal",
  "requiredMetadata": ["title", "state", "audience"],
  "metadataFormat": "comment",
  "publicAudience": "public",
  "publication": {"requirePublicMarkerForCrossRoot": true},
  "maxDepth": 32,
  "maxExpansionBytes": 10485760
}
```

Roots and output directories are relative to the consumer root. Defaults are root `.`, no required metadata fields, audience `all`, missing audience `internal`, comment metadata, depth 32 and 10 MiB expanded Markdown per destination. `.git`, `node_modules`, `dist` and `coverage` are ignored. No global configuration or installation-relative project root is used.

Consumers own lifecycle enums, filename kinds, acceptance, archive policy and application-specific layout. A required field check only establishes its presence. Missing values that cannot be inferred remain diagnostics; metadata initialization never marks documents accepted. Legacy `## Status` fields are readable when no canonical comment/frontmatter metadata exists.

## Include and embed

Directives occupy a standalone HTML-comment line outside code fences:

```md
<!-- @include(./shared-document.md) -->
<!-- @embed(./shared-document.md) -->
<!-- @embed(./shared-document.md#section-slug) -->
```

Include copies the complete document body. Embed without a fragment also copies the body for MenuLogiq syntax compatibility. With a fragment, embed copies the selected heading and subsequent content until the next heading of equal or higher rank. Heading IDs use GitHub-style duplicate suffixes. Heading levels remain unchanged.

Imported frontmatter, mdcomposer metadata and generated navigation/index blocks are removed. Ordinary prose, headings and code remain. Imports expand recursively; cycles, missing targets, missing sections, invalid markers, external imports, non-Markdown files and paths outside the root fail before applying changes. Expansion depth/size bounds are configurable. Imports do not execute templates or scripts.

Relative links, reference definitions and images are rebased from the original source to the destination. Concrete Markdown destination tokens identify what to replace, so titles and code-formatted labels remain unchanged even when they contain resource-like punctuation. The rebasing helper also updates real standalone include/embed directive targets when authoring documents move or their targets are renamed, retaining heading fragments. Fenced examples, inline/commented examples and managed provenance attributes remain unchanged. Source-local fragments retain their original referent by becoming source-document links. A section excerpt also carries reference definitions needed from its source; conflicting duplicate reference labels are diagnostics rather than silently changing their referent.

Author directives remain in in-place output, followed by managed start/end markers containing the canonical source path and SHA-256 provenance. Only the generated region is refreshed on later runs. Malformed marker pairs fail. Dry-run plans consider all projected generated files, including new indexes. Complete generation is byte-idempotent.

`outputDir` stages generated Markdown under another contained directory and leaves authoring files untouched. References among staged Markdown files point to their staged counterparts. References to assets outside that selected set remain valid relative references to the originals; a publisher is responsible for packaging those assets too.

## Audience and validation

Public documents cannot link to or import internal Markdown. When cross-root public-marker policy is enabled, public imports from a different configured root require explicit public metadata and a real `<!-- @public -->` HTML marker outside code. Final composed content is checked too. Generated prose does not confer publication authorization.

Link validation parses Markdown rather than scanning fenced examples. It checks inline/reference links, images, local files, heading fragments, encoded filenames and duplicate heading IDs. Existing directory links are valid without requiring an index; when a directory has an actual or planned `index.md` or an actual `README.md`, that document supplies its heading/audience checks. A directory fragment with neither document is diagnosed. Empty YAML frontmatter is a valid empty mapping. Legacy visible Status scalar values retain their Markdown text meaning, including inline-backtick values; canonical YAML metadata remains strictly parsed. Remote links are intentionally not fetched. Raw HTML links and renderer-specific custom anchors are outside this version's Markdown-link contract.

## Safety and recovery

Source and destination containment and symlink/junction checks happen before application. All source and destination hashes are preflighted before the first file write. Existing manual indexes are preserved; generated index blocks retain surrounding authored prose.

Expected validation/refusal failures write nothing. An OS error during writes can leave a partially applied plan. mdcomposer does not promise transactional rollback; use a backed-up workspace or a migration host with journaling for large reorganizations.

## Standalone skill distribution

Export from the source checkout or installed npm package. The export carries the skill, this guide, bundled CLI, licenses and asset hashes. Run its helper with `node scripts/mdcomposer.cli.cjs`; no source checkout or npm download is needed after relocation. The exported skill cannot export itself again because canonical packaging metadata belongs to the source package.

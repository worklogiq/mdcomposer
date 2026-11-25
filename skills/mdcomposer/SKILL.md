---
name: mdcomposer
description: Compose and validate repository Markdown with generated navigation, metadata, whole-document includes, heading-section embeds, and local-reference checks. Use for mdcomposer workflows or repositories configured to use it.
---

# mdcomposer

Read the repository's existing instructions and identify its document roots and conventions before generating content. Use its configured metadata and audience policy; this tool supplies Markdown mechanics rather than development-methodology rules.

For imports, generated blocks, configuration or packaging, read the [composition guide](references/composition.guide.md). Use the bundled CLI at `scripts/mdcomposer.cli.cjs` in an exported skill. From the source checkout or npm package, use `dist/mdcomposer.cli.cjs`; build the checkout first.

Run read-only checks or preview the full operation using `--root PATH` and `--dry-run`. Review diagnostics and intended file changes, then apply within the user's authorized scope. Preserve manual indexes, authored prose, metadata and existing approval records. Fix source content or configuration instead of weakening an expected result to obtain a passing check.

Includes and embeds may expose source content. Check the configured audience rules and final composed references. Missing metadata defaults to internal. A path under a public directory does not itself authorize publication.

The CLI does not install packages, operate Git, contact services or execute target application code. Exporting this skill does not install or activate it. Report actual checks and unresolved diagnostics; Markdown checks do not establish application correctness or that an agent followed instructions.

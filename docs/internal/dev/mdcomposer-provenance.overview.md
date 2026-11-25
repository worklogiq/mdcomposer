# mdcomposer extraction provenance

<!-- mdcomposer:meta
title: mdcomposer extraction provenance
state: draft
audience: public
owner: WorkLogiq
-->

MenuLogiq supplied the starting behavior for Markdown indexes/navigation, metadata and file-link validation. This standalone package generalizes its repository roots and policy assumptions and implements the previously empty include/embed operations. It is a documentation tool, not an application runtime component.

The extracted implementation preserves generated-block/manual-index behavior and adds heading-fragment checking, structured plans, stale-source refusal, first-run idempotence and relocation tests. MenuLogiq tracking context includes [outside-root link checking](https://github.com/worklogiq/menulogiq/issues/122) and [fixture-based tooling tests](https://github.com/worklogiq/menulogiq/issues/124). Those issue references describe related work; they are not evidence that every issue is closed.

The public package contains generic Markdown mechanics. MenuLogiq application code, seeds, deployment settings, private runtime data and operational credentials are excluded. Consumer metadata/vocabulary policies are supplied through configuration.

Behavioral fixtures cover real temporary files and CLI execution. Structural checks and test results support only exercised behavior; they do not validate application semantics, publication suitability, or agent compliance. CI targets Windows and Linux with Node 20, 22, 24 and 26. Local checks report the host actually exercised rather than claiming unrun matrix jobs passed.

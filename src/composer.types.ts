export interface Diagnostic {
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  line?: number;
  column?: number;
}
export interface ComposerConfig {
  roots?: string[];
  ignore?: string[];
  audience?: 'all' | 'public' | 'internal';
  defaultAudience?: string;
  requiredMetadata?: string[];
  metadataFormat?: 'comment' | 'frontmatter';
  publicAudience?: string;
  publication?: { requirePublicMarkerForCrossRoot?: boolean };
  maxDepth?: number;
  maxExpansionBytes?: number;
}
export interface ComposerOptions {
  root: string;
  inputs?: string[];
  config?: ComposerConfig;
}
export type Operation = 'include' | 'embed' | 'index' | 'metadata';
export interface ComposeOptions extends ComposerOptions {
  outputDir?: string;
  operations?: Operation[];
}
export interface PlannedChange {
  path: string;
  beforeHash: string | null;
  content: string;
}
export interface ComposePlan {
  format: 1;
  root: string;
  sources: Record<string, string>;
  changes: PlannedChange[];
  diagnostics: Diagnostic[];
  operations: Operation[];
}
export interface MetadataResult {
  data: Record<string, unknown>;
  hasMetadata: boolean;
  issues: string[];
}
export interface MarkdownLink {
  destination: string;
  kind: 'link' | 'image' | 'definition' | 'reference';
  line: number;
  column: number;
  start: number;
  end: number;
  unresolvedReference?: string;
}
export interface LintResult { ok: boolean; diagnostics: Diagnostic[] }

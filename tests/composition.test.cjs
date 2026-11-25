const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const test = require('node:test');
const api = require('../dist/index.cjs');
const cli = path.resolve(__dirname, '../dist/mdcomposer.cli.cjs');
const make = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcomposer-test-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  return root;
};
const snapshot = root => {
  const found = {};
  const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute); else found[path.relative(root, absolute)] = fs.readFileSync(absolute, 'utf8');
  } };
  walk(root); return found;
};
const clean = (t, root) => t.after(() => fs.rmSync(root, {recursive:true,force:true}));
const assertGood = plan => assert.deepEqual(plan.diagnostics.filter(item => item.severity === 'error'), []);

test('CommonMark AST handles reference links, images, code and duplicate headings', () => {
  const text = '# A *heading*\n# A *heading*\n\n[x][ref]\n![image](./image.png)\n\n[ref]: ./target.md "title"\n\n```md\n[ignored](missing.md)\n```\n';
  assert.deepEqual([...api.headingSlugs(text)], ['a-heading','a-heading-1']);
  const links=api.extractMarkdownLinks(text);
  assert.equal(links.length,3); assert.equal(links.some(link=>link.destination==='missing.md'),false);
  assert.equal(links.find(link=>link.kind==='reference').destination,'./target.md');
});
test('rebasing edits the parsed destination rather than resource-like title text',()=>{
  const source=path.resolve('original/example.md');const target=path.resolve('original/stage/example.md');
  const text='[x](source.md "title ](ignored)")';
  assert.equal(api.rebaseMarkdownLinks(text,source,target),'[x](../source.md "title ](ignored)")');
  const escaped='[x](source\\(copy\\).md "keep title")';
  assert.equal(api.rebaseMarkdownLinks(escaped,source,target),'[x](../source%28copy%29.md "keep title")');
  assert.equal(api.rebaseMarkdownLinks('[`label ](literal)`](source.md)',source,target),'[`label ](literal)`](../source.md)');
});
test('YAML metadata supports real nested YAML and detects duplicates and overlap', () => {
  const result=api.parseMetadata('---\ntitle: Example\nindex:\n  include: false\ntags: [one, two]\n---\n# Example\n');
  assert.deepEqual(result.issues,[]); assert.equal(result.data.index.include,false);
  assert.deepEqual(result.data.tags,['one','two']);
  assert.ok(api.parseMetadata('---\ntitle: A\ntitle: B\n---\n').issues.length);
  assert.ok(api.parseMetadata('---\ntitle: A\n---\n<!-- mdcomposer:meta\ntitle: B\n-->').issues.length);
  assert.equal(api.validateMetadata('# A\n',['title'])[0].ruleId,'metadata');
});
test('legacy Status fields are inspectable without inventing acceptance',()=>{
  const result=api.parseMetadata('# Example\n\n## Status\n\n- state: draft\n- audience: public\n- last-updated: 2026-11-25\n\n---\n\n## Content\nBody.\n');
  assert.equal(result.data.state,'draft');assert.equal(result.data.audience,'public');
  assert.equal(api.parseMetadata('# A\nNo metadata.').data.state,undefined);
});
test('valid empty frontmatter is an empty mapping with or without final newline',()=>{
  for(const text of ['---\n---','---\n---\n','# Heading\n']) {
    const result=api.parseMetadata(text);assert.deepEqual(result.issues,[]);assert.deepEqual(result.data,{});
    assert.equal(result.hasMetadata,text.startsWith('---'));
  }
});
test('legacy visible Status backticks and punctuation remain scalar values',()=>{
  const result=api.parseMetadata('# Example\n\n## Status\n\n- state: `draft`\n- concept: `edge-expansion`\n- scope: API: adapter boundary\n\n## Content\nBody.\n');
  assert.deepEqual(result.issues,[]);assert.equal(result.data.state,'draft');assert.equal(result.data.concept,'edge-expansion');assert.equal(result.data.scope,'API: adapter boundary');
  assert.ok(api.parseMetadata('---\nstate: `draft`\n---\n').issues.length,'Canonical YAML stays strict');
});
test('existing directories accept navigation links and select only real index or README targets',t=>{
  const root=make({'a.md':'# A\n[Empty directory](./empty/)\n[Templates](./templates/)\n[README heading](./templates/#details)\n[Index heading](./with-index/#details)\n[Extensionless](./topic#details)\n','templates/README.md':'# Templates\n\n## Details\n','with-index/index.md':'# Index\n\n## Details\n','topic.md':'# Topic\n\n## Details\n'});clean(t,root);fs.mkdirSync(path.join(root,'empty'));
  const good=api.lintDocuments({root});assert.equal(good.ok,true,JSON.stringify(good.diagnostics));
  fs.writeFileSync(path.join(root,'a.md'),'# A\n[Missing heading](./templates/#absent)\n[No directory heading](./empty/#details)\n[Outside](../escape/)\n');
  const bad=api.lintDocuments({root});assert.equal(bad.ok,false);assert.equal(bad.diagnostics.length,3);assert.ok(bad.diagnostics.some(item=>/leaves repository/.test(item.message)));
});
test('unresolved explicit reference links are diagnosed outside code',t=>{
  const root=make({'a.md':'# A\n[broken][missing]\n\n`[literal][missing]`\n'});clean(t,root);
  const result=api.lintDocuments({root});assert.equal(result.diagnostics.length,1);assert.match(result.diagnostics[0].message,/definition/);
});
test('validates heading fragments, references, images and encoded paths', t => {
  const root=make({'a.md':'# A\n[good](./with%20space.md#target)\n[ref][r]\n![x](./image.png)\n\n[r]: ./with%20space.md#target\n','with space.md':'# Target\n','image.png':'fixture'}); clean(t,root);
  assert.equal(api.lintDocuments({root}).ok,true);
  fs.writeFileSync(path.join(root,'a.md'),'# A\n[bad](./with%20space.md#absent)\n');
  const result=api.lintDocuments({root}); assert.equal(result.ok,false); assert.match(result.diagnostics[0].message,/fragment/);
});
test('detects same-document heading failures and ignores fenced examples', t => {
  const root=make({'a.md':'# A\n[bad](#absent)\n\n```md\n[x](missing.md)\n```\n'}); clean(t,root);
  const result=api.lintDocuments({root}); assert.equal(result.diagnostics.length,1); assert.match(result.diagnostics[0].message,/fragment/);
});
test('separate lint invocations observe changed targets after repeated shared references',t=>{
  const files={'target.md':'# Target\n'};
  for(let index=0;index<12;index+=1) files[`source-${index}.md`]=`# Source ${index}\n\n[First](./target.md#target)\n[Again](./target.md#target)\n`;
  const root=make(files);clean(t,root);assert.equal(api.lintDocuments({root}).ok,true);
  fs.writeFileSync(path.join(root,'target.md'),'# Changed\n');
  const changed=api.lintDocuments({root});assert.equal(changed.ok,false);assert.equal(changed.diagnostics.filter(item=>/fragment/.test(item.message)).length,24);
});
test('checks containment and does not follow symlink inputs', t => {
  const root=make({'a.md':'# A\n[escape](../outside.md)\n'}); clean(t,root);
  assert.equal(api.lintDocuments({root}).ok,false);
  try { fs.symlinkSync(root,path.join(root,'linked'),'junction'); }
  catch(error) { if(['EPERM','EACCES','ENOTSUP'].includes(error.code)) return t.skip('Host does not permit test symlinks'); throw error; }
  assert.equal(api.lintDocuments({root}).ok,false);
});
test('index planning is read-only and byte-idempotent after first application', t => {
  const root=make({'docs/a.md':'# A\n','docs/sub/b.md':'# B\n'}); clean(t,root);
  const before=snapshot(root); const options={root,config:{roots:['docs']},operations:['index']};
  const first=api.planCompose(options); assertGood(first); assert.deepEqual(snapshot(root),before);
  api.applyChanges(first); assert.ok(fs.existsSync(path.join(root,'docs/index.md')));
  const second=api.planCompose(options); assertGood(second); assert.equal(second.changes.length,0);
});
test('manual index prose remains unchanged', t => {
  const root=make({'docs/index.md':'# Carefully maintained\n\nCustom navigation.\n','docs/a.md':'# A\n'}); clean(t,root);
  const plan=api.planCompose({root,config:{roots:['docs']},operations:['index']}); assertGood(plan); api.applyChanges(plan);
  assert.equal(fs.readFileSync(path.join(root,'docs/index.md'),'utf8'),'# Carefully maintained\n\nCustom navigation.\n');
});
test('generated index preserves surrounding authored content and refuses malformed markers', t => {
  const root=make({'docs/index.md':'# Docs\n\nAuthored intro.\n\n<!-- mdcomposer:index:start -->\nOld\n<!-- mdcomposer:index:end -->\n\nAuthored end.\n','docs/a.md':'# A\n'}); clean(t,root);
  const plan=api.planCompose({root,config:{roots:['docs']},operations:['index']}); assertGood(plan); api.applyChanges(plan);
  const output=fs.readFileSync(path.join(root,'docs/index.md'),'utf8'); assert.match(output,/Authored intro/); assert.match(output,/Authored end/);
  fs.writeFileSync(path.join(root,'docs/a.md'),'# A\n<!-- mdcomposer:nav:start -->\n');
  const broken=api.planCompose({root,config:{roots:['docs']},operations:['index']}); assert.ok(broken.diagnostics.length); assert.throws(()=>api.applyChanges(broken),/errors/);
});
test('whole include strips machine metadata, rebases references and records provenance', t => {
  const root=make({'docs/index.md':'# Docs\n','docs/a.md':'# A\n\n<!-- @include(./sub/b.md) -->\n','docs/sub/b.md':'---\ntitle: B\naudience: internal\n---\n# B\n\n<!-- mdcomposer:nav:start -->\n[Home](../index.md)\n<!-- mdcomposer:nav:end -->\n\n[Target][r]\n\n[r]: ./target.md#target\n','docs/sub/target.md':'# Target\n'}); clean(t,root);
  const options={root,config:{roots:['docs']},operations:['include']};
  const plan=api.planCompose(options); assertGood(plan); api.applyChanges(plan);
  const output=fs.readFileSync(path.join(root,'docs/a.md'),'utf8');
  assert.match(output,/@include/); assert.match(output,/sha256="[a-f0-9]{64}"/); assert.match(output,/\.\/sub\/target.md#target/);
  assert.doesNotMatch(output,/title: B|mdcomposer:nav:start/);
  const repeated=api.planCompose(options); assertGood(repeated); assert.equal(repeated.changes.length,0);
});
test('embed supports full-body compatibility and bounded heading excerpts', t => {
  const root=make({'a.md':'# A\n\n<!-- @embed(./b.md#chosen) -->\n','b.md':'# B\nIntro\n\n## Chosen\nKeep.\n\n### Child\nAlso keep.\n\n## Other\nOmit.\n'}); clean(t,root);
  const plan=api.planCompose({root,operations:['embed']}); assertGood(plan); api.applyChanges(plan);
  const output=fs.readFileSync(path.join(root,'a.md'),'utf8'); assert.match(output,/Keep/); assert.match(output,/Also keep/); assert.doesNotMatch(output,/Omit/);
  fs.writeFileSync(path.join(root,'a.md'),'# A\n\n<!-- @embed(./b.md) -->\n');
  const full=api.planCompose({root,operations:['embed']}); assertGood(full); assert.match(full.changes.find(c=>c.path==='a.md').content,/Omit/);
});
test('nested imports expand once and composition directives in code remain literal', t => {
  const root=make({'a.md':'# A\n\n<!-- @include(./b.md) -->\n\n```md\n<!-- @include(./missing.md) -->\n```\n','b.md':'# B\n\n<!-- @embed(./c.md#chosen) -->\n','c.md':'# C\n\n## Chosen\nNested text.\n'}); clean(t,root);
  const plan=api.planCompose({root,operations:['include','embed']}); assertGood(plan); api.applyChanges(plan);
  const output=fs.readFileSync(path.join(root,'a.md'),'utf8'); assert.match(output,/Nested text/); assert.match(output,/include\(\.\/missing/);
  assert.equal((output.match(/mdcomposer:include:start/g)||[]).length,1);
});
for(const [label,files,config] of [
  ['missing import',{'a.md':'<!-- @include(./missing.md) -->\n'},{}],
  ['cycle',{'a.md':'<!-- @include(./b.md) -->\n','b.md':'<!-- @include(./a.md) -->\n'},{}],
  ['depth bound',{'a.md':'<!-- @include(./b.md) -->\n','b.md':'# B\n'},{maxDepth:1}],
  ['size bound',{'a.md':'<!-- @include(./b.md) -->\n','b.md':'# B\nLong text'},{maxExpansionBytes:12}],
  ['heading absent',{'a.md':'<!-- @embed(./b.md#absent) -->\n','b.md':'# B\n'},{}],
  ['include fragment',{'a.md':'<!-- @include(./b.md#b) -->\n','b.md':'# B\n'},{}],
  ['network import',{'a.md':'<!-- @include(https://example.com/a.md) -->\n'},{}],
  ['non-Markdown import',{'a.md':'<!-- @include(./b.txt) -->\n','b.txt':'Text'},{}],
]) test(`${label} refuses before mutation`, t=>{
  const root=make(files);clean(t,root);const before=snapshot(root);
  const plan=api.planCompose({root,config,operations:['include','embed']});assert.ok(plan.diagnostics.some(d=>d.severity==='error'));
  assert.throws(()=>api.applyChanges(plan),/errors/);assert.deepEqual(snapshot(root),before);
});
test('public import requires explicit source audience and cross-root marker',t=>{
  const root=make({'public/a.md':'---\naudience: public\n---\n# A\n\n<!-- @embed(../internal/b.md) -->\n','internal/b.md':'# Internal\n'});clean(t,root);
  const options={root,config:{roots:['public','internal'],publication:{requirePublicMarkerForCrossRoot:true}},operations:['embed']};
  assert.ok(api.planCompose(options).diagnostics.length);
  fs.writeFileSync(path.join(root,'internal/b.md'),'---\naudience: public\n---\n# Shared\n');
  assert.match(api.planCompose(options).diagnostics[0].message,/public -->/);
  fs.appendFileSync(path.join(root,'internal/b.md'),'\n<!-- @public -->\n');
  assertGood(api.planCompose(options));
});
test('public cross-root import cannot substitute default audience for explicit source metadata',t=>{
  const root=make({'public/a.md':'---\naudience: public\n---\n# A\n\n<!-- @embed(../shared/b.md) -->\n','shared/b.md':'# Shared\n\n<!-- @public -->\n'});clean(t,root);
  const plan=api.planCompose({root,config:{roots:['public','shared'],defaultAudience:'public',publication:{requirePublicMarkerForCrossRoot:true}},operations:['embed']});
  assert.ok(plan.diagnostics.some(item=>item.severity==='error'));assert.throws(()=>api.applyChanges(plan),/errors/);
});
test('public navigation indexes retain public audience and imports ignore markers in code',t=>{
  const root=make({'public/a.md':'---\naudience: public\n---\n# A\n\n<!-- @embed(../internal/b.md) -->\n','internal/b.md':'---\naudience: public\n---\n# Shared\n\n```md\n<!-- @public -->\n```\n'});clean(t,root);
  const config={roots:['public','internal'],publication:{requirePublicMarkerForCrossRoot:true}};
  assert.ok(api.planCompose({root,config}).diagnostics.some(item=>/public -->/.test(item.message)));
  fs.appendFileSync(path.join(root,'internal/b.md'),'\n<!-- @public -->\n');
  const plan=api.planCompose({root,config});assertGood(plan);api.applyChanges(plan);
  assert.equal(api.parseMetadata(fs.readFileSync(path.join(root,'public/index.md'),'utf8')).data.audience,'public');
  const second=api.planCompose({root,config});assertGood(second);assert.equal(second.changes.length,0);
});
test('metadata examples in fenced code do not become document metadata',()=>{
  const result=api.parseMetadata('# Example\n\n```md\n<!-- mdcomposer:meta\nstate: accepted\n-->\n```\n');
  assert.equal(result.hasMetadata,false);assert.deepEqual(result.issues,[]);
});
test('metadata initialization uses draft and never overwrites existing metadata',t=>{
  const root=make({'a.md':'# A\n','b.md':'---\ntitle: Existing\nstate: accepted\n---\n# B\n'});clean(t,root);
  const options={root,config:{requiredMetadata:['title','state']},operations:['metadata']};const plan=api.planCompose(options);assertGood(plan);api.applyChanges(plan);
  assert.equal(api.parseMetadata(fs.readFileSync(path.join(root,'a.md'),'utf8')).data.state,'draft');
  assert.equal(api.parseMetadata(fs.readFileSync(path.join(root,'b.md'),'utf8')).data.state,'accepted');
  assert.equal(api.planCompose(options).changes.length,0);
});
test('stale transitive sources and destination conflicts refuse entire plan',t=>{
  const root=make({'a.md':'# A\n<!-- @include(./b.md) -->\n','b.md':'# B\n'});clean(t,root);
  const plan=api.planCompose({root,inputs:['a.md'],operations:['include']});assertGood(plan);
  fs.appendFileSync(path.join(root,'b.md'),'Changed.\n');const before=snapshot(root);
  assert.throws(()=>api.applyChanges(plan),/Stale/);assert.deepEqual(snapshot(root),before);
  const bad={format:1,root,sources:{},diagnostics:[],operations:[],changes:[{path:'new.md',beforeHash:null,content:'New'},{path:'b.md',beforeHash:null,content:'Overwrite'}]};
  assert.throws(()=>api.applyChanges(bad),/conflict/);assert.equal(fs.existsSync(path.join(root,'new.md')),false);
});
test('plan validation rejects traversal and planned file/directory collisions',t=>{
  const root=make({'a.md':'# A\n'});clean(t,root);
  const base={format:1,root,sources:{},diagnostics:[],operations:[]};
  assert.throws(()=>api.applyChanges({...base,changes:[{path:'../escape.md',beforeHash:null,content:'x'}]}),/leaves/);
  assert.throws(()=>api.applyChanges({...base,changes:[{path:'new',beforeHash:null,content:'x'},{path:'new/a.md',beforeHash:null,content:'x'}]}),/collision/);
});
test('CLI requires explicit root, validates arguments, and offers read-only JSON dry-run',t=>{
  const root=make({'a.md':'# A\n'});clean(t,root);const before=snapshot(root);
  const run=args=>cp.spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
  assert.equal(run(['--help']).status,0);assert.equal(run(['compose']).status,2);assert.equal(run(['nonsense','--root',root]).status,2);
  const preview=run(['compose','--root',root,'--dry-run','--json']);assert.equal(preview.status,0,preview.stderr);assert.ok(JSON.parse(preview.stdout).changes.length);
  assert.deepEqual(snapshot(root),before);
});
test('staging output rewrites references to staged Markdown and leaves sources untouched',t=>{
  const root=make({'docs/a.md':'# A\n\n[Other](./b.md#b)\n\n<!-- @embed(./b.md#b) -->\n','docs/b.md':'# B\nBody.\n'});clean(t,root);
  const before=snapshot(root);
  const plan=api.planCompose({root,config:{roots:['docs']},operations:['embed','index'],outputDir:'generated'});assertGood(plan);api.applyChanges(plan);
  assert.equal(fs.readFileSync(path.join(root,'docs/a.md'),'utf8'),before[path.join('docs','a.md')]);
  assert.match(fs.readFileSync(path.join(root,'generated/docs/a.md'),'utf8'),/\.\/b.md#b/);
  assert.equal(api.lintDocuments({root,inputs:['generated/docs']}).ok,true);
});
test('bundled library supports both CommonJS and ESM',async()=>{
  const esm=await import('../dist/index.js');assert.equal(typeof esm.planCompose,'function');assert.equal(typeof api.planCompose,'function');
});
test('downstream tools can rebundle the ESM export as CommonJS',t=>{
  const root=make({});clean(t,root);const output=path.join(root,'consumer.cjs');
  require('esbuild').buildSync({stdin:{contents:'import { parseMetadata } from "./dist/index.js"; console.log(parseMetadata("# A").hasMetadata);',resolveDir:path.resolve(__dirname,'..')},bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'silent'});
  const result=cp.spawnSync(process.execPath,[output],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'false');
});

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const test=require('node:test');
const root=path.resolve(__dirname,'..');
const cli=path.join(root,'dist/mdcomposer.cli.cjs');
const temporary=t=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mdcomposer-distribution-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;};
const run=(args,options={})=>cp.spawnSync(process.execPath,args,{encoding:'utf8',...options});

test('skill export previews without creation and runs after relocation without source or npm',t=>{
  const directory=temporary(t);const output=path.join(directory,'original');
  const preview=run([cli,'export-skill','--output',output,'--dry-run','--json']);assert.equal(preview.status,0,preview.stderr);assert.equal(fs.existsSync(output),false);
  const exported=run([cli,'export-skill','--output',output,'--json']);assert.equal(exported.status,0,exported.stderr);
  const relocated=path.join(directory,'moved');fs.renameSync(output,relocated);
  const project=path.join(directory,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'a.md'),'# A\n');
  const result=run([path.join(relocated,'scripts/mdcomposer.cli.cjs'),'compose','--root',project,'--json'],{cwd:directory});assert.equal(result.status,0,result.stderr);assert.ok(fs.existsSync(path.join(project,'index.md')));
  assert.ok(fs.existsSync(path.join(relocated,'LICENSE')));assert.ok(fs.existsSync(path.join(relocated,'assets/manifest.json')));
  const manifest=JSON.parse(fs.readFileSync(path.join(relocated,'assets/manifest.json'),'utf8'));assert.equal(manifest.package,'@worklogiq/mdcomposer');
  const again=run([path.join(relocated,'scripts/mdcomposer.cli.cjs'),'export-skill','--output',path.join(directory,'another')]);assert.equal(again.status,1);assert.match(again.stderr,/already an export/);
});
test('skill export refuses every change if one destination conflicts',t=>{
  const directory=temporary(t);const output=path.join(directory,'skill');fs.mkdirSync(output);fs.writeFileSync(path.join(output,'SKILL.md'),'User content');
  const result=run([cli,'export-skill','--output',output]);assert.equal(result.status,1);assert.match(result.stderr,/conflict/);
  assert.deepEqual(fs.readdirSync(output),['SKILL.md']);assert.equal(fs.readFileSync(path.join(output,'SKILL.md'),'utf8'),'User content');
});
test('packed package installs offline and exposes both library formats and CLI',t=>{
  const directory=temporary(t);const npm=process.env.npm_execpath;
  assert.ok(npm,'Run distribution tests through npm test so npm_execpath is available.');
  const packed=run([npm,'pack','--ignore-scripts','--json','--pack-destination',directory],{cwd:root});assert.equal(packed.status,0,packed.stderr);
  const metadata=JSON.parse(packed.stdout)[0];assert.ok(metadata.files.some(item=>item.path==='dist/index.cjs'));assert.ok(metadata.files.some(item=>item.path==='skills/mdcomposer/SKILL.md'));
  assert.equal(metadata.files.some(item=>item.path.startsWith('node_modules/')),false);
  const consumer=path.join(directory,'consumer');fs.mkdirSync(consumer);fs.writeFileSync(path.join(consumer,'package.json'),'{}\n');
  const installed=run([npm,'install','--ignore-scripts','--offline','--no-audit','--no-fund',path.join(directory,metadata.filename)],{cwd:consumer});assert.equal(installed.status,0,installed.stderr);
  const cjs=run(['-e','console.log(typeof require("@worklogiq/mdcomposer").planCompose)'],{cwd:consumer});assert.equal(cjs.status,0,cjs.stderr);assert.equal(cjs.stdout.trim(),'function');
  const esm=run(['--input-type=module','-e','import { lintDocuments } from "@worklogiq/mdcomposer"; console.log(typeof lintDocuments);'],{cwd:consumer});assert.equal(esm.status,0,esm.stderr);assert.equal(esm.stdout.trim(),'function');
  const help=run([path.join(consumer,'node_modules/@worklogiq/mdcomposer/dist/mdcomposer.cli.cjs'),'--help'],{cwd:consumer});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/whole-document/);
});

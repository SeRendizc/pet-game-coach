import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

// The browser entry point is not imported by any other test file, so a syntax error in
// app.js leaves the whole unit suite green while the UI is completely dead. These two
// checks cover the gap: parse the real browser module graph, and confirm the server is
// actually allowed to serve every module that graph needs.
const root=dirname(fileURLToPath(import.meta.url));
const BROWSER_ENTRY='app.js';

function parse(file){execFileSync(process.execPath,['--check',join(root,file)],{stdio:'pipe'});}

function importClosure(entry){
  const seen=new Set(),queue=[entry];
  while(queue.length){
    const file=queue.shift();
    if(seen.has(file))continue;
    seen.add(file);
    const src=readFileSync(join(root,file),'utf8');
    for(const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)){
      const spec=m[1];
      if(!spec.startsWith('.'))continue;
      const resolved=join(dirname(file),spec).split('\\').join('/');
      if(!existsSync(join(root,resolved)))throw new Error(`missing module ${resolved} (imported by ${file})`);
      queue.push(resolved);
    }
  }
  return [...seen].sort();
}

test('every module in the browser import graph parses',()=>{
  const files=importClosure(BROWSER_ENTRY);
  assert(files.length>=8,`expected a real browser graph, got ${files.length} file(s): ${files.join(', ')}`);
  assert(files.includes('app.js')&&files.includes('engine.js')&&files.includes('coach/runtime.js'));
  for(const f of files)parse(f);
});

test('the server allowlist covers every browser module plus the page shell',()=>{
  const allowed=(()=>{
    const server=readFileSync(join(root,'server.js'),'utf8');
    const list=server.match(/publicAssets=new Set\(\[([^\]]*)\]/);
    assert(list,'publicAssets list not found in server.js');
    return new Set([...list[1].matchAll(/'([^']+)'/g)].map(m=>m[1]));
  })();
  for(const f of importClosure(BROWSER_ENTRY))assert(allowed.has(f),`${f} is imported by the browser but not in server.js publicAssets`);
  for(const f of ['index.html','style.css','connect.html','connect.js','connect.css'])assert(allowed.has(f),`${f} missing from server.js publicAssets`);
});

test('app.js does not reference the removed dropdown loadout UI',()=>{
  const src=readFileSync(join(root,'app.js'),'utf8');
  assert(!src.includes('data-slot'),'the old <select data-slot> loadout picker is gone; remove leftover handlers');
  assert(!src.includes('roster-page='),'the old base/tactical paging is gone; remove leftover handlers');
});

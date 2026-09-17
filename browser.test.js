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

// 军师的局内主动层是 app.js 与 coach/experience.js 之间的接线。
// 接线断掉时页面照样能解析、单测也看不出来，只是「军师永远不开口」——
// 所以这里对真实源码做一次存在性检查，并确认已删除的恒真门控没有回来。
test('app.js wires the in-match strategist layer and dropped the always-true gate',()=>{
  const src=readFileSync(join(root,'app.js'),'utf8');
  for(const needed of ['strategistSession','strategistTrigger','incidentInfo','strategistEvaluate','strategistCue','strategistHintsAllowed','turnIncident','strategistPanel'])
    assert(src.includes(needed),`app.js is missing the strategist wiring: ${needed}`);
  assert(!/function\s+coachAllowedInMatch/.test(src),'the always-true coachAllowedInMatch() should be gone');
  // 说明它被删掉的注释可以留着，但真实调用点不能再有（注释行先剔除再找）。
  const code=src.split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');
  assert(!code.includes('coachAllowedInMatch'),'no remaining call sites of the removed helper');
});

// 陪练的「在场方式」是 app.js 与 coach/companion.js 之间的接线：断掉时页面照样能解析、
// 单测也全绿，只是左下角再也没有那个人。所以这里对真实源码做一次存在性检查，
// 并确认军师/老师不再占用陪练的气泡（「一条消息只出现在一个地方」）。
test('app.js wires the companion presence layer and leaves the bubble to the companion',()=>{
 const src=readFileSync(join(root,'app.js'),'utf8');
 for(const needed of ['companionSession','companionEvents','queueCompanionCue','flushCompanionCue','yieldCompanionCue','placeCompanionBubble','bubbleDurationMs','companionCueSlot','companionAvatar','companionSaid','companionPending'])
  assert(src.includes(needed),`app.js is missing the companion presence wiring: ${needed}`);
 // 军师/老师那条走顶部条：strategistCue 不得再往 #coach-bubble 里写正文
 const cue=src.slice(src.indexOf('function strategistCue('),src.indexOf('function openCoach('));
 assert(!cue.includes("$('bubble-text')"),'strategistCue 不应该再写陪练气泡的正文');
 assert(cue.includes('yieldCompanionCue()'),'军师要开口时陪练必须让位');
 // 时长必须按字数算，且鼠标悬停要暂停计时
 assert(/bubbleDurationMs\(\$\('bubble-text'\)/.test(src),'气泡时长必须由正文长度算出来');
 assert(src.includes("addEventListener('pointerenter'")&&src.includes("addEventListener('pointerleave'"),'悬停要暂停计时');
 // 安静档仍然最优先
 assert(src.includes("if(profile.coach.mode==='quiet'){companionPending=null;hideCompanionCue();}"),'安静档必须立刻收起陪练气泡');
});

test('队伍上限是三只，且开始前会被校验',async()=>{
 // 这条是补的回归：重构卡片模板时新加了一个「加入队伍」按钮却没有数量上限，
 // 于是能一路选到 6、7 只，startMatch 还照样开打。
 const {readFileSync}=await import('node:fs');
 const src=readFileSync(new URL('./app.js',import.meta.url),'utf8');
 assert.match(src,/selected\.length>=3\?'disabled'/,'满员时「加入队伍」必须禁用');
 assert.match(src,/if\(!selected\.includes\(id\)&&selected\.length>=3\)return;/,'点选处理必须挡上限');
 assert.match(src,/if\(selected\.length!==3\)\{[^}]*请选择三只伙伴/,'开始前必须校验队伍是三只');
});

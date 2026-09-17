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

// ══════════════════════════════════════════════════════════════════════════════
// 小芽的对话记录：会话列表 + 上限 +「清对话 ≠ 清记忆」
//
// 用户原话：「另外每次刷新能不能清空一下小芽对话记录？或者做成对话式保存一下可以选回去」。
// 两个方案里选了后者，理由是**刷新就清空等于丢数据**——用户问的是「能不能」，不是「必须」；
// 而「存下来 + 能选回去」是同一件事的超集：默认什么都不做就接着看，想开新的按「新对话」。
// 这一组钉住四件事：
//   ① 刷新后不丢（存档能读回来，轮次与顺序都对）；
//   ② 能开新的、能切回旧的；
//   ③ 数量有上限，localStorage 撑不爆（会话 8 条 / 每条 40 轮 / 整包 180KB）；
//   ④ **清对话不清记忆**：会话存档只碰自己的三个字段，跨局账本是另一个键。
// ══════════════════════════════════════════════════════════════════════════════
const chatApi=async()=>import('./coach/client.js');

test('对话记录①：刷新后不丢——存了能读回来，轮次与顺序都对',async()=>{
 const {emptyChatStore,appendChatTurn,serializeChatStore,readChatStore,activeChatSession,chatConversation}=await chatApi();
 let store=emptyChatStore();
 store=appendChatTurn(store,'user','哈喽',1000);
 store=appendChatTurn(store,'assistant','上午好——今天这才刚开头。慢慢来，不急。',1001);
 store=appendChatTurn(store,'user','这局怎么打',1002);
 const raw=serializeChatStore(store);              // 写进 localStorage 的那串
 const back=readChatStore(raw);                     // 刷新后读回来的那份
 assert.equal(back.sessions.length,1);
 assert.deepEqual(chatConversation(activeChatSession(back)),[
  {role:'user',content:'哈喽'},
  {role:'assistant',content:'上午好——今天这才刚开头。慢慢来，不急。'},
  {role:'user',content:'这局怎么打'},
 ],'刷新后必须一条不差地接着看');
 // 坏存档（损坏、旧格式、null）不能让页面炸，退回一段空会话
 assert.deepEqual(readChatStore('{不是 JSON').sessions,[]);
 assert.deepEqual(readChatStore(null).sessions,[]);
 assert.deepEqual(readChatStore('{"sessions":"nope"}').sessions,[]);
 // 老存档升级：旧版本把最近 8 轮塞在 memory.dialogue 里，第一条新存档要把它收进来
 const {seedChatStoreFromDialogue}=await chatApi();
 const seeded=seedChatStoreFromDialogue([{role:'user',content:'你好'},{role:'assistant',content:'在的。'}]);
 assert.equal(seeded.sessions.length,1);
 assert.equal(seeded.sessions[0].turns.length,2,'升级时一条都不许丢');
 assert.deepEqual(seedChatStoreFromDialogue([]).sessions,[]);
});

test('对话记录②：能开新的，也能切回旧的（切回去送模型的就是那一段）',async()=>{
 const {emptyChatStore,appendChatTurn,startChatSession,selectChatSession,activeChatSession,chatConversation,chatTitle}=await chatApi();
 let store=emptyChatStore();
 store=appendChatTurn(store,'user','哈喽',1000);
 store=appendChatTurn(store,'assistant','上午好。',1001);
 const first=store.activeId;
 store=startChatSession(store,2000);
 assert.equal(store.sessions.length,2,'开新的不许把旧的删掉');
 assert.notEqual(store.activeId,first);
 assert.deepEqual(chatConversation(activeChatSession(store)),[],'新会话是空的');
 store=appendChatTurn(store,'user','这回合怎么打',2001);
 assert.deepEqual(chatConversation(activeChatSession(store)),[{role:'user',content:'这回合怎么打'}]);
 // 切回旧的：上下文变回那一段，新的那段还在
 store=selectChatSession(store,first);
 assert.equal(store.activeId,first);
 assert.deepEqual(chatConversation(activeChatSession(store)),[{role:'user',content:'哈喽'},{role:'assistant',content:'上午好。'}]);
 assert.equal(store.sessions.length,2);
 // 切到不存在的 id 就当没发生（UI 里的 select 可能给出过期值）
 assert.equal(selectChatSession(store,'chat-nope').activeId,first);
 // 列表里的标题取这段对话里玩家说的第一句
 assert.equal(chatTitle(store.sessions.find(s=>s.id===first)),'哈喽');
 assert.equal(chatTitle(store.sessions.find(s=>s.id!==first)),'这回合怎么打');
 assert.equal(chatTitle({turns:[]}),'新的对话');
 // 送去模型的窗口还是最近 8 轮，没有变大
 for(let i=0;i<30;i++)store=appendChatTurn(store,'user',`第${i}句`,3000+i);
 assert.equal(chatConversation(activeChatSession(store)).length,8);
});

test('对话记录③：数量有上限，localStorage 撑不爆',async()=>{
 const {emptyChatStore,appendChatTurn,startChatSession,serializeChatStore,readChatStore,CHAT_LIMITS}=await chatApi();
 assert.deepEqual([CHAT_LIMITS.sessions,CHAT_LIMITS.turns],([8,40]));
 let store=emptyChatStore();
 // 开 20 段对话，每段塞 12 轮：会话数必须被截到 8 条，每条被截到 40 轮
 for(let s=0;s<20;s++){
  store=startChatSession(store,10000+s*1000);
  for(let t=0;t<12;t++)store=appendChatTurn(store, t%2?'assistant':'user', `${'长'.repeat(40)}${s}-${t}`, 10000+s*1000+t);
 }
 const long=serializeChatStore(store);
 assert.equal(JSON.parse(long).sessions.length,CHAT_LIMITS.sessions,`会话数必须被截到 ${CHAT_LIMITS.sessions}`);
 // 单条超长也要截：60 轮进去，40 轮出来
 let one=emptyChatStore();
 for(let i=0;i<60;i++)one=appendChatTurn(one,'user',`第${i}句`,i);
 assert.equal(JSON.parse(serializeChatStore(one)).sessions[0].turns.length,CHAT_LIMITS.turns);
 // 整包上限：塞进远超预算的量，序列化结果必须仍然装得下
 let huge=emptyChatStore();
 for(let s=0;s<8;s++){
  huge=startChatSession(huge,50000+s*1000);
  for(let t=0;t<40;t++)huge=appendChatTurn(huge,'user','撑'.repeat(1500),50000+s*1000+t);
 }
 const packed=serializeChatStore(huge);
 assert(packed.length<=CHAT_LIMITS.bytes,`整包必须被裁到 ${CHAT_LIMITS.bytes} 字节以内，实际 ${packed.length}`);
 assert(JSON.parse(packed).sessions.length>=1,'裁到最后至少要留一段，不能裁成空');
 assert.equal(readChatStore(packed).sessions.length,JSON.parse(packed).sessions.length,'裁过的包读回来还是同一个形状');
});

test('对话记录④：清对话不清记忆——会话存档与跨局账本是两个键、两组字段',async()=>{
 const {emptyChatStore,appendChatTurn,startChatSession,activeChatSession}=await chatApi();
 const {freshMemory,rememberBattle}=await import('./coach/memory.js');
 const {createGame,step,legalActions,rankEnemyActions}=await import('./engine.js');
 // 真跑一局，让账本里真的有东西
 let g=createGame(4,undefined,{difficulty:'normal',stageName:'05 · 冠军高地',stageId:'summit'});g.id='chat-memory';
 for(let n=0;n<200&&!g.result;n++)g=step(g,rankEnemyActions({...g,player:g.enemy,enemy:g.player})[0]?.action||legalActions(g)[0]);
 const memory=rememberBattle(freshMemory(),g);
 assert(memory.events.length>0,'前提：账本里确实有记录');
 const ledgerKeys=['events','lessons','goal','favorite','preference','journal','reflections','watches','quizCount'];
 const before=JSON.stringify(Object.fromEntries(ledgerKeys.map(k=>[k,memory[k]])));
 // 「新对话」走的是同一个函数：它只拿到会话存档，连 memory 都碰不到
 let store=appendChatTurn(emptyChatStore(),'user','哈喽',1000);
 store=startChatSession(store,2000);
 // 会话存档里只有这三个字段——账本字段一个都不许出现（出现了就说明两者被混成了一个）
 assert.deepEqual(Object.keys(store).sort(),['activeId','sessions','version']);
 assert.deepEqual(Object.keys(activeChatSession(store)).sort(),['id','startedAt','title','turns','updatedAt']);
 for(const key of ledgerKeys)assert.equal(key in store,false,`会话存档里不该有账本字段 ${key}`);
 // 反向：账本一个字节都没被这次「新对话」改动
 assert.equal(JSON.stringify(Object.fromEntries(ledgerKeys.map(k=>[k,memory[k]]))),before);
 // 而且两个存储键不是同一个：app.js 必须分别读写
 const src=readFileSync(new URL('./app.js',import.meta.url),'utf8');
 assert(src.includes("const CHAT_KEY='xiaoya-chats-v1'"),'会话存档要有自己的键');
 assert(src.includes("localStorage.getItem('xiaoya-memory-v1')")||src.includes("'xiaoya-memory-v1'"),'账本仍走原来的键');
 assert(!/localStorage\.setItem\(CHAT_KEY[^)]*coachMemory/.test(src),'写会话时不许把账本一起写进去');
});

test('对话记录⑤：app.js 真的接上了这两个控件，而且没有动那排快问按钮',()=>{
 const src=readFileSync(new URL('./app.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
 // 两个控件：一个下拉（历史会话）、一个按钮（新对话）
 assert(html.includes('id="chat-threads"')&&html.includes('id="chat-new"'),'index.html 里要有这两个控件');
 assert(/\$\('chat-new'\)\.onclick=newChat/.test(src),'「新对话」必须接上');
 assert(/\$\('chat-threads'\)\.onchange=/.test(src),'历史会话下拉必须接上');
 assert(src.includes('chatStore=restoreChats')||src.includes('restoreChats();'),'启动时要恢复对话记录');
 // 界面改动克制：原来那排快问按钮一个都没动
 for(const q of ['怎么培养','这回合怎么打','出一道小测验','回顾上一局','回顾上一回合'])
  assert(html.includes(`data-question="${q}"`),`快问按钮「${q}」不能被改动`);
 assert(html.includes('class="quick-questions"'),'快问按钮那一排还在原处');
 // 「清对话」与「清记忆」是两个不同的动作：新对话只换会话，不碰账本
 const newChat=src.slice(src.indexOf('function newChat('),src.indexOf('function resetChats('));
 assert(!/freshMemory|saveCoachMemory|coachMemory\s*=/.test(newChat),
  '「新对话」不许清记忆（不能出现 freshMemory / saveCoachMemory / coachMemory=）');
 const restore=src.slice(src.indexOf('function restoreChats('),src.indexOf('function restoreChats(')+700);
 assert(!/freshMemory/.test(restore),'恢复对话记录时同样不许动账本');
});


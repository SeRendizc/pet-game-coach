// 玩家实测的卡死：PVP 里**对手**的宠物倒下之后，界面停在补位页，玩家点不动。
//
// 为什么必须是真浏览器：这个缺陷的每一环都只在真实页面上才成立——
//   ① renderSplitPanels() 把玩家那一侧所有牌禁用；
//   ② render() 把换宠页的牌标成「免费补位」、横幅写成「请选择下一只出场」；
//   ③ pvpPick() 对 replaceSide!=='player' 的点击**静默 return**（不报错、不提示）；
//   ④ 对手的补位要靠 planEnemyAction 提交，它有一个"答案过期就丢掉"的闸门且没有重试，
//      丢掉之后没有任何东西会再提交这一步。
// 断言的对象因此是"页面上的字 + 牌能不能点 + 对局有没有继续"，而不是某个函数。
// 上一次的教训正是：单测全绿、接线断了没人发现，所以这里一律走真实入口
// （真 server.js + 真 app.js + 真浏览器 + 真点击）。
//
// 为了不做成"看运气"的测试：本测试自己起一个在本进程内的服务（semantic:false、
// 模型调用一律失败），局面只由引擎决定；种子固定 313（对手首发是草系苔盾菇，
// 我方首发火系炽鬃狮，克制关系稳定）；并在页面里把**对手补位那一次**请求改成永不落地，
// 精确模拟"对手的补位决定没回来/回来了也过期被丢掉"这一类故障。
// 这样：没有看门狗的版本会永远停在补位页（红），有看门狗的版本自己走完（绿）。
// 期限分两档，这条测试走的是"请求还在飞"那一档：给足对手自己的 4 秒预算再加 0.6 秒余量，
// 所以下面的等待窗必须比它宽——看门狗不会抢对手 agent 的决定权，只保证"没人提交"不会变成永久卡死。
//
// 需要本机有 Chrome；没有就跳过（本仓库的测试要能在没有图形环境的机器上跑）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCoachServer} from './server.js';

const CHROME_CANDIDATES=[
 '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 '/Applications/Chromium.app/Contents/MacOS/Chromium',
 '/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',
];
const chromePath=CHROME_CANDIDATES.find(p=>existsSync(p));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// 一个在本进程内的服务：不配密钥（模型调用一律失败），所以对手只由引擎出招，局面可复现。
async function startServer(){
 const server=createCoachServer({semantic:false,fetchImpl:async()=>{throw Error('测试环境不允许联网');}});
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
 return {server,base:`http://127.0.0.1:${server.address().port}/`,close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);})};
}

async function connect(base){
 // 端口写 0 让系统分配，真实端口在 user-data-dir/DevToolsActivePort 里
 const profile=mkdtempSync(join(tmpdir(),'replace-e2e-'));
 const chrome=spawn(chromePath,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-crash-reporter',
  `--user-data-dir=${profile}`,'--remote-debugging-port=0','--window-size=1440,1000','about:blank'],{stdio:'ignore'});
 const kill=()=>{try{chrome.kill('SIGKILL');}catch{}try{rmSync(profile,{recursive:true,force:true});}catch{}};
 let port=null;
 for(let i=0;i<60&&!port;i++){await sleep(250);try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0].trim();}catch{}}
 if(!port){kill();throw Error('Chrome 没有在预期时间内起来');}
 let targets=null;
 for(let i=0;i<40&&!targets;i++){try{targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();}catch{await sleep(250);}}
 const ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
 let id=0;const pending=new Map();const errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.rej(new Error(JSON.stringify(m.error))):x.res(m.result);return;}
  if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;const text=(d.exception?.description||d.text||'')+' @'+(d.url||'').split('/').pop()+':'+(d.lineNumber+1);if(!/favicon/.test(text))errors.push(text.slice(0,300));}
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error'){const text=(m.params.args||[]).map(a=>a.value??a.description??'').join(' ');if(!/favicon/.test(text))errors.push(('console: '+text).slice(0,300));}};
 const send=(method,params={})=>{const i=++id;return new Promise((res,rej)=>{pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}));});};
 const js=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true});
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||'evaluate failed');return r.result.value;};
 await send('Runtime.enable');await send('Page.enable');
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`
  // 只掐「对手补位」那一次请求：让它永不落地。
  // 这正是缺陷的触发条件——AI 的补位决定决定了却没人提交，而且没有任何重试。
  window.__blockedReplaceRequests=0;
  const realFetch=window.fetch.bind(window);
  window.fetch=function(url,options){
   try{
    if(String(url).includes('/api/opponent')&&options&&typeof options.body==='string'){
     const body=JSON.parse(options.body);
     const battle=body&&body.battle;
     if(battle&&battle.phase==='replace'&&(battle.replaceSide||'player')==='enemy'){window.__blockedReplaceRequests++;return new Promise(()=>{});}
    }
   }catch{}
   return realFetch(url,options);
  };
 `});
 await send('Page.bringToFront').catch(()=>{});
 return {send,js,errors,kill};
}

const snapshotExpr=`(()=>{
 const $=i=>document.getElementById(i);
 const cards=[...document.querySelectorAll('#actions [data-action]')].map(b=>({text:b.textContent.replace(/\\s+/g,' ').trim(),disabled:!!b.disabled}));
 const hpOf=side=>{const t=document.querySelector('#'+side+' .hp-line strong')?.textContent||'';const m=t.match(/(\\d+)\\s*\\/\\s*(\\d+)/);return m?Number(m[1]):null;};
 return {turn:$('turn')?.textContent||'',phase:$('phase')?.textContent||'',
  banner:$('action-banner')?.textContent||'',playerNote:$('player-side-note')?.textContent||'',
  enemyNote:$('enemy-side-note')?.textContent||'',message:$('message')?.textContent||'',
  playerActiveHp:hpOf('player'),enemyActiveHp:hpOf('enemy'),
  playerActiveName:document.querySelector('#player .pet-heading h3')?.textContent||'',
  enemyActiveName:document.querySelector('#enemy .pet-heading h3')?.textContent||'',
  cards,enabled:cards.filter(c=>!c.disabled).length,blocked:window.__blockedReplaceRequests||0,result:!$('result')?.hidden};
})()`;

test('PVP 对手宠物倒下时：界面说清是谁在补位，并且对局一定会自己继续',{timeout:240000},async t=>{
 if(!chromePath)return t.skip('本机没有 Chrome，跳过真浏览器端到端（见文件头说明）');
 const {server,base,close}=await startServer();
 let chrome=null;
 try{
  chrome=await connect(base);
  const {js,errors}=chrome;
  await js(`window.location.href=${JSON.stringify(base)}`).catch(()=>{});
  await chrome.send('Page.navigate',{url:base});
  await sleep(2500);
  await js(`(()=>{const d=[...document.querySelectorAll('dialog')].find(x=>x.open);if(d)d.querySelector('button')?.click();})()`);
  await sleep(200);

  // 进入 PVP（本地对战 → manualReplace）：只有这一模式才有"对手补位"这一步。
  await js(`document.getElementById('go-pvp').click()`);await sleep(400);
  await js(`(()=>{const s=document.getElementById('pvp-opponent');s.value='ai';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(250);
  // 固定种子：对手首发固定是草系苔盾菇，我方首发固定火系炽鬃狮，减员方向可预期。
  await js(`(()=>{const s=document.getElementById('seed');s.value='313';})()`);
  // 营地默认已经带着三只（烬尾狐/潮甲龟/芽角鹿），先清空再按顺序选。
  for(let i=0;i<6;i++){
   const removed=await js(`(()=>{const b=[...document.querySelectorAll('#roster [data-pet]')].find(x=>x.textContent.includes('移出队伍'));if(!b)return false;b.click();return true;})()`);
   if(!removed)break;
   await sleep(150);
  }
  // 我方队伍：炽鬃狮首发（火克草），另外两只挑最耐打的承伤位。
  for(const id of ['lion','turtle','rhino']){
   await js(`(()=>{const b=[...document.querySelectorAll('#roster [data-pet="${id}"]')].find(x=>x.textContent.includes('加入队伍'));if(b)b.click();})()`);
   await sleep(220);
  }
  await js(`(()=>{const s=document.getElementById('speed');if(s){s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await sleep(120);
  const selected=await js(`[...document.querySelectorAll('#selection .slot')].map(s=>s.textContent).join(',')`);
  assert.match(selected,/炽鬃狮/,`首发必须是炽鬃狮，实际选到：${selected}`);
  await js(`document.getElementById('start').click()`);await sleep(1200);
  assert.equal(await js(`document.getElementById('battle').hidden`),false,'没能进入对局');

  // 打到「对手的宠物倒下」当刻：我方减员就点免费补位继续，一路输出。
  let captured=null;
  for(let step=0;step<90&&!captured;step++){
   const s=await js(snapshotExpr);
   if(s.result){assert.fail('本场先结束了，没能走到对手补位那一步：'+JSON.stringify(s).slice(0,400));}
   const replacing=String(s.phase).includes('补位');
   if(replacing&&s.enabled===0&&s.enemyActiveHp===0){captured=s;break;}
   if(replacing&&s.enabled>0){ // 我方补位：点一张继续
    await js(`(()=>{const bs=[...document.querySelectorAll('#actions [data-action]:not([disabled])')];
     const c=bs.find(b=>b.textContent.includes('免费补位'))||bs[0];if(c)c.click();})()`);
    await sleep(700);continue;
   }
   await js(`(()=>{const t=[...document.querySelectorAll('#tabs button')].find(b=>b.dataset.tab==='skill');if(t&&!t.disabled)t.click();
    const bs=[...document.querySelectorAll('#actions [data-action]:not([disabled])')];
    const power=b=>{const m=b.textContent.match(/威力\\s*(\\d+)/);return m?Number(m[1]):-1;};
    const atks=bs.filter(b=>power(b)>0).sort((a,b)=>power(b)-power(a));
    const pick=atks[0]||bs[0];if(pick)pick.click();})()`);
   await sleep(750);
  }
  assert.ok(captured,'打满 90 步都没能走到「对手宠物倒下」的补位局面');

  // ① 这时玩家本来就点不动（引擎的补位一次只处理一侧），但界面必须说清等的是对手。
  assert.ok(captured.playerActiveHp>0,`对手补位时我方场上还应有存活宠物，实际 ${captured.playerActiveHp}`);
  assert.match(captured.banner,/对手/,'对手补位时横幅必须说明是**对手**在选人：'+captured.banner);
  assert.ok(!captured.banner.includes('请选择下一只出场'),'对手补位时不能叫玩家选下一只出场：'+captured.banner);
  assert.match(captured.phase,/对手/,`对手补位时的状态行应写明对手在补位，实际「${captured.phase}」`);
  assert.match(captured.playerNote,/对手/,`我方行动栏要说明等待对手补位，实际「${captured.playerNote}」`);
  assert.match(captured.enemyNote,/对手/,'对方行动栏的补位说明也不能指向玩家：'+captured.enemyNote);
  assert.ok(!captured.cards.some(c=>c.text.includes('免费补位')),'对手补位时我方的牌不能写「免费补位」：'+JSON.stringify(captured.cards.map(c=>c.text)));
  assert.ok(captured.blocked>=1,`测试没有真的掐住对手补位那次请求（blocked=${captured.blocked}），这条断言不算数`);

  // ② 玩家一下都不点，对局也必须自己走完这一步（看门狗用引擎的补位语义提交）。
  let resumed=null;
  const deadline=Date.now()+9000;   // 看门狗在"请求还在飞"这一档是 4.6 秒（4 秒预算 + 0.6 秒余量）
  while(Date.now()<deadline){
   const s=await js(snapshotExpr);
   if(!String(s.phase).includes('补位')&&s.enemyActiveHp>0){resumed=s;break;}
   await sleep(120);
  }
  assert.ok(resumed,`等了 9 秒对手的补位仍然没有落地（界面停在「${(await js(snapshotExpr)).phase}」）`);
  assert.notEqual(resumed.enemyActiveName,captured.enemyActiveName,'对手应该换上了另一只存活伙伴');
  assert.ok(resumed.enemyActiveHp>0,'补位后对手场上必须是存活宠物');

  // ③ 而且对局真的能继续：玩家再出一招，回合照常推进。
  const beforeTurn=resumed.turn;
  for(let i=0;i<12;i++){
   const s=await js(snapshotExpr);
   if(s.enabled>0){
    await js(`(()=>{const t=[...document.querySelectorAll('#tabs button')].find(b=>b.dataset.tab==='skill');if(t&&!t.disabled)t.click();
     const bs=[...document.querySelectorAll('#actions [data-action]:not([disabled])')];if(bs[0])bs[0].click();})()`);
    break;
   }
   await sleep(250);
  }
  await sleep(1500);
  const after=await js(snapshotExpr);
  assert.notEqual(after.turn,beforeTurn,`补位之后对局必须能继续，回合标签没有推进（${beforeTurn} → ${after.turn}）`);
  assert.equal(errors.length,0,'过程中不应有控制台报错：'+errors.slice(0,3).join(' | '));
 }finally{
  if(chrome)chrome.kill();
  await close();
 }
});

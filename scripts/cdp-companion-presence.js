#!/usr/bin/env node
/**
 * 陪练「在场方式」浏览器实测驱动（headless Chrome + CDP）。
 *
 * 目的：验证陪练气泡真的出现、位置不与操作区/军师条重叠、时长按字数计算、
 * 悬停暂停、以及控制台零报错。只读观察 + 真实点击，不通过 evaluate 改写游戏状态。
 *
 * 用法：
 *   node scripts/cdp-companion-presence.js --viewport=1440x900 --port=9340
 *   node scripts/cdp-companion-presence.js --viewport=1280x800 --port=9341 --out=reports/companion
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const CHROME_BIN=process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function parseArgs(argv){
 const out={viewport:'1440x900',port:9340,url:'http://127.0.0.1:8765/',out:'reports/companion',maxActions:60,speed:'0',seed:null,pace:260};
 for(const raw of argv.slice(2)){
  const m=/^--([^=]+)(?:=(.*))?$/.exec(raw);if(!m)continue;
  const k=m[1],v=m[2]===undefined?true:m[2];
  if(k==='viewport')out.viewport=String(v);
  else if(k==='port')out.port=Number(v);
  else if(k==='url')out.url=String(v);
  else if(k==='out')out.out=String(v);
  else if(k==='max-actions')out.maxActions=Number(v);
  else if(k==='speed')out.speed=String(v);
  else if(k==='seed')out.seed=Number(v);
  else if(k==='pace')out.pace=Number(v);
 }
 return out;
}
async function fetchJson(url){
 const r=await fetch(url);if(!r.ok)throw new Error(url+' → '+r.status);return r.json();
}
class Cdp{
 constructor(ws){
  this.ws=ws;this.seq=0;this.pending=new Map();this.listeners=new Map();
  ws.addEventListener('message',ev=>{
   let msg;try{msg=JSON.parse(ev.data);}catch{return;}
   if(msg.id!==undefined&&this.pending.has(msg.id)){
    const {resolve,reject}=this.pending.get(msg.id);this.pending.delete(msg.id);
    if(msg.error)reject(new Error(msg.error.message||'CDP error'));else resolve(msg.result);
   }else if(msg.method){for(const fn of [...(this.listeners.get(msg.method)||[])])fn(msg.params);}
  });
 }
 send(method,params={},timeoutMs=30000){
  const id=++this.seq;
  return new Promise((res,rej)=>{
   const t=setTimeout(()=>{this.pending.delete(id);rej(new Error(`CDP ${method} 超时`));},timeoutMs);
   this.pending.set(id,{resolve:v=>{clearTimeout(t);res(v);},reject:e=>{clearTimeout(t);rej(e);}});
   this.ws.send(JSON.stringify({id,method,params}));
  });
 }
 on(method,fn){if(!this.listeners.has(method))this.listeners.set(method,[]);this.listeners.get(method).push(fn);}
}

/* ---------------- 页面内探针（注入执行，只读 DOM） ---------------- */
function installProbe(){
 const S={events:[],errors:[],seen:[]};
 window.__companion=S;
 const norm=t=>String(t||'').replace(/\s+/g,' ').trim();
 const el=id=>document.getElementById(id);
 const rect=id=>{const n=el(id);if(!n||n.hidden)return null;const b=n.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),right:Math.round(b.right),bottom:Math.round(b.bottom)};};
 const overlap=(a,b)=>!!a&&!!b&&a.x<b.right&&b.x<a.right&&a.y<b.bottom&&b.y<a.bottom;
 const areaOf=id=>{const n=document.querySelector(id);if(!n)return null;const b=n.getBoundingClientRect();if(b.width<=0||b.height<=0)return null;return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),right:Math.round(b.right),bottom:Math.round(b.bottom)};};
 // 观测量：气泡自身的几何、与四类「不能被挡」的区域的相交、以及命中测试。
 S.probe=()=>{
  const bubble=rect('coach-bubble');
  const targets={
   skillArea:areaOf('#actions'),
   enemyPanel:areaOf('#panel-enemy'),
   sideCoach:areaOf('#player-coach:not([hidden])')||areaOf('#enemy-coach:not([hidden])'),
   bottomGrid:areaOf('#bottom-grid'),
   liveCoach:rect('live-coach'),
   attentionCue:rect('attention-cue'),
  };
  const collisions={};
  for(const [k,v] of Object.entries(targets))collisions[k]=overlap(bubble,v);
  let hit=null,hitIsBubble=null;
  if(bubble){
   const cx=bubble.x+bubble.w/2,cy=bubble.y+bubble.h/2;
   const h=(cx>=0&&cy>=0&&cx<innerWidth&&cy<innerHeight)?document.elementFromPoint(cx,cy):null;
   hit=h?(h.id||h.className||h.tagName)+'':null;
   hitIsBubble=!!h&&(h===el('coach-bubble')||el('coach-bubble').contains(h));
  }
  return {
   at:Date.now(),bubble,text:norm(el('bubble-text')&&el('bubble-text').textContent),
   name:norm(el('coach-bubble')&&el('coach-bubble').querySelector('.bubble-head strong')?.textContent),
   avatar:norm(el('bubble-avatar')&&el('bubble-avatar').textContent),
   liveText:el('live-coach')&&!el('live-coach').hidden?norm(el('live-coach').textContent).slice(0,120):null,
   viewport:{w:innerWidth,h:innerHeight},targets,collisions,hit,hitIsBubble,
   turn:norm(el('turn')&&el('turn').textContent),phase:norm(el('phase')&&el('phase').textContent),
  };
 };
 // 每次气泡显隐都记一条（MutationObserver 观察 hidden 属性）。
 const bubbleEl=el('coach-bubble');
 if(bubbleEl){
  const record=()=>{
   const p=S.probe();p.hidden=bubbleEl.hidden;
   S.events.push(p);
   if(!bubbleEl.hidden)S.seen.push(p);
  };
  new MutationObserver(record).observe(bubbleEl,{attributes:true,attributeFilter:['hidden']});
  const textEl=el('bubble-text');
  if(textEl)new MutationObserver(record).observe(textEl,{childList:true,characterData:true,subtree:true});
 }
 S.events=[];
 return 'installed';
}
// 记录气泡出现后到消失的毫秒数（用于核对时长公式）。
function installTimer(){
 if(window.__companionTimer)return 'already';
 const S={shows:[]};window.__companionTimer=S;
 const bubble=()=>document.getElementById('coach-bubble');
 let openAt=null,openText='';
 setInterval(()=>{
  const b=bubble();if(!b)return;
  const text=String(document.getElementById('bubble-text')?.textContent||'');
  if(!b.hidden&&openAt===null){openAt=Date.now();openText=text;}
  else if(!b.hidden&&text!==openText){S.shows.push({text:openText,ms:Date.now()-openAt,replaced:true});openAt=Date.now();openText=text;}
  else if(b.hidden&&openAt!==null){S.shows.push({text:openText,ms:Date.now()-openAt,replaced:false});openAt=null;openText='';}
 },120);
 return 'installed';
}

async function startChrome({port,viewport}){
 const profileDir=mkdtempSync(join(tmpdir(),'c19-chrome-'));
 const [w,h]=viewport.split('x').map(Number);
 const args=['--headless=new','--no-sandbox','--disable-gpu','--disable-breakpad','--disable-crash-reporter',
  `--crash-dumps-dir=${profileDir}`,`--remote-debugging-port=${port}`,'--remote-allow-origins=*',`--user-data-dir=${profileDir}`,
  '--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
  '--disable-sync','--disable-extensions','--disable-translate','--disable-features=Translate,MediaRouter,OptimizationHints',
  '--mute-audio','--hide-scrollbars',`--window-size=${w},${h}`,'about:blank'];
 const child=spawn(CHROME_BIN,args,{stdio:['ignore','pipe','pipe']});
 const stderr=[];child.stderr.on('data',d=>{const s=String(d).trim();if(s)stderr.push(s);});
 let version=null;
 for(let i=0;i<40;i++){
  try{version=await fetchJson(`http://127.0.0.1:${port}/json/version`);break;}
  catch{await sleep(500);}
 }
 if(!version)throw new Error('Chrome CDP 端口未就绪：'+stderr.slice(-3).join(' | '));
 await sleep(1200);
 let target=null;
 for(let i=0;i<20&&!target;i++){
  try{
   const list=await fetchJson(`http://127.0.0.1:${port}/json/list`);
   target=list.filter(t=>t.type==='page'&&t.webSocketDebuggerUrl).find(t=>!t.url||t.url==='about:blank')||list.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);
  }catch{/* 还没起来 */}
  if(!target)await sleep(400);
 }
 if(!target)throw new Error('没有可用的 page target');
 const ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((res,rej)=>{
  const t=setTimeout(()=>rej(new Error('CDP 连接超时')),15000);
  ws.addEventListener('open',()=>{clearTimeout(t);res();},{once:true});
  ws.addEventListener('error',()=>{clearTimeout(t);rej(new Error('CDP 连接失败'));},{once:true});
 });
 return {child,profileDir,ws,cdp:new Cdp(ws),version:version.Browser,stderr,width:w,height:h};
}
async function stopChrome(handle){
 if(!handle)return;
 try{handle.ws.close();}catch{}
 try{handle.child.kill('SIGTERM');}catch{}
 await sleep(1200);
 if(handle.child.exitCode===null){try{handle.child.kill('SIGKILL');}catch{}await sleep(600);}
 try{rmSync(handle.profileDir,{recursive:true,force:true});}catch{}
}

async function main(){
 const opt=parseArgs(process.argv);
 mkdirSync(opt.out,{recursive:true});
 const handle=await startChrome({port:opt.port,viewport:opt.viewport});
 const {cdp}=handle;
 const errors=[];
 cdp.on('Runtime.consoleAPICalled',p=>{if(p.type==='error')errors.push(p.args.map(a=>a.value??a.description).join(' '));});
 cdp.on('Runtime.exceptionThrown',p=>errors.push('EXCEPTION '+(p.exceptionDetails?.exception?.description||p.exceptionDetails?.text)));
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Log.enable');
 cdp.on('Log.entryAdded',p=>{if(p.entry.level==='error')errors.push('LOG '+p.entry.text+' @'+(p.entry.url||''));});
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:handle.width,height:handle.height,deviceScaleFactor:1,mobile:false});
 await cdp.send('Page.bringToFront');
 await cdp.send('Page.navigate',{url:opt.url});
 await sleep(2500);
 await cdp.send('Page.bringToFront');

 const evalJs=async(expr,awaitPromise=false)=>{
  const r=await cdp.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise});
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result.value;
 };
 const probe=async()=>JSON.parse(await evalJs('JSON.stringify(window.__companion?window.__companion.probe():null)'));
 const shoot=async name=>{
  const r=await cdp.send('Page.captureScreenshot',{format:'png'});
  const file=join(opt.out,name+'.png');writeFileSync(file,Buffer.from(r.data,'base64'));
  return file;
 };
 const click=async sel=>{
  const ok=await evalJs(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});if(!n||n.disabled)return false;n.click();return true;})()`);
  return ok;
 };

 const report={viewport:opt.viewport,port:opt.port,url:opt.url,chrome:handle.version,steps:[],shots:[],consoleErrors:errors,geometry:[],bubbleEvents:[],timings:[]};
 try{
  // 准备：走真实点击流程（与 scripts/cdp-long-game.js 一致）：欢迎弹窗 → 出征页 → 关卡 → 三只伙伴 → 开始
  const welcome=await evalJs(`!!document.querySelector('#coach-welcome[open]')`);
  if(welcome){await click('#coach-welcome [data-style="gentle"]');await sleep(400);}
  await click('#go-pve');await sleep(700);
  await evalJs(`(()=>{const s=document.querySelector('#stage-picker [data-stage]');if(s)s.click();return true;})()`);
  await sleep(300);
  // 默认队伍已经是 fox/turtle/deer；只在不足 3 只时才补，避免把默认队伍点掉。
  for(const pet of ['fox','turtle','deer']){
   const ready=await evalJs(`(()=>{const n=document.getElementById('start');return n?!n.disabled:false;})()`);
   if(ready)break;
   await click(`#roster [data-pet="${pet}"]`);
   await sleep(250);
  }
  await sleep(200);
  if(opt.seed!==null)await evalJs(`(()=>{const n=document.getElementById('seed');if(n)n.value='${opt.seed}';return true;})()`);
  await evalJs(`(()=>{const s=document.getElementById('speed');if(s)s.value=${JSON.stringify(opt.speed)};const d=document.getElementById('difficulty');if(d)d.value='easy';return true;})()`);
  await sleep(200);
  await evalJs(`(${installProbe.toString()})()`);
  await evalJs(`(${installTimer.toString()})()`);
  const ready=await evalJs(`(()=>{const n=document.getElementById('start');return n?!n.disabled:false;})()`);
  if(!ready)throw new Error('#start 被禁用（队伍不足 3 只）');
  await click('#start');
  await sleep(900);
  report.steps.push({step:'match-started',state:await probe()});

  const seenTexts=new Set();
  for(let i=0;i<opt.maxActions;i++){
   const st=await probe();
   if(st.bubble&&!seenTexts.has(st.text)){
    seenTexts.add(st.text);
    report.bubbleEvents.push({text:st.text,at:st.turn+' '+st.phase,collisions:st.collisions,overlapsOperation:st.collisions.skillArea||st.collisions.enemyPanel||st.collisions.sideCoach,withLiveBar:!!st.liveText,hitIsBubble:st.hitIsBubble,bubble:st.bubble,avatar:st.avatar,name:st.name});
    report.shots.push(await shoot('bubble-'+(report.bubbleEvents.length)));
    // 悬停暂停：把指针移到气泡上，等 3 秒确认它没有消失
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:st.bubble.x+st.bubble.w/2,y:st.bubble.y+st.bubble.h/2});
    await sleep(3000);
    const after=await probe();
    report.timings.push({text:st.text,len:st.text.length,stillVisibleAfterHover3s:!!after.bubble,visibleText:after.bubble?after.text:''});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:Math.round(handle.width/2),y:Math.round(handle.height/2)});
   }
   let acted=await click('#actions button.action:not([disabled])');
   if(!acted){
    const done=await evalJs(`document.getElementById('result')&&!document.getElementById('result').hidden`);
    if(done)break;
    // 可能是补位阶段：点第一个换宠
    await click('#tabs [data-tab="switch"]');await sleep(150);
    acted=await click('#actions button.action:not([disabled])');
    if(!acted)await click('#actions button:not([disabled])');
   }
   await sleep(opt.pace);
   const now=await probe();
   report.geometry.push({turn:now.turn,phase:now.phase,bubble:now.bubble,collisions:now.collisions,liveText:now.liveText});
   // 同时在场检查：气泡可见时军师条必须不可见
   if(now.bubble&&now.liveText)report.simultaneous=(report.simultaneous||0)+1;
   const done=await evalJs(`document.getElementById('result')&&!document.getElementById('result').hidden`);
   if(done)break;
  }
  report.steps.push({step:'match-end',state:await probe()});
  report.shots.push(await shoot('final'));
  const timer=await evalJs('JSON.stringify(window.__companionTimer?window.__companionTimer.shows:[])');
  report.observedDurations=JSON.parse(timer);
  report.domEvents=JSON.parse(await evalJs('JSON.stringify((window.__companion?.events||[]).slice(0,120))'));
  report.showHide=report.domEvents.map(e=>({hidden:e.hidden,text:(e.text||'').slice(0,26),bar:e.liveText?e.liveText.slice(0,20):null}));
 }catch(e){
  report.error=e.message;
  try{report.shots.push(await shoot('error'));}catch{}
 }
 await stopChrome(handle);
 report.consoleErrors=errors;
 writeFileSync(join(opt.out,'companion-presence-'+opt.viewport+'.json'),JSON.stringify(report,null,1));
 console.log(JSON.stringify({viewport:report.viewport,error:report.error||null,
  bubbleLines:report.bubbleEvents.map(b=>({text:b.text,overlapsOperation:b.overlapsOperation,withLiveBar:b.withLiveBar,collisions:b.collisions})),
  durations:report.observedDurations,
  simultaneous:report.simultaneous||0,
  showHide:(report.showHide||[]).map(x=>(x.hidden?'HIDE':'SHOW')+' bar='+(x.bar||'—')+' '+x.text),
  consoleErrors:errors.slice(0,8),shots:report.shots},null,1));
}
main().catch(e=>{console.error(e);process.exit(1);});

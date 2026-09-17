#!/usr/bin/env node
/**
 * 陪练「实际说了什么」浏览器实测驱动（headless Chrome + CDP）。
 *
 * 目的：在真实页面里连打几局，把陪练气泡真的显示出来的每一句话原样打印出来，
 * 连同它当时引用的事实依据（localStorage 里的 memory.events）。
 * 不用 evaluate 改游戏状态，只做真实点击；唯一一处「改数据」是 --backdate 把
 * 已经真实打完的那几局的时间戳往前挪，用来触发「隔了几天没玩」这一类观察，
 * 挪动本身会在输出里写明。
 *
 * 用法：
 *   node scripts/cdp-companion-lines.js --matches=3 --port=9340
 *   node scripts/cdp-companion-lines.js --matches=2 --backdate=6 --out=reports/companion-lines.json
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const CHROME_BIN=process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function parseArgs(argv){
 const out={viewport:'1440x900',port:9340,url:'http://127.0.0.1:8765/',out:'reports/companion-lines.json',matches:3,pace:320,backdate:0,maxActions:80,seed:null};
 for(const raw of argv.slice(2)){
  const m=/^--([^=]+)(?:=(.*))?$/.exec(raw);if(!m)continue;
  const k=m[1],v=m[2]===undefined?true:m[2];
  if(k in out)out[k]=typeof out[k]==='number'?Number(v):String(v);
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

/* 页面内探针：只读 DOM，记录每一次气泡真正显示出来的文本与当时的回合。 */
function installProbe(){
 const S={lines:[],season:0};window.__companionLines=S;
 const norm=t=>String(t||'').replace(/\s+/g,' ').trim();
 const el=id=>document.getElementById(id);
 const snap=()=>({
  text:norm(el('bubble-text')&&el('bubble-text').textContent),
  name:norm(el('coach-bubble')&&el('coach-bubble').querySelector('.bubble-head strong')?.textContent),
  avatar:norm(el('bubble-avatar')&&el('bubble-avatar').textContent),
  turn:norm(el('turn')&&el('turn').textContent),
  phase:norm(el('phase')&&el('phase').textContent),
  strategist:el('live-coach')&&!el('live-coach').hidden?norm(el('live-coach').textContent).slice(0,120):null,
  at:Date.now(),
 });
 const bubble=el('coach-bubble');
 if(bubble)new MutationObserver(()=>{
  if(bubble.hidden)return;
  const p=snap();
  if(p.text&&p.text!==S.lines.at(-1)?.text)S.lines.push(p);
 }).observe(bubble,{attributes:true,attributeFilter:['hidden']});
 const text=el('bubble-text');
 if(text)new MutationObserver(()=>{
  if(!bubble||bubble.hidden)return;
  const p=snap();
  if(p.text&&p.text!==S.lines.at(-1)?.text)S.lines.push(p);
 }).observe(text,{childList:true,characterData:true,subtree:true});
 return 'installed';
}

async function startChrome({port,viewport}){
 const profileDir=mkdtempSync(join(tmpdir(),'c19-lines-'));
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
  try{version=await fetchJson(`http://127.0.0.1:${port}/json/version`);break;}catch{await sleep(500);}
 }
 if(!version)throw new Error('Chrome CDP 端口未就绪：'+stderr.slice(-3).join(' | '));
 await sleep(1200);
 let target=null;
 for(let i=0;i<20&&!target;i++){
  try{
   const list=await fetchJson(`http://127.0.0.1:${port}/json/list`);
   target=list.filter(t=>t.type==='page'&&t.webSocketDebuggerUrl).find(t=>!t.url||t.url==='about:blank')||list.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);
  }catch{}
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
 const handle=await startChrome({port:opt.port,viewport:opt.viewport});
 const {cdp}=handle;
 const errors=[];
 const logs=[];
 cdp.on('Runtime.consoleAPICalled',p=>{const line=p.args.map(a=>a.value??a.description).join(' ');logs.push(p.type+': '+line);if(p.type==='error')errors.push(line);});
 cdp.on('Runtime.exceptionThrown',p=>errors.push('EXCEPTION '+(p.exceptionDetails?.exception?.description||p.exceptionDetails?.text)));
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Log.enable');
 cdp.on('Log.entryAdded',p=>{if(p.entry.level==='error')errors.push('LOG '+p.entry.text);});
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:handle.width,height:handle.height,deviceScaleFactor:1,mobile:false});
 await cdp.send('Page.bringToFront');
 await cdp.send('Page.navigate',{url:opt.url});
 await sleep(2500);
 await cdp.send('Page.bringToFront');
 const evalJs=async expr=>{
  const r=await cdp.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result.value;
 };
 const click=sel=>evalJs(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});if(!n||n.disabled)return false;n.click();return true;})()`);
 const memory=()=>evalJs(`(()=>{try{return JSON.parse(localStorage.getItem('xiaoya-memory-v1')||'null');}catch{return null;}})()`);
 const lines=()=>evalJs(`JSON.stringify(window.__companionLines?window.__companionLines.lines:[])`).then(JSON.parse);
 const report={url:opt.url,chrome:handle.version,viewport:opt.viewport,startedAt:new Date().toISOString(),matches:[],lines:[],consoleErrors:errors,note:opt.backdate?`第 ${opt.matches+1} 局前把已真实打完的记录时间戳往前挪了 ${opt.backdate} 天`:'未改动任何记录'};
 try{
  report.boot={memory:await memory(),welcome:await evalJs(`!!document.querySelector('#coach-welcome[open]')`),url:await evalJs(`location.href`)};
  const welcome=await evalJs(`!!document.querySelector('#coach-welcome[open]')`);
  if(welcome){await click('#coach-welcome [data-style="gentle"]');await sleep(400);}
  await evalJs(`(${installProbe.toString()})()`);
  const atCamp=()=>evalJs(`(()=>{const c=document.getElementById('camp-home');return !!(c&&!c.hidden);})()`);
  // 结算后点「返回营地」偶尔会被 busy 吃掉（busy 时 toCamp 直接 return），
  // 所以这里确认真的回到营地再开下一局，否则下一局的点击会落在上一局的界面上。
  const returnToCamp=async()=>{
   for(let i=0;i<8;i++){if(await atCamp())return true;await click('#restart');await sleep(700);}
   return atCamp();
  };
  const startMatch=async seed=>{
   await returnToCamp();
   await click('#go-pve');await sleep(700);
   await evalJs(`(()=>{const s=document.querySelector('#stage-picker [data-stage]');if(s)s.click();return true;})()`);
   await sleep(300);
   for(const pet of ['fox','turtle','deer']){
    const ready=await evalJs(`(()=>{const n=document.getElementById('start');return n?!n.disabled:false;})()`);
    if(ready)break;
    await click(`#roster [data-pet="${pet}"]`);await sleep(250);
   }
   await evalJs(`(()=>{const s=document.getElementById('speed');if(s)s.value='0';const d=document.getElementById('difficulty');if(d)d.value='normal';const n=document.getElementById('seed');if(n&&${seed!==null?`true`:`false`})n.value='${seed??''}';return true;})()`);
   await sleep(200);
   if(!await click('#start'))throw new Error('#start 被禁用（队伍不足 3 只）');
   await sleep(700);
  };
  for(let match=1;match<=opt.matches;match++){
   await startMatch(opt.seed===null?null:opt.seed+match);
   const before=await lines();
   for(let i=0;i<opt.maxActions;i++){
    const done=await evalJs(`(()=>{const r=document.getElementById('result');return !!(r&&!r.hidden);})()`);
    if(done){await sleep(19000);break;}   // 顶部条 17 秒后收起，陪练的收尾那句才轮得上
    let acted=await click('#actions button.action:not([disabled])');
    if(!acted){await click('#tabs [data-tab="switch"]');await sleep(150);acted=await click('#actions button.action:not([disabled])');}
    if(!acted)await click('#actions button:not([disabled])');
    await sleep(opt.pace);
   }
   const after=await lines();
   const fresh=after.slice(before.length);
   const mem=await memory();
   report.matches.push({match,turns:await evalJs(`(document.getElementById('turn')||{}).textContent||''`),
    lines:fresh.map(l=>`${l.turn} ${l.phase}｜${l.text}`),
    memoryEvents:(mem?.events||[]).map(e=>({result:e.result,stage:e.stage,turns:e.turns,firstFallen:e.firstFallen,enemy:e.enemy,left:e.items&&e.items.potion,time:String(e.time).slice(0,10)}))});
   report.matches.at(-1).backAtCamp=await returnToCamp();
  }
  if(opt.backdate){
   const shifted=await evalJs(`(()=>{const raw=localStorage.getItem('xiaoya-memory-v1');if(!raw)return 0;const m=JSON.parse(raw);const shift=${opt.backdate}*86400000;for(const e of m.events||[]){const t=Date.parse(e.time);if(Number.isFinite(t))e.time=new Date(t-shift).toISOString();}localStorage.setItem('xiaoya-memory-v1',JSON.stringify(m));return (m.events||[]).length;})()`);
   report.backdatedEvents=shifted;
   await cdp.send('Page.reload');await sleep(2200);await cdp.send('Page.bringToFront');
    await evalJs(`(${installProbe.toString()})()`);
   await startMatch(null);
   const before=await lines();
   for(let i=0;i<opt.maxActions;i++){
    const done=await evalJs(`(()=>{const r=document.getElementById('result');return !!(r&&!r.hidden);})()`);
    if(done){await sleep(19000);break;}   // 顶部条 17 秒后收起，陪练的收尾那句才轮得上
    let acted=await click('#actions button.action:not([disabled])');
    if(!acted){await click('#tabs [data-tab="switch"]');await sleep(150);acted=await click('#actions button.action:not([disabled])');}
    if(!acted)await click('#actions button:not([disabled])');
    await sleep(opt.pace);
   }
   const after=await lines();
   report.matches.push({match:`${opt.matches+1}（时间戳前移 ${opt.backdate} 天后）`,lines:after.slice(before.length).map(l=>`${l.turn} ${l.phase}｜${l.text}`)});
   await returnToCamp();
  }
  report.lines=(await lines()).map(l=>({turn:l.turn,phase:l.phase,text:l.text}));
 }finally{
  report.consoleErrors=errors;report.consoleLog=logs;
  mkdirSync(join(opt.out,'..'),{recursive:true});
  writeFileSync(opt.out,JSON.stringify(report,null,1));
  await stopChrome(handle);
 }
 // 直接打印实测结果
 console.log(`陪练实测（${opt.url}，Chrome ${report.chrome}，${opt.matches} 局${opt.backdate?` + 1 局（时间戳前移 ${opt.backdate} 天）`:''}）`);
 for(const m of report.matches){
  console.log(`\n── 第 ${m.match} 局${m.turns?`（${m.turns}）`:''} ──`);
  if(!m.lines.length)console.log('  （这一局陪练没有开口）');
  for(const line of m.lines)console.log('  '+line);
  if(m.memoryEvents)console.log('  记录：'+m.memoryEvents.map(e=>`${e.result}/${e.turns}回合/${e.stage}/${e.firstFallen||'-'}/${e.time}`).join(' ; '));
 }
 console.log(`\n控制台错误：${report.consoleErrors.length}${report.consoleErrors.length?' → '+report.consoleErrors.slice(0,3).join(' | '):''}`);
 console.log('报告：'+opt.out);
}
main().catch(async e=>{console.error(e);process.exitCode=1;});

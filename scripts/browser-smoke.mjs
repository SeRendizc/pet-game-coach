// 浏览器冒烟测试：跑一局真实对局，断言「控制台零报错」且「界面不卡死」。
//
// 这是 wiring.test.js 缺的那一半。静态检查能发现「没有调用点」「id 不存在」，
// 但发现不了「变量未定义」这类只在运行时才炸的问题。今天的实测反复证明：
//   · critical is not defined        → 每秒抛错，219 项测试全绿
//   · after is not defined           → 同样
//   · 敌方补位后无人提交              → 界面永久冻结，测试全绿
// 这三条都只有真跑起来才看得见。
//
// 用法：node scripts/browser-smoke.mjs [--keep-open]
// 前置：npm start 已在 127.0.0.1:8765 运行；本机有 Google Chrome。
// 刻意不放进 npm test：它需要浏览器，不适合在没有图形环境的机器上当作必过项。
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const BASE='http://127.0.0.1:8765/';
const PORT=9377;
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// favicon 是静态服务的固有 404，与本项目代码无关，单独忽略
const IGNORED=/favicon\.ico/;

async function main(){
 let serverUp=false;
 try{serverUp=(await fetch(BASE+'api/bootstrap',{signal:AbortSignal.timeout(4000)})).ok;}catch{}
 if(!serverUp){console.error('冒烟测试需要 127.0.0.1:8765 已在运行（npm start）');process.exit(2);}

 const profile=mkdtempSync(join(tmpdir(),'smoke-'));
 const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
  '--disable-crash-reporter',`--user-data-dir=${profile}`,`--remote-debugging-port=${PORT}`,
  '--window-size=1440,900','about:blank'],{stdio:'ignore'});
 const cleanup=()=>{try{chrome.kill();}catch{}try{rmSync(profile,{recursive:true,force:true});}catch{}};
 process.on('exit',cleanup);

 let list=null;
 for(let i=0;i<30&&!list;i++){await sleep(500);try{list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();}catch{}}
 if(!list){console.error('Chrome 没有在预期时间内起来');process.exit(2);}

 const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
 let id=0;const pending=new Map();const errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.rej(new Error(JSON.stringify(m.error))):x.res(m.result);return;}
  if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;
   const text=(d.exception?.description||d.text||'')+' @'+(d.url||'').split('/').pop()+':'+d.lineNumber;
   if(!IGNORED.test(text))errors.push(text.slice(0,160));}
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error'){
   const text=(m.params.args||[]).map(a=>a.value??a.description??'').join(' ');
   if(!IGNORED.test(text))errors.push(('console: '+text).slice(0,160));}};
 const send=(method,params={})=>{const i=++id;return new Promise((res,rej)=>{pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}));});};
 const js=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true});
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||'evaluate failed');
  return r.result.value;};

 await send('Runtime.enable');await send('Page.enable');
 await send('Page.bringToFront').catch(()=>{});   // 不 bringToFront 的话 document.hasFocus() 为 false，很多门控不会触发
 await send('Page.navigate',{url:BASE});await sleep(3200);

 // 首次引导弹窗会挡住操作
 await js(`(()=>{const d=[...document.querySelectorAll('dialog')].find(x=>x.open);if(d)d.querySelector('button')?.click();})()`);
 await sleep(400);

 const checks=[];
 const check=(name,ok,detail='')=>{checks.push({name,ok,detail});};

 // 营地：模块图没崩才会有伙伴卡
 check('营地渲染出伙伴卡',await js(`document.querySelectorAll('#camp-roster .pet-option').length`)===12);

 // 训练一局
 await js(`document.getElementById('go-pve').click()`);await sleep(400);
 await js(`document.getElementById('start').click()`);await sleep(1800);
 check('进入对局',await js(`!document.getElementById('battle').hidden`));

 // 一直打到分出结果；同时检测「按钮全不可用且没结束」= 卡死
 let stuck=0,maxStuck=0,turns=0,finished=false;
 for(let i=0;i<80;i++){
  const clicked=await js(`(()=>{const b=document.querySelectorAll('#actions [data-action]:not([disabled])')[0];if(!b)return false;b.click();return true;})()`);
  await sleep(850);
  finished=await js(`!!document.getElementById('result')&&!document.getElementById('result').hidden`);
  if(finished)break;
  if(clicked)turns++;else stuck++;
  maxStuck=Math.max(maxStuck,stuck);
  if(stuck>=15)break;
 }
 check('对局能打到结束',finished,`${turns} 次出招`);
 check('过程中没有卡死',maxStuck<15,`最长连续无可点 ${maxStuck} 次`);
 check('控制台零报错',errors.length===0,errors.slice(0,3).join(' | '));

 for(const c of checks)console.log(`${c.ok?'✓':'✗'} ${c.name}${c.detail?`  (${c.detail})`:''}`);
 const failed=checks.filter(c=>!c.ok);
 console.log(failed.length?`\n${failed.length} 项未通过`:'\n全部通过');
 process.exit(failed.length?1:0);
}
main().catch(e=>{console.error('冒烟测试异常：',e.message);process.exit(2);});

import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createCoachServer} from './server.js';
import {buildContext} from './coach/runtime.js';
import {newProfile} from './progression.js';
import {freshMemory} from './coach/memory.js';
import {createGame} from './engine.js';
const fixtureKey='sk-fixture-only-not-a-real-api-key';
async function setup(t,fetchImpl){const server=createCoachServer({fetchImpl});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port;let cookie='',boot;
 async function bootstrap(){const r=await fetch(base+'/api/bootstrap',{headers:cookie?{Cookie:cookie}:{}});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];boot=await r.json();return boot;}
 await bootstrap();
 async function post(path,data,extra={},options={}){return fetch(base+path,{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json','X-Coach-CSRF':boot.csrf,...extra},body:JSON.stringify(data),...options});}
 async function encrypted(){const key=await webcrypto.subtle.importKey('spki',Buffer.from(boot.publicKey,'base64'),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);return Buffer.from(await webcrypto.subtle.encrypt('RSA-OAEP',key,Buffer.from(JSON.stringify({key:fixtureKey,nonce:boot.nonce})))).toString('base64');}
 async function connect(){return post('/api/connect',{encryptedKey:await encrypted(),model:'deepseek-flash'});}
 return {server,base,post,bootstrap,connect,encrypted};
}
const ok=async()=>new Response(JSON.stringify({choices:[{message:{content:'连接成功'}}],usage:{prompt_tokens:8,completion_tokens:2}}),{status:200});
const chat=()=>({message:'这回合怎么打',role:'auto',context:buildContext(createGame(),newProfile(),'fox'),memory:freshMemory(),stateToken:17,conversation:[]});
test('browser-compatible ciphertext loads a memory-only credential and status never exposes it',async t=>{const x=await setup(t,ok);const r=await x.connect(),s=await r.json();assert.equal(r.status,200);assert.equal(s.configured,true);assert.equal(s.verified,false);assert(!JSON.stringify(s).includes(fixtureKey));assert(!JSON.stringify(await x.bootstrap()).includes(fixtureKey));});
test('encryption nonce is single-use and malformed ciphertext is rejected',async t=>{const x=await setup(t,ok),payload={encryptedKey:await x.encrypted(),model:'deepseek-flash'};assert.equal((await x.post('/api/connect',payload)).status,200);assert.equal((await x.post('/api/connect',payload)).status,409);assert.equal((await x.post('/api/connect',{...payload,encryptedKey:'garbage'})).status,400);});
test('cross-origin, missing CSRF, DNS rebinding and server source requests are blocked',async t=>{const x=await setup(t,ok);assert.equal((await x.post('/api/disconnect',{}, {Origin:'https://evil.example'})).status,403);assert.equal((await x.post('/api/disconnect',{}, {'X-Coach-CSRF':''})).status,403);const hostStatus=await new Promise((resolve,reject)=>{http.get(x.base+'/api/bootstrap',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(hostStatus,403);assert.equal((await fetch(x.base+'/server.js')).status,404);assert.equal((await fetch(x.base+'/server.test.js')).status,404);});
test('verification reaches only official HTTPS endpoint with bearer auth and marks verified',async t=>{let count=0;const x=await setup(t,async(url,args)=>{count++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(args.headers.Authorization,'Bearer '+fixtureKey);const b=JSON.parse(args.body);assert.equal(b.model,'deepseek-flash');assert.equal(b.max_tokens,24);assert.equal(args.redirect,'error');return ok();});await x.connect();assert.equal(count,0);const s=await(await x.post('/api/verify',{})).json();assert.equal(s.verified,true);assert.equal(count,1);});
test('invalid authentication reports safe errors without reflecting upstream response',async t=>{const x=await setup(t,async()=>new Response(fixtureKey,{status:401}));await x.connect();const r=await x.post('/api/verify',{}),text=await r.text();assert.equal(r.status,502);assert(!text.includes(fixtureKey));assert.match(text,/鉴权失败/);assert.equal((await x.bootstrap()).verified,false);});
test('unconfigured coach runs locally; configured coach uses model and preserves evidence',async t=>{let count=0;const x=await setup(t,async(url,args)=>{count++;if(JSON.parse(args.body).messages[0].content.includes('选择只读工具'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}));return ok();});let answer=await(await x.post('/api/coach',chat())).json();assert.equal(answer.provider,'local');assert.equal(count,0);await x.connect();answer=await(await x.post('/api/coach',chat())).json();assert.equal(answer.provider,'deepseek');assert.equal(answer.text,'连接成功');assert(answer.evidence.length>0);assert.equal(answer.stateToken,17);assert.equal(count,2);});
test('PVP gating occurs before remote invocation even when configured',async t=>{let count=0;const x=await setup(t,async()=>{count++;return ok();});await x.connect();const b=chat();b.context.mode='pvp-live';const answer=await(await x.post('/api/coach',b)).json();assert.equal(answer.route,'policy');assert.equal(count,0);});
test('disconnect clears configuration; blank output and malformed input fail safely',async t=>{const x=await setup(t,async()=>new Response(JSON.stringify({choices:[]})));await x.connect();assert.equal((await x.post('/api/verify',{})).status,502);assert.equal((await x.post('/api/coach',{message:'x'})).status,400);await x.post('/api/disconnect',{});assert.equal((await x.bootstrap()).configured,false);assert.equal((await x.post('/api/verify',{})).status,409);});
test('network errors are sanitized',async t=>{const x=await setup(t,async()=>{throw Error(fixtureKey);});await x.connect();const r=await x.post('/api/verify',{}),data=await r.text();assert.equal(r.status,502);assert(!data.includes(fixtureKey));assert.match(data,/网络连接失败/);});


test('client disconnect aborts the upstream model request',async t=>{
 let started,aborted;const ready=new Promise(r=>started=r),cancelled=new Promise(r=>aborted=r);
 const x=await setup(t,async(url,args)=>new Promise((resolve,reject)=>{
  started();const cancel=()=>{aborted();reject(new DOMException('cancelled','AbortError'));};
  if(args.signal.aborted)cancel();else args.signal.addEventListener('abort',cancel,{once:true});
 }));await x.connect();const controller=new AbortController();const pending=x.post('/api/coach',chat(),{}, {signal:controller.signal}).catch(e=>e.name);
 await ready;controller.abort();assert.equal(await pending,'AbortError');await Promise.race([cancelled,new Promise((_,reject)=>setTimeout(()=>reject(Error('upstream not aborted')),2000))]);
});
test('every local mode the client can send is accepted by the coach endpoint',async t=>{
 const {post,connect}=await setup(t,async()=>ok());
 await connect();
 // 客户端会发这几种 mode；服务端曾经漏掉 pvp-local，导致本地对战里模型解释
 // 永远被 400「教练上下文无效」挡掉，而规则建议照常返回，所以界面看不出错。
 for(const mode of ['camp','pve','pvp-local','pvp-live']){
  const payload=chat();
  payload.context={...payload.context,mode};
  if(mode!=='camp')payload.context.battle={...payload.context.battle,mode};
  const r=await post('/api/coach',payload);
  const body=await r.json();
  assert.notEqual(body.error,'教练上下文无效',`服务端必须接受 mode=${mode}`);
 }
});

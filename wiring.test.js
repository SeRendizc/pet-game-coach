import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// 接线自检：断言「入口到出口」真的连着，而不只是单元测试通过。
//
// 起因是今天连续出现的同一类缺陷——代码看着对、测试全绿、功能根本没生效：
//   · notify() 定义了但全仓库无调用点（陪练主动侧从不出现）
//   · rules.js 没进静态资源白名单（整页白屏）
//   · critical / after 引用了不存在的变量（每秒抛错，测试查不出）
//   · String(action) 把对象去重成一个（线上分支永不成立）
// 单元测试查不出这些，因为它们测的是函数本身，不是函数有没有被接上。
//
// 这里做两件能离线做、且确定性的检查：
//   1. app.js 里每个 $('id') 都必须在 index.html 里真实存在
//   2. app.js 里的局部函数不能有「定义了但从未调用」
// 浏览器侧的控制台报错检查在 scripts/browser-smoke.mjs（需要 Chrome）。

const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');

test('every id app.js looks up is declared in the HTML or created by app.js itself',()=>{
 // 有些面板是 app.js 运行时建出来的（配招编辑器、场景卡等），它们的 id 不会出现在
 // index.html 里。所以判定集合 = HTML 里的 id ∪ app.js 自己写入的 id。
 const declared=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
 for(const m of app.matchAll(/\bid="([^"]+)"/g))declared.add(m[1]);        // 模板字符串里建的
 for(const m of app.matchAll(/\.id='([^']+)'/g))declared.add(m[1]);        // 赋值方式建的
 for(const m of app.matchAll(/\.id=`([^`$]+)`/g))declared.add(m[1]);
 const used=[...new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(m=>m[1]))];
 const missing=used.filter(id=>!declared.has(id));
 assert.deepEqual(missing,[],`app.js 引用了不存在的 id：${missing.join('、')}`);
});

test('app.js dead functions are reported, not silently ignored',()=>{
 const defs=[...app.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(m=>m[1]);
 const dead=defs.filter(name=>{
  const hits=(app.match(new RegExp('\\b'+name+'\\b','g'))||[]).length;
  return hits<=1;
 });
 // 已知无害的遗留：统一面板渲染后不再需要，但删除它们时我两次切坏了 app.js，
 // 所以保留并在此登记。出现新的死函数会让这条失败——那正是提醒。
 assert.deepEqual(dead,['actionLabel','actionDetail'],
  `app.js 的死函数清单变了：${dead.join('、')}。若新增，请接上或按上面的说明登记。`);
});
test('every capability the interview asks for has an entry point wired',()=>{
 // 三种角色各自的入口：军师（局内提示）、老师（复盘/小测）、陪练（聊天/主动气泡）
 const entry={
  '军师·局内提示':/strategistEvaluate\(|updateCoach\(/,
  '老师·整局复盘':/showMatchReview\(/,
  '老师·小测':/pendingQuiz|live-quiz|quiz/,
  '陪练·聊天面板':/openCoach/,
  '陪练·主动气泡':/companionEvents\(/,
 };
 const missing=Object.entries(entry).filter(([,re])=>!re.test(app)).map(([k])=>k);
 assert.deepEqual(missing,[],`以下能力在 app.js 里找不到入口：${missing.join('、')}`);
});

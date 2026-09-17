// 抓取报告用的功能区域截图。
//
// 为什么不用整页截图：整页里 80% 是与该功能无关的面板，缩进 PDF 之后字全糊了。
// 这里用 CDP 的 clip 直接截取目标元素的外框，图小但字清楚，一张页面能放好几张。
//
// 视口刻意收窄到 1000 CSS px（见 WIDTH）：PDF 正文栏只有 453pt 宽，
// 一个整栏宽的元素在 1440 视口下有 1396 CSS px，缩到 453pt 就是 0.32pt/px，
// 14px 的字只剩 4.5pt——再清楚的原图也救不回来。收窄视口 + 只截目标元素，
// 才能同时满足「不裁糊」和「不小于栏宽 45%」。
//
// 用法：先确保 http://127.0.0.1:8765/ 在跑，然后 node report/tools/shots.mjs [阶段名]
// 阶段：camp deploy battle review pvp bubble all（默认 all，bubble 需要陪练先落地）
import {writeFileSync, mkdirSync, statSync} from 'node:fs';

const OUT = process.env.SHOT_OUT || 'report/figs';
// 每次跑用独立端口与独立 profile：先前几轮把 Chrome 留在了后台，新进程绑不上 9378，
// 脚本于是连到了**上一个** Chrome 上——SHOT_WIDTH=820 因此静默失效，
// 量出来的还是 1000 视口。截图脚本「看起来跑通了但参数没生效」比报错更难发现。
const PORT = Number(process.env.CDP_PORT || (9400 + (process.pid % 400)));
const WIDTH = Number(process.env.SHOT_WIDTH || 1000);
const HEIGHT = Number(process.env.SHOT_HEIGHT || 1080);
const STAGE = process.argv[2] || 'all';
const sleep = ms => new Promise(r => setTimeout(r, ms));

mkdirSync(OUT, {recursive: true});

// ── 起一个独立的 Chrome，不碰用户正在用的那个（也不碰 8765 上的服务）────────
const {spawn} = await import('node:child_process');
const profile = `tmp/shots-profile-${process.pid}`;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-crash-reporter',
   `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
   `--window-size=${WIDTH},${HEIGHT}`, 'about:blank'],
  {stdio: 'ignore', detached: true});
chrome.unref();
const shutdown = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch { try { chrome.kill('SIGKILL'); } catch {} } };
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(1); });
await sleep(5500);

// 报出真实视口：参数写错时能立刻看见，而不是等到量尺寸才发现没生效。
const probe = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(probe.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const {res, rej} = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) => {
  const i = ++id;
  return new Promise((res, rej) => { pending.set(i, {res, rej}); ws.send(JSON.stringify({id: i, method, params})); });
};
const js = async expr => {
  const r = await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true, userGesture: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 200));
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.bringToFront').catch(() => {});

// 已经截过的图：记录 CSS 尺寸，报告里算「渲染出来多宽、字多大」要用它。
const manifest = [];
const log = m => { manifest.push(m); console.log('   ' + JSON.stringify(m)); };

// 截一个选择器对应的元素（或其外接矩形），四周留一点边距。
// scale 是设备像素比：小元素给 3，整栏元素给 2 就够（PDF 里反正要缩）。
async function shot(selector, name, {pad = 8, scale = 2, minText = 0, all = false} = {}) {
  const rect = await js(`(()=>{
    const els = ${all ? `[...document.querySelectorAll(${JSON.stringify(selector)})]` : `[document.querySelector(${JSON.stringify(selector)})]`};
    const live = els.filter(e => e && !e.hidden && e.getBoundingClientRect().width >= 2);
    if (!live.length) return null;
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const e of live) { const r = e.getBoundingClientRect();
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom); }
    const text = live.map(e => (e.innerText || '').trim()).join(' ').trim();
    return {x: x1 + window.scrollX, y: y1 + window.scrollY, w: x2 - x1, h: y2 - y1, text: text.length};
  })()`);
  if (!rect) { console.log(`  ✗ 跳过 ${name}：找不到 ${selector}`); return false; }
  if (rect.text < minText) { console.log(`  ✗ 跳过 ${name}：正文只有 ${rect.text} 字（要求 ${minText}），元素还没说话`); return false; }
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    clip: {x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad),
           width: rect.w + pad * 2, height: rect.h + pad * 2, scale},
  });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const kb = Math.round(statSync(`${OUT}/${name}.png`).size / 1024);
  log({name, cssW: Math.round(rect.w), cssH: Math.round(rect.h), px: Math.round(rect.w * scale), kb, text: rect.text});
  return true;
}

// 依次点选 n 只。必须一次一个、每次重新查询：
// 点一下就会重渲染，同一个同步块里连点时后面几次点的是已脱离文档的节点。
// 注意选的是「第一张**未选中**的卡」：卡片的按钮在选中后会变成「移出队伍」，
// 每次都点第一张的话会在加/减之间来回振荡，永远凑不满三只（第一版就是这么写的）。
const pickPets = async (n, root = '#roster', btn = '[data-pet]') => {
  // 每次点完都数一遍实际选中数，按数量收敛而不是按点击次数。
  // 之前按次数循环，三轮之后却选中了 6 只（上限是 3）——与其去追脚本里那点时序问题，
  // 不如让循环以「结果」为准：够了就停，多了就撤回。
  const count = () => js(`document.querySelectorAll('${root} .pet-option.chosen').length`);
  for (let guard = 0; guard < 14; guard++) {
    const have = await count();
    if (have === n) return true;
    if (have > n) {
      await js(`document.querySelector('${root} .pet-option.chosen ${btn}')?.click()`);
    } else {
      const ok = await js(`(()=>{const b=document.querySelector('${root} .pet-option:not(.chosen) ${btn}');
        if(!b||b.disabled)return false;b.click();return true;})()`);
      if (!ok) break;
    }
    await sleep(450);
  }
  return (await count()) === n;
};

const go = async (url = 'http://127.0.0.1:8765/') => { await send('Page.navigate', {url}); await sleep(3400); };
const click = async (sel, ms = 600) => { const ok = await js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true;})()`); await sleep(ms); return ok; };
const dismiss = async () => {
  await js(`(()=>{const d=[...document.querySelectorAll('dialog')].find(x=>x.open);if(d)d.querySelector('button')?.click();})()`);
  await sleep(500);
};
// 等一个元素真的说出话来再截。军师条和陪练气泡都由局面触发，不是一进对局就有；
// 直接截会拿到一个空框（第一次跑出来只有 97×38，那就是个空框）。
const waitForText = async (sel, min = 20, tries = 24, nudge = true) => {
  for (let i = 0; i < tries; i++) {
    const n = await js(`(document.querySelector(${JSON.stringify(sel)})?.innerText||'').trim().length`);
    if (n >= min) return n;
    await sleep(700);
    if (nudge && (i === 6 || i === 12 || i === 18)) {
      await js(`(()=>{const b=document.querySelector('#actions button:not([disabled])');b&&b.click();})()`);
    }
  }
  return 0;
};

// 把播放速度设为最快，免得每一回合都在放动画、按钮一直处于禁用状态
const fastest = async () => { await js(`(()=>{const s=document.getElementById('speed');if(s){s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`); await sleep(1200); };

// 假装玩家在两个技能之间来回犹豫，好让军师真的开口。
// 军师的五条触发里，「犹豫」是唯一能稳定脚本化的一条：HESITATION 要求
// 8 秒内出现过 ≥3 次悬停、覆盖 ≥2 个不同选项。点击不算悬停——第一版脚本一直在点技能，
// 于是 24 次采样里军师一次都没说话，截出来的是空元素。
const hesitate = async (ms = 11000, picks = 2) => {
  const start = Date.now(); let i = 0;
  while (Date.now() - start < ms) {
    const idx = i % picks;
    await js(`(()=>{const bs=[...document.querySelectorAll('#actions button[data-action]')].filter(b=>!b.disabled);
      const b=bs[${idx}];if(!b)return false;
      const r=b.getBoundingClientRect(),o={bubbles:true,clientX:r.left+5,clientY:r.top+5};
      b.dispatchEvent(new PointerEvent('pointerover',o));b.dispatchEvent(new PointerEvent('pointerenter',o));return true;})()`);
    i++; await sleep(700);
  }
};

// 推进到对局结束（或次数用完）
const playOut = async (turns = 40) => {
  for (let i = 0; i < turns; i++) {
    const over = await js(`!document.getElementById('result').hidden || !!document.querySelector('#result:not([hidden])')`);
    if (over) return true;
    const ok = await js(`(()=>{const b=document.querySelector('#actions button:not([disabled])');if(!b)return false;b.click();return true;})()`);
    if (!ok) { await sleep(900); continue; }
    await sleep(1100);
  }
  return false;
};

const want = (...names) => STAGE === 'all' || names.includes(STAGE);
console.log(`抓取功能区域截图（阶段 ${STAGE}，视口 ${WIDTH}×${HEIGHT}，端口 ${PORT}）：`);
console.log('  实际视口:', await js('`${innerWidth}×${innerHeight} dpr=${devicePixelRatio}`'));

// ── 营地：单张伙伴卡 + 培养面板 + 老师的培养建议 ──────────────────────────
if (want('camp')) {
  console.log('· 营地与培养');
  await go();
  await dismiss();
  await shot('#camp-roster .pet-option:first-child', 'camp-card', {pad: 6, scale: 3, minText: 30});
  await shot('#cultivation', 'camp-cultivation', {pad: 8, scale: 2, minText: 30});
  // 培养建议默认可能被门控收起来，点开启的锚点把它展开
  await js(`(()=>{const a=document.getElementById('cultivation-coach');if(a&&!a.hidden)a.click();})()`);
  await sleep(800);
  await shot('#growth-advice', 'growth-advice', {pad: 8, scale: 3, minText: 20});
  // 展开「看数值对比」，让加点收益的表格出现在图里
  await click('#growth-advice details summary', 500);
  await shot('#growth-advice', 'growth-advice-table', {pad: 8, scale: 3, minText: 20});
}

// ── 出征：选关 + 阵容建议 + 选宠 ──────────────────────────────────────────
if (want('deploy')) {
  console.log('· 出征');
  await go();
  await dismiss();
  await click('#go-pve', 900);
  await shot('#stage-picker', 'deploy-stages', {pad: 8, scale: 2, minText: 10});
  await shot('#stage-detail', 'deploy-stage-detail', {pad: 6, scale: 3, minText: 10});
  await shot('#roster-advice', 'roster-advice', {pad: 6, scale: 3, minText: 10});
  await shot('#deploy-side', 'deploy-side', {pad: 8, scale: 2, minText: 10});
  const ok = await pickPets(3);
  console.log('   选好', await js(`document.querySelectorAll('#roster .pet-option.chosen').length`), '只 | pickPets:', ok);
  await shot('#roster', 'deploy-roster', {pad: 8, scale: 2, minText: 30});
}

// ── 对局：军师提示条 + 行动面板 + 战斗记录 + 战况 ─────────────────────────
if (want('battle')) {
  console.log('· 对局');
  await go();
  await dismiss();
  await click('#go-pve', 900);
  await pickPets(3);
  console.log('   start 禁用:', await js(`document.getElementById('start').disabled`));
  await click('#start', 2500);
  console.log('   battle 可见:', await js(`!document.getElementById('battle').hidden`));
  await fastest();
  const n = await waitForText('#live-coach', 24);
  console.log('   等军师开口:', n);
  await shot('#live-coach', 'coach-strip', {pad: 6, scale: 3, minText: 24});
  await shot('#actions', 'battle-actions', {pad: 8, scale: 2, minText: 20});
  await shot('.log-panel', 'battle-log', {pad: 8, scale: 2, minText: 20});
  await shot('#player-card', 'battle-arena', {pad: 6, scale: 2, minText: 30});
  // 展开军师的依据。#live-expand 是那一行的按钮，#live-detail 是它管的折叠区；
  // 先前的脚本按 '[data-expand],summary,button' 猜选择器，结果点到了顶栏的「回合回顾」上，
  // 截出来的两张图都是那个按钮，不是军师条。
  await click('#live-expand', 900);
  const open = await js(`!!document.querySelector('#live-detail:not([hidden])')`);
  console.log('   依据展开了:', open);
  await shot('#live-coach', 'coach-evidence', {pad: 6, scale: 2, minText: 40});
}

// ── 军师：提示条 + 展开的计算依据 ────────────────────────────────────────
// 单独一个阶段，因为它要用更窄的视口：PDF 正文栏只有 453pt，整栏宽的军师条
// 在 1000 视口下有 956 CSS px，缩到 426pt 时 12px 的依据正文只剩 5.3pt。
// 820 视口下同一条是 776 CSS px，同样的宽度能给出 7.1pt。
if (want('coach')) {
  console.log('· 军师提示条');
  await go();
  await dismiss();
  await click('#go-pve', 900);
  await pickPets(3);
  await click('#start', 2500);
  await fastest();
  await hesitate(11000);
  let n = 0;
  for (let i = 0; i < 24 && !n; i++) { n = await waitForText('#live-coach', 20, 1, false); if (!n) await sleep(900); }
  console.log('   等军师开口:', n);
  await shot('#live-coach', 'coach-strip', {pad: 6, scale: 3, minText: 20});
  await click('#live-expand', 900);
  console.log('   依据展开了:', await js(`!!document.querySelector('#live-detail:not([hidden])')`));
  // 「计算依据」是 #live-detail 里再套的一层 <details>，默认也是收起的。
  // 只点 #live-expand 截出来的只有那句结论——图注里说的「双方血量与能量、引用的知识卡」一张都没露。
  await click('#live-detail details summary', 800);
  console.log('   计算依据展开了:', await js(`!!document.querySelector('#live-detail details[open]')`));
  // 模型那句解释会在这几秒里替换掉规则文案，等它落地再截
  await sleep(6000);
  await shot('#live-coach', 'coach-evidence', {pad: 6, scale: 2, minText: 60});
}

// ── 对局：行动面板 + 战斗记录 + 战况 ─────────────────────────────────────
if (want('board')) {
  console.log('· 对局界面');
  await go();
  await dismiss();
  await click('#go-pve', 900);
  await pickPets(3);
  await click('#start', 2500);
  await fastest();
  await sleep(1500);
  await shot('#actions', 'battle-actions', {pad: 8, scale: 2, minText: 20});
  await shot('.log-panel', 'battle-log', {pad: 8, scale: 2, minText: 20});
  await shot('#player-card', 'battle-arena', {pad: 6, scale: 2, minText: 30});
  // 战况 + 行动面板 + 战斗记录合成一张：三块加起来才算「对局界面」。
  // 分开截的话每块只有半栏宽，缩到 PDF 里 12px 的正文只剩 5pt 多。
  await shot('#player-card, #action-banner, #bottom-grid', 'battle-board', {pad: 8, scale: 2, minText: 60, all: true});
}

// ── 老师：整局复盘 + 小测 ────────────────────────────────────────────────
if (want('review')) {
  console.log('· 老师');
  await go();
  await dismiss();
  await click('#go-pve', 900);
  await pickPets(3);
  await click('#start', 2500);
  await fastest();
  const done = await playOut(45);
  console.log('   打到结束:', done, '| result 可见:', await js(`!document.getElementById('result').hidden`));
  await sleep(2500);
  const n = await waitForText('#live-coach', 60, 12, false);
  console.log('   等复盘:', n);
  await shot('#live-coach', 'teacher-review', {pad: 6, scale: 2, minText: 60});
  // 展开「关键回合与依据」：复盘真正值钱的是它挑出来的三个回合
  await click('#live-coach details summary', 700);
  await shot('#live-coach', 'teacher-review-open', {pad: 6, scale: 2, minText: 60});
  // 小测：军师条里的「练一个知识点」
  if (await js(`!!document.getElementById('live-quiz')`)) {
    await click('#live-quiz', 1200);
    await shot('.live-quiz', 'teacher-quiz', {pad: 8, scale: 3, minText: 10});
  } else {
    console.log('   （没有 #live-quiz，小测走聊天面板）');
  }
}

// ── PVP：真人对局分屏（两边各一条教练）+ AI 对手 ─────────────────────────
if (want('pvp')) {
  console.log('· PVP');
  await go();
  await dismiss();
  await click('#go-pvp', 900);
  const human = await js(`(()=>{const s=document.getElementById('pvp-opponent');if(!s)return false;s.value='human';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await sleep(900);
  console.log('   切到真人分屏:', human, '| 对方选宠区可见:', await js(`!document.getElementById('pick-side-enemy').hidden`));
  await pickPets(3, '#roster');
  // 对手那一栏的按钮是 data-enemy-pet，不是 data-pet：拿同一个选择器去点会静默 0 只，
  // 于是 #start 一直禁用，整段 PVP 分屏一张都截不到。
  await pickPets(3, '#roster-enemy', '[data-enemy-pet]');
  console.log('   我方', await js(`document.querySelectorAll('#roster .pet-option.chosen').length`), '只 | 对方', await js(`document.querySelectorAll('#roster-enemy .pet-option.chosen').length`), '只');
  await click('#start', 3000);
  await fastest();
  await sleep(1500);
  await shot('#panel-player', 'pvp-player', {pad: 8, scale: 2, minText: 20});
  await shot('#panel-enemy', 'pvp-enemy', {pad: 8, scale: 2, minText: 20});
  await shot('#player-coach', 'pvp-player-coach', {pad: 6, scale: 3, minText: 6});
  await shot('#enemy-coach', 'pvp-enemy-coach', {pad: 6, scale: 3, minText: 6});

  // AI 对手那一档
  await go();
  await dismiss();
  await click('#go-pvp', 900);
  await pickPets(3, '#roster');
  await click('#start', 3000);
  await fastest();
  await sleep(1500);
  await shot('#panel-enemy', 'pvp-ai-enemy', {pad: 8, scale: 2, minText: 20});
}

// ── 陪练：左下角气泡（由真实对局事件触发，必须等它出现）─────────────────
if (want('bubble')) {
  console.log('· 陪练气泡');
  await go();
  await dismiss();
  await click('#go-pve', 900);
  await pickPets(3);
  await click('#start', 2500);
  await fastest();
  // 气泡露面后可能立刻被军师条顶掉（两者不同时在场），所以不能「等到有字就截一次」：
  // 第一版就是这么写的，waitForText 报 15 个字，紧接着的 shot 已经找不到元素了。
  // 改成在同一个循环里反复试：能看到就截，截到就停。
  let got = false;
  for (let i = 0; i < 45 && !got; i++) {
    got = await shot('#coach-bubble', 'companion-bubble', {pad: 8, scale: 3, minText: 12});
    if (!got) {
      await sleep(1100);
      await js(`(()=>{const b=document.querySelector('#actions button:not([disabled])');b&&b.click();})()`);
    }
  }
  console.log('   陪练气泡截到了:', got);
}

writeFileSync('tmp/sheet/manifest.json', JSON.stringify(manifest, null, 1));
console.log(`完成，共 ${manifest.length} 张。清单 → tmp/sheet/manifest.json`);
process.exit(0);

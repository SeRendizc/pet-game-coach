// 重拍报告里过时的截图。
//
// 与 shots.mjs 的关系：shots.mjs 是「每个阶段截一组固定元素」，它假定
// 图上那块内容随时都在。这次要重拍的四张里有两张不是这样——
//   · 军师条由局面触发，进去是空的；
//   · 陪练气泡由**这一回合刚发生的事**触发，说什么取决于打出了什么，
//     而且旧的统计腔和新的有温度的话走的是不同的观察分支。
// 所以这里沿用 shots.mjs 那套辅助函数（pickPets / waitForText / hesitate 的坑都在注释里），
// 但加了一层「先探再截」：把每一句真的说出口的话记下来，命中目标文案才按快门。
//
// 四条坑，都是实测踩出来的，改这个脚本时别退回去：
//   1) **视口宽度决定字号**。军师／复盘原来在 1000px 视口拍，按栏宽印出来正文只有
//      4.9/5.2pt（糊）。680px 视口下同样是 12~13px 的字，印出来是 7.2/7.7pt。
//   2) **#coach-bubble 是 position:fixed**，会飘进别的元素的框里被一起裁进去。
//      拍之前点 #bubble-close——它同时把这一局的 coachSession.dismissed 置真。
//   3) **裁剪高度按元素自己的 getBoundingClientRect() 算，绝不能给固定值**。
//      老师复盘的展开区高度随内容变，拍脑袋给一个数字就会变成「内容切一半、底下拖一片空白」。
//   4) **clip 必须整个落在当前视口里**。Page.captureScreenshot 默认
//      captureBeyondViewport:false 时只渲染视口内那部分，伸出去的一块回填成页面底色，
//      看起来就像元素自己被裁了。这正是 teacher-review.png 断掉的真因（见下面 shot() 的注释）。
//
// 用法：先确保 http://127.0.0.1:8765/ 在跑，然后
//   node report/tools/reshoot.mjs probe 12     # 只打，不说话，把气泡文案记下来
//   node report/tools/reshoot.mjs bubble 14    # 打到有温度的那句为止，命中就截
//   node report/tools/reshoot.mjs coach        # 军师条：短提示 + 展开的计算依据
//   node report/tools/reshoot.mjs review       # 老师的整局复盘
//   node report/tools/reshoot.mjs static       # 其余没被引用/待核对的那几张
import {writeFileSync, mkdirSync, statSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {decodePng, decodePngBuffer, pixel, rowProfile, stackPng, writePng} from './png.mjs';

const OUT = process.env.SHOT_OUT || 'report/figs';
// 独立端口 + 独立 profile（沿用 shots.mjs 的教训：端口撞上会静默连到上一个 Chrome，
// 参数失效却不报错）。这次还多一条：**profile 必须每次是新的**——
// 存档全在 localStorage 里（xiaoya-memory-v1 / xiaoya-last-round / xiaoya-save），
// 带着旧数据跑，陪练会先说「这套阵容你打过几次」「隔了几天」这类跨局的话，
// 把这一局真正该说的那句挤掉。
const PORT = Number(process.env.CDP_PORT || (9500 + (process.pid % 400)));
// 军师／复盘这两张原来在 1000px 视口拍，按栏宽印出来正文只有 4.9/5.2pt（糊）。
// 680px 视口下同样是 12~13px 的字，印出来是 7.2/7.7pt。视口窄，字就相对大。
const WIDTH = Number(process.env.SHOT_WIDTH || 680);
const HEIGHT = Number(process.env.SHOT_HEIGHT || 1080);
// 自检用：强制切片高度，验证「一屏装不下就往下滚、拼回整张」那条路真的通。
const FORCE_SLICE = Number(process.env.SHOT_FORCE_SLICE || 0);
const STAGE = process.argv[2] || 'probe';
const ROUNDS = Number(process.argv[3] || 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));

mkdirSync(OUT, {recursive: true});
mkdirSync('tmp/sheet', {recursive: true});

const {spawn} = await import('node:child_process');
const profile = `tmp/reshoot-profile-${process.pid}`;
// 清掉同名的旧目录：万一 pid 撞上，也不至于捡到上一轮留下的存档。
if (existsSync(profile)) rmSync(profile, {recursive: true, force: true});
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
console.log(`重拍（阶段 ${STAGE}，视口 ${WIDTH}×${HEIGHT}，端口 ${PORT}）`);
console.log('  实际视口:', await js('`${innerWidth}×${innerHeight} dpr=${devicePixelRatio}`'));
// 截图没通过像素校验的，收尾时集中报一次——不要让一张断图混在「✓」里过去。
const BAD_SHOTS = [];

// ── 截图 ────────────────────────────────────────────────────────────────
// teacher-review.png 断成两截，原因不在元素上，而在**截图姿势**上：
// Page.captureScreenshot 在默认 captureBeyondViewport:false 时，只渲染当前视口内的那块；
// clip 伸出视口的部分一律回填成页面底色。表现就是「文字被折叠线从中间切开 + 底下补一大片
// 空白」——折叠线下那一行根本没渲染，不是元素被裁。（实测见 tmp/probe-clip.mjs：
// 同一个元素，滚进视口后按同样的页面坐标截就完好；不滚、直接用同一坐标截就是空白。）
//
// 那为什么不用 captureBeyondViewport:true 一步解决？因为它会让 Chrome 把内部视口撑到整页高，
// 而 #coach-panel 是 position:fixed + top/bottom 撑满的，会被拉成一整页高——凡是含陪练
// 面板的图（teacher-roles、pvp-*）都会跟着变形。所以这里守住一条不变的规则：
//   **clip 必须整个落在当前视口里。**
//   1) 元素已经在视口内 → 不动，按原样截（不动构图，别的图不受影响）；
//   2) 装得下但露在外面 → 先滚进去，滚完**重新量一次**（fixed 元素的页面坐标会随滚动变）；
//   3) 一屏确实装不下 → 按视口高度切片，逐片滚到视口顶截一张，再按已知偏移拼回整张。
// 裁剪高度一律来自元素自己的 getBoundingClientRect()，不给任何固定值：
// 老师复盘那块的高度随内容变，拍脑袋给数字就是当初那张图断掉的原因。
const measure = (selector, all) => js(`(()=>{
  const els = ${all ? `[...document.querySelectorAll(${JSON.stringify(selector)})]` : `[document.querySelector(${JSON.stringify(selector)})]`};
  const live = els.filter(e => e && !e.hidden && e.getBoundingClientRect().width >= 2);
  if (!live.length) return null;
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (const e of live) { const r = e.getBoundingClientRect();
    x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom); }
  const text = live.map(e => (e.innerText || '').trim()).join(' ').trim();
  const vp = {innerH: innerHeight, innerW: innerWidth, scrollY: scrollY,
    maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight)};
  // 图上最小的那号字：段落常比容器小一号（#live-detail p 是 13px，容器是 12px），
  // 印出来够不够大，看的是最小的那号。
  let fontPx = null;
  for (const e of live) for (const d of [e, ...e.querySelectorAll('*')]) {
    if (![...d.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const f = parseFloat(getComputedStyle(d).fontSize);
    if (f && (fontPx === null || f < fontPx)) fontPx = f;
  }
  return {x: x1 + window.scrollX, y: y1 + window.scrollY, w: x2 - x1, h: y2 - y1, text: text.length, fontPx, ...vp};
})()`);

const scrollTo = y => js(`(()=>{const m=Math.max(0,document.documentElement.scrollHeight-innerHeight);
  scrollTo(0, Math.min(Math.max(0, ${Math.round(y)}), m)); return scrollY;})()`);

// 截完立刻回读像素：元素底边那几行还在不在、底下有没有多出废白。
// 这一步是机械拦截——「看着像截全了」正是当初那张断图混过去的方式。
function verify(file, {h, pad, scale}) {
  const img = decodePng(file);
  const base = pixel(img, 1, 1).slice(0, 3);
  const prof = rowProfile(img, base);
  let last = -1;
  prof.forEach((n, y) => { if (n > img.width * 0.02) last = y; });
  const dead = img.height - 1 - last;                       // 设备像素
  const expected = Math.round((h + pad * 2) * scale);
  const okH = Math.abs(img.height - expected) <= Math.max(2, scale * 2);
  const okDead = dead <= (pad + 6) * scale;
  return {img, deadCss: +(dead / scale).toFixed(1), ok: okH && okDead, okH, okDead};
}

async function shot(selector, name, {pad = 8, scale = 2, minText = 0, all = false, frac = null} = {}) {
  let rect = await measure(selector, all);
  if (!rect) { console.log(`  ✗ 跳过 ${name}：找不到 ${selector}`); return false; }
  if (rect.text < minText) { console.log(`  ✗ 跳过 ${name}：正文只有 ${rect.text} 字（要求 ${minText}），元素还没说话`); return false; }

  const geom = r => ({clipX: Math.max(0, r.x - pad), top: Math.max(0, r.y - pad),
    width: r.w + pad * 2, height: r.h + pad * 2,
    inView: Math.max(0, r.y - pad) >= r.scrollY - 0.5 && Math.max(0, r.y - pad) + r.h + pad * 2 <= r.scrollY + r.innerH});
  let g = geom(rect);
  const fits = rect.h + pad * 2 <= rect.innerH - 4 && FORCE_SLICE === 0;
  let pieces = [];

  if (fits) {
    // 已经在视口里就别动它（滚一下可能让别的元素挪位，把别的图的构图改掉）。
    if (!g.inView) {
      await scrollTo(g.top);
      await sleep(260);
      const again = await measure(selector, all);   // fixed 元素的页面坐标会随滚动变
      if (again) {
        if (Math.abs(again.h - rect.h) > 1) console.log(`  · ${name}：滚动后内容高度 ${Math.round(rect.h)}→${Math.round(again.h)}，按新值裁`);
        rect = again; g = geom(rect);
      }
    }
    if (g.inView) {
      const r = await send('Page.captureScreenshot', {
        format: 'png', clip: {x: g.clipX, y: g.top, width: g.width, height: g.height, scale},
      });
      writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
    } else {
      // 复量之后仍不在视口里（滚动被文档底部卡住之类）：宁可切片，也不交一张会被折叠线切开的图。
      console.log(`  · ${name}：滚完仍不在视口内，改走切片`);
      pieces = await slice(rect, {pad, scale, clipX: g.clipX, width: g.width});
    }
  } else {
    pieces = await slice(rect, {pad, scale, clipX: g.clipX, width: g.width});
  }

  if (pieces.length) {
    const img = stackPng(pieces);
    writePng(`${OUT}/${name}.png`, img);
    console.log(`  · ${name}：整块 ${Math.round(rect.h)}css 高，一屏装不下，切了 ${pieces.length} 片拼回`);
  }

  const file = `${OUT}/${name}.png`;
  const v = verify(file, {h: rect.h, pad, scale});
  const kb = Math.round(statSync(file).size / 1024);
  const pt = frac && rect.fontPx ? (rect.fontPx / rect.w) * frac * 453.5 : null;
  console.log(`  ${v.ok ? '✓' : '⚠'} ${name}  ${Math.round(rect.w)}×${Math.round(rect.h)} css → ${v.img.width}px  ${kb}KB  ` +
    `${rect.text}字  底部留白 ${v.deadCss}css${pt ? `  最小字号 ${rect.fontPx}px → 插入 ${frac} 栏宽约 ${pt.toFixed(1)}pt` : ''}`);
  if (!v.ok) {
    console.log(`      ⚠ 校验没过：图片高 ${v.img.height}，按元素算应是 ${Math.round((rect.h + pad * 2) * scale)}` +
      `${v.okH ? '' : '（高度不符）'}${v.okDead ? '' : '（底部废白过多）'}`);
    BAD_SHOTS.push(name);
  }
  return true;
}

// 一屏装不下的元素：按视口高度切片，每片滚到 clip 顶边贴着视口顶再截，按顺序摞起来。
// 每片的起点都来自上一片**实际截到的高度**，所以既不会漏行也不会重复。
async function slice(rect, {pad, scale, clipX, width}) {
  const innerH = await js('innerHeight');
  const top = Math.max(0, rect.y - pad);
  const total = rect.h + pad * 2;
  const step = FORCE_SLICE > 0 ? FORCE_SLICE : Math.max(120, innerH - 2 * pad - 8);
  const pieces = [];
  let off = 0;
  while (off < total) {
    const sliceTop = top + off;
    const sy = await scrollTo(sliceTop);
    await sleep(220);
    const room = Math.round(sy + innerH - sliceTop);      // clip 顶边以下还剩多少在视口里
    const h = Math.min(step, total - off, room);
    if (h <= 0) throw new Error(`切片失败：偏移 ${off} 落在视口外（scrollY=${sy}, innerH=${innerH}）`);
    const r = await send('Page.captureScreenshot', {
      format: 'png', clip: {x: clipX, y: sliceTop, width, height: h, scale},
    });
    const img = decodePngBuffer(Buffer.from(r.data, 'base64'), `第${pieces.length + 1}片`);
    pieces.push({img, from: 0, to: img.height});
    off += h;
  }
  return pieces;
}


// 选宠：必须点「未选中」的卡，并且按**结果**收敛（按点击次数会在加/减之间振荡）。
const pickPets = async (n, root = '#roster', btn = '[data-pet]') => {
  const count = () => js(`document.querySelectorAll('${root} .pet-option.chosen').length`);
  for (let guard = 0; guard < 14; guard++) {
    const have = await count();
    if (have === n) return true;
    if (have > n) await js(`document.querySelector('${root} .pet-option.chosen ${btn}')?.click()`);
    else {
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
const fastest = async () => { await js(`(()=>{const s=document.getElementById('speed');if(s){s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`); await sleep(1200); };

// 把陪练气泡收掉。#coach-bubble 是 position:fixed，会飘到别的元素上面；
// 「截某个元素的框」是按坐标裁的，飘过来的气泡就一起被裁进图里——
// 实测复盘那张拍到一半，右边的正文被一个「第13回合这一下太憋屈了」的气泡盖住。
// 点 #bubble-close 不只是藏起来：它会把这一局的 coachSession.dismissed 置真，
// 陪练这一局不再开口，所以拍完不会再飘回来。
const hideBubble = async () => {
  const closed = await js(`(()=>{const b=document.getElementById('coach-bubble');
    if(!b||b.hidden)return false;document.getElementById('bubble-close')?.click();return true;})()`);
  await sleep(400);
  return closed;
};

// 军师由局面触发。五条触发里只有「犹豫」能稳定脚本化：
// HESITATION 要求 8 秒内 ≥3 次悬停、覆盖 ≥2 个不同选项。**点击不算悬停**。
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

// 陪练气泡的观察器。**不能靠轮询**：气泡会自己消失，也可能在两次 sleep 之间露一下就没了。
// 挂一个 MutationObserver 记录每一个真的显示过的句子，探阶段就是靠它把话说全。
const armBubbleLog = () => js(`(()=>{
  window.__bubbles = window.__bubbles || [];
  const take = () => {
    const box = document.getElementById('coach-bubble');
    const t = document.getElementById('bubble-text');
    if (!box || box.hidden || !t) return;
    const s = t.textContent.trim();
    if (s && (!window.__bubbles.length || window.__bubbles[window.__bubbles.length-1].text !== s))
      window.__bubbles.push({text: s, at: Date.now()});
  };
  if (window.__bubbleObs) window.__bubbleObs.disconnect();
  window.__bubbleObs = new MutationObserver(take);
  window.__bubbleObs.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden']});
  take();
  return true;
})()`);
const bubbleLog = () => js(`window.__bubbles || []`);
// 覆盖到「这一局」为止：换局时把日志截断，免得把上一局的句子算进来。
const trimBubbleLog = () => js(`(()=>{const n=(window.__bubbles||[]).length;window.__bubbleMark=n;return n;})()`);
const bubblesSinceMark = () => js(`(window.__bubbles||[]).slice(window.__bubbleMark||0)`);

// 有温度：情绪落在**这一手/这一刻**上，或落在玩家自己的处境上。
// 旧的统计腔是「对面打出的 N 点伤害里，有 M 点落在 X 身上。X 一个人顶了 K 个回合」——
// 那种句子把整局翻一遍算出来，读起来像战报，不像有人在旁边。
const WARM = /撑住了|能喘口气|可惜|没接住|没补上|漂亮|打回来了|真悬|憋屈|松口气|到这儿也行|先歇会儿|这么晚了|过了零点|今天累了|没精神啊|困了啊|烦啊|难受啊|压力大啊|撑不住了啊|不痛快/;
const COLD = /落在.{1,8}身上|一个人顶了|挨的比|没打出输出/;
// 首选「贴着血皮撑过来」那一条（第10回合潮甲龟只剩16点…这一下撑住了，能喘口气）。
// 挑它不只是因为它最暖：它第一句是「**这一局**场上最低的一次」——
// 一个必须把整局翻一遍才数得出来的读数，第二句才是情绪。
// 报告正文（02-delivery.tex）讲陪练「每一句都要落在一件玩家自己算不出来的事上」，
// 拿这一条当图，那句话照样成立；换成纯情绪的收尾句就把那一段论证掏空了。
const BEST = /撑住了|能喘口气/;
const isWarm = t => WARM.test(t) && !COLD.test(t);

// 打完一局：每回合点第一个可用的行动。返回是否打到了结算。
const playOut = async (turns = 60) => {
  for (let i = 0; i < turns; i++) {
    const over = await js(`!document.getElementById('result').hidden`);
    if (over) return true;
    const ok = await js(`(()=>{const b=document.querySelector('#actions button:not([disabled])');if(!b)return false;b.click();return true;})()`);
    if (!ok) { await sleep(900); continue; }
    await sleep(1000);
  }
  return false;
};

// 开一局 PVE，停在玩家该出第一手的地方。
const enterBattle = async () => {
  await go();
  await dismiss();
  await click('#go-pve', 900);
  await pickPets(3);
  await click('#start', 2500);
  await fastest();
};

// ── 探：只打，把每一句真正说出口的气泡文案记下来 ──────────────────────────
if (STAGE === 'probe' || STAGE === 'bubble') {
  const found = [];
  let bestShot = false;   // 首选那条（撑住了／能喘口气）
  let warmShot = false;   // 退而求其次：任何一条有温度的
  const hunting = () => STAGE === 'bubble' && !bestShot;
  // 前几局只要首选；要是跑掉大半还没碰上，就退而接受任意一条有温度的。
  const desperate = g => g >= Math.ceil(ROUNDS * 0.7);
  const consider = async (cur, g, when) => {
    if (!cur || !isWarm(cur)) return;
    if (BEST.test(cur)) {
      console.log(`  第 ${g} 局${when}命中首选：${JSON.stringify(cur)}`);
      bestShot = await shot('#coach-bubble', 'companion-bubble', {pad: 8, scale: 3, minText: 12, frac: 0.46});
    } else if (desperate(g) && !warmShot) {
      console.log(`  第 ${g} 局${when}退而求其次：${JSON.stringify(cur)}`);
      warmShot = await shot('#coach-bubble', 'companion-bubble', {pad: 8, scale: 3, minText: 12, frac: 0.46});
    }
  };
  for (let g = 1; g <= ROUNDS && !(STAGE === 'bubble' && bestShot); g++) {
    await enterBattle();
    await armBubbleLog();
    await trimBubbleLog();
    const started = Date.now();
    let done = false;
    // 一局最多打 90 拍（每拍 ~1.1s）。中途命中目标文案就立刻按快门——
    // 气泡 15 秒起就自己走，等打完再回头截是截不到的。
    for (let i = 0; i < 90 && !done; i++) {
      done = await js(`!document.getElementById('result').hidden`);
      if (done) break;
      const ok = await js(`(()=>{const b=document.querySelector('#actions button:not([disabled])');if(!b)return false;b.click();return true;})()`);
      if (!ok) { await sleep(800); continue; }
      await sleep(950);
      if (hunting()) {
        const cur = await js(`(()=>{const b=document.getElementById('coach-bubble');return b&&!b.hidden?document.getElementById('bubble-text').textContent.trim():'';})()`);
        await consider(cur, g, '');
      }
    }
    await sleep(2500);
    // 结算之后还会再说一句（收尾那句），它同样是候选人：再给它几秒。
    if (hunting()) {
      for (let i = 0; i < 8 && !bestShot; i++) {
        const cur = await js(`(()=>{const b=document.getElementById('coach-bubble');return b&&!b.hidden?document.getElementById('bubble-text').textContent.trim():'';})()`);
        await consider(cur, g, '结算');
        await sleep(900);
      }
    }
    const said = await bubblesSinceMark();
    const res = await js(`(document.getElementById('result')?.innerText||'').trim().slice(0,40)`);
    console.log(`  第 ${g} 局（${Math.round((Date.now()-started)/1000)}s）${res.split('\n')[0]||''}`);
    for (const b of said) console.log(`      ${BEST.test(b.text) ? '★★' : isWarm(b.text) ? '★' : ' '} ${JSON.stringify(b.text)}`);
    found.push({game: g, result: res.split('\n')[0] || '', bubbles: said});
  }
  writeFileSync('tmp/sheet/bubble-probe.json', JSON.stringify(found, null, 1));
  const all = found.flatMap(f => f.bubbles.map(b => b.text));
  console.log(`\n共 ${found.length} 局、${all.length} 句。有温度的 ${all.filter(isWarm).length} 句，其中首选 ${all.filter(t => BEST.test(t)).length} 句。`);
  console.log('明细 → tmp/sheet/bubble-probe.json');
  if (STAGE === 'bubble') console.log(bestShot ? '✓ companion-bubble.png 已重拍（首选）' : warmShot ? '△ companion-bubble.png 已重拍（退而求其次）' : '✗ 这一轮没拍到有温度的气泡');
}

// ── 军师：短提示条 + 展开的计算依据 ──────────────────────────────────────
if (STAGE === 'coach') {
  await enterBattle();
  await hesitate(11000);
  let n = 0;
  for (let i = 0; i < 24 && !n; i++) { n = await waitForText('#live-coach', 20, 1, false); if (!n) await sleep(900); }
  console.log('  等军师开口:', n);
  const short = await js(`document.getElementById('live-coach').innerText.trim()`);
  console.log('  短提示:', JSON.stringify(short.slice(0, 120)));
  await shot('#live-coach', 'strategist-hint', {pad: 6, scale: 3, minText: 20});
  await click('#live-expand', 900);
  console.log('  依据展开了:', await js(`!!document.querySelector('#live-detail:not([hidden])')`));
  // 「计算依据」是 #live-detail 里再套的一层 <details>，默认也是收起的。
  await click('#live-detail details summary', 800);
  console.log('  计算依据展开了:', await js(`!!document.querySelector('#live-detail details[open]')`));
  // 模型那句解释会在这几秒里替换掉规则文案，等它落地再截。
  await sleep(6000);
  const full = await js(`document.getElementById('live-coach').innerText.trim()`);
  // 这两条是本次重拍的理由，必须机械拦一道：图上不许再出现内部标识。
  const bad = [];
  if (/\[tactic:|\[ref:|\[card:/i.test(full)) bad.push('内部卡片 ID');
  if (/条件：\s*(candidate|absent|conditions-not-met|reference-only|version-mismatch)/i.test(full)) bad.push('英文条件码');
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(full)) bad.push('UUID');
  console.log(bad.length ? `  ✗ 依据里仍有内部标识：${bad.join('、')}` : '  ✓ 依据里没有内部标识');
  await shot('#live-coach', 'coach-evidence', {pad: 6, scale: 2, minText: 60, frac: 0.8});
  writeFileSync('tmp/sheet/coach-text.txt', full);
}

// ── 老师：整局复盘 ──────────────────────────────────────────────────────
if (STAGE === 'review') {
  await enterBattle();
  const done = await playOut(60);
  console.log('  打到结束:', done, '| result 可见:', await js(`!document.getElementById('result').hidden`));
  await sleep(3000);
  const n = await waitForText('#live-coach', 60, 16, false);
  console.log('  等复盘:', n);
  // 复盘正文很长，往下会长到气泡常驻的那一带：拍之前先把陪练收掉（见 hideBubble）。
  console.log('  收掉陪练气泡:', await hideBubble());
  const text = await js(`document.getElementById('live-coach').innerText.trim()`);
  // 复盘的硬口径：自然语言。JSON 片段、UUID、以及「0 次 / 0 个」这类空值罗列都算旧产物。
  const bad = [];
  if (/[{"][^"]*":/.test(text)) bad.push('JSON 片段');
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) bad.push('UUID');
  if (/(^|[^0-9])0 (次|个|只|点|瓶)/.test(text)) bad.push('0 值罗列');
  console.log(bad.length ? `  ✗ 复盘里仍有：${bad.join('、')}` : '  ✓ 复盘是自然语言');
  console.log('  复盘开头:', JSON.stringify(text.slice(0, 100)));
  // 图注写的是「老师的整局复盘**与挑出来的关键回合**」，所以图要是展开之后的样子；
  // 只截收起的那一行结论，图里就没有「关键回合」这回事了。
  // （重拍前那张 1936×592 也是展开版，这里保持同一构图。）
  await click('#live-coach details summary', 900);
  await sleep(1500);
  console.log('  关键回合展开了:', await js(`!!document.querySelector('#live-coach details[open]')`));
  await hideBubble();
  // 图必须完整：展开区里每一段都要在图上，最后一段不许只露半行。
  // 这条不能靠「看着像截全了」——上一版就是这么过的：元素的框量到 356css、
  // 折叠线以下那 71css 没渲染，图上最后一行被切开，底下补了一片底色。
  const shape = await js(`(()=>{const b=document.getElementById('live-coach');if(!b||b.hidden)return null;
    const d=b.querySelector('details');
    return {boxH:Math.round(b.getBoundingClientRect().height), boxScroll:b.scrollHeight, boxClient:b.clientHeight,
      detailScroll:d.scrollHeight, detailClient:d.clientHeight,
      paras:[...b.querySelectorAll('details p')].map(p=>p.innerText.trim())};})()`);
  if (!shape) console.log('  ✗ 复盘条已经收起来了（LIVE_COACH_MS=17s 到点就藏），这一张没拍成');
  else {
    console.log(`  展开区 ${shape.detailScroll}/${shape.detailClient}px，段落 ${shape.paras.length} 段；` +
      `面板可滚动=${shape.boxScroll > shape.boxClient + 1}`);
    const tail = shape.paras.at(-1) || '';
    console.log('  图上最后一段的结尾:', JSON.stringify(tail.slice(-30)));
    writeFileSync('tmp/sheet/review-paras.json', JSON.stringify(shape.paras, null, 1));
  }
  await shot('#live-coach', 'teacher-review', {pad: 6, scale: 2, minText: 60, frac: 0.85});
  writeFileSync('tmp/sheet/review-text.txt', text);
}

// ── 其余几张：只重拍，不判断（判断在报告里做）────────────────────────────
if (STAGE === 'static') {
  await go(); await dismiss();
  await shot('#camp-roster .pet-option:first-child', 'camp-card', {pad: 6, scale: 3, minText: 30, frac: 0.46});
  await shot('#cultivation', 'camp-cultivation', {pad: 8, scale: 2, minText: 30, frac: 0.46});
  await js(`(()=>{const a=document.getElementById('cultivation-coach');if(a&&!a.hidden)a.click();})()`);
  await sleep(800);
  await shot('#growth-advice', 'growth-advice', {pad: 8, scale: 3, minText: 20, frac: 0.46});
  await click('#growth-advice details summary', 500);
  await shot('#growth-advice', 'growth-advice-table', {pad: 8, scale: 3, minText: 20, frac: 0.42});

  await go(); await dismiss();
  await click('#go-pve', 900);
  await shot('#stage-picker', 'deploy-stages', {pad: 8, scale: 2, minText: 10, frac: 0.46});
  await shot('#stage-detail', 'deploy-stage-detail', {pad: 6, scale: 3, minText: 10, frac: 0.46});
  await shot('#roster-advice', 'roster-advice', {pad: 6, scale: 3, minText: 10, frac: 0.46});
  await shot('#deploy-side', 'deploy-side', {pad: 8, scale: 2, minText: 10, frac: 0.46});
  await pickPets(3);
  await shot('#roster', 'deploy-roster', {pad: 8, scale: 2, minText: 30, frac: 0.46});

  await enterBattle();
  await sleep(1500);
  await shot('#actions', 'battle-actions', {pad: 8, scale: 2, minText: 20, frac: 0.46});
  await shot('.log-panel', 'battle-log', {pad: 8, scale: 2, minText: 20, frac: 0.46});
  await shot('#player-card', 'battle-arena', {pad: 6, scale: 2, minText: 30, frac: 0.46});
  await shot('#player-card, #action-banner, #bottom-grid', 'battle-board', {pad: 8, scale: 2, minText: 60, all: true, frac: 0.46});

  await go(); await dismiss();
  await click('#go-pvp', 900);
  await js(`(()=>{const s=document.getElementById('pvp-opponent');if(!s)return false;s.value='human';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await sleep(900);
  await pickPets(3, '#roster');
  // 对手那一栏的按钮是 data-enemy-pet，不是 data-pet（用错会静默 0 只、#start 一直禁用）。
  await pickPets(3, '#roster-enemy', '[data-enemy-pet]');
  await click('#start', 3000);
  await fastest();
  await sleep(1500);
  await shot('#panel-player, #panel-enemy', 'pvp-split', {pad: 8, scale: 2, minText: 40, all: true, frac: 0.46});
  await shot('#player-coach', 'pvp-player-coach', {pad: 6, scale: 3, minText: 6, frac: 0.46});
  await shot('#enemy-coach', 'pvp-enemy-coach', {pad: 6, scale: 3, minText: 6, frac: 0.46});
  await shot('#teacher-roles, #coach-panel', 'teacher-roles', {pad: 8, scale: 2, minText: 30, all: true, frac: 0.46});
}

// 收尾：把没通过像素校验的图集中报一次。断图不许悄悄留在 report/figs 里。
if (BAD_SHOTS.length) {
  console.log(`\n⚠ 有 ${BAD_SHOTS.length} 张没通过像素校验（底部废白或高度对不上）：${BAD_SHOTS.join('、')}`);
  console.log('  这些图先别用；对照 tmp/sheet/ 里的文字记录，多半是元素在拍之前变了。');
} else {
  console.log('\n✓ 所有截图的底部留白都在阈值内。');
}
console.log('完成。');
process.exit(BAD_SHOTS.length ? 1 : 0);

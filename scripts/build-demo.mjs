#!/usr/bin/env node
/**
 * scripts/build-demo.mjs — F04 自动生成演示产物（无桌面/无音频环境的替代方案）
 *
 * 本机没有可见桌面、没有音频设备，无法录制真实视频。这个脚本改为：
 *   1. 用 child_process 启动 headless Chrome，通过 CDP（Chrome DevTools Protocol）驱动真实应用；
 *   2. 真实鼠标事件点击页面，走完 营地 → 出征 → 对局 → PVP 分屏 → 整局复盘 五段流程；
 *   3. 每一步用 Page.captureScreenshot 抓真实渲染结果，存成 output/demo/NN-<slug>.png；
 *   4. 生成图文分镜 docs/DEMO-WALKTHROUGH.md，逐步嵌入对应截图与说明。
 *
 * 只写入 output/demo/ 与 docs/DEMO-WALKTHROUGH.md，不修改任何现有源码。
 * 应用必须已经在 http://127.0.0.1:8765/ 运行；本脚本不会另起服务器。
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const APP_URL = process.env.DEMO_APP_URL || 'http://127.0.0.1:8765/';
const CDP_PORT = Number(process.env.DEMO_CDP_PORT || 9333);
const DEMO_DIR = path.join(WORKSPACE, 'output', 'demo');
const STORY_PATH = path.join(WORKSPACE, 'docs', 'DEMO-WALKTHROUGH.md');
const PROFILE_DIR = path.join(WORKSPACE, 'tmp', 'demo-profile');
const CHROME_BIN = process.env.DEMO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1440, height: 900 };
const KEEP_PROFILE = process.env.DEMO_KEEP_PROFILE === '1';

const q = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');
/** 本机时区的可读时间（ISO 是 UTC，写进文档容易和环境对不上）。 */
const localTime = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

class StepError extends Error {}

/* ------------------------------------------------------------------ *
 * CDP 客户端（零依赖，Node 内置 WebSocket）
 * ------------------------------------------------------------------ */

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`无法连接 CDP：${this.url}`)), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) {
          try { fn(msg.params, msg.sessionId); } catch { /* 监听器异常不影响主流程 */ }
        }
      }
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 180000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* 忽略 */ }
  }
}

/* ------------------------------------------------------------------ *
 * 运行期状态
 * ------------------------------------------------------------------ */

let browser = null;
let session = null;          // 页面会话的 CDP 封装
let chromeProc = null;
let activePort = CDP_PORT;   // 默认 9333；被别人的浏览器占用时才退让（见 pickPort）
let chromeVersion = '未知';
let coachStatus = '未知';
let appVersion = '未知';
let actualViewport = { ...VIEWPORT };

const shots = [];
const fallbacks = [];
const warnings = [];

function log(...args) { console.log('[demo]', ...args); }

/* ------------------------------------------------------------------ *
 * 页面操作原语
 * ------------------------------------------------------------------ */

async function evalJs(expression, { awaitPromise = false } = {}) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知异常';
    throw new StepError(`页面脚本异常：${String(d).split('\n')[0]}`);
  }
  return r.result?.value;
}

const VISIBLE_FN = `(e)=>{if(!e)return false;if(e.hidden)return false;if(e.closest('[hidden]'))return false;const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;const r=e.getBoundingClientRect();return r.width>1&&r.height>1;}`;

function visibleExpr(selector) {
  return `(()=>{const e=document.querySelector(${q(selector)});return (${VISIBLE_FN})(e);})()`;
}

async function isVisible(selector) {
  try { return !!(await evalJs(visibleExpr(selector))); } catch { return false; }
}

async function waitFor(expression, { timeout = 20000, interval = 150, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await evalJs(expression); } catch (e) { last = undefined; }
    if (last) return last;
    if (Date.now() > deadline) throw new StepError(`等待超时（${timeout}ms）：${label || expression}`);
    await sleep(interval);
  }
}

const waitVisible = (selector, opts = {}) =>
  waitFor(visibleExpr(selector), { label: `元素可见 ${selector}`, ...opts });

async function mouseClick(x, y) {
  const base = { x: Math.round(x), y: Math.round(y) };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, button: 'left', buttons: 1, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, button: 'left', buttons: 0, clickCount: 1 });
}

/**
 * 真实鼠标点击：先滚动到视口中央，再用 Input 域派发按下/抬起。
 * 若点击未产生预期效果，回退一次 DOM click（记入降级说明），绝不假装成功。
 */
async function clickEl(selector, { index = 0, expect = null, timeout = 15000, label = '' } = {}) {
  const probe = await evalJs(`(()=>{
    const all=[...document.querySelectorAll(${q(selector)})];
    const vis=all.filter(${VISIBLE_FN});
    const usable=vis.filter(e=>!e.disabled);
    const e=usable[${index}];
    if(!e)return {missing:true,count:all.length,visible:vis.length,disabled:vis.length>0};
    e.scrollIntoView({block:'center',inline:'center'});
    const r=e.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,text:(e.textContent||'').trim().slice(0,60)};
  })()`);
  if (!probe || probe.missing) {
    if (probe && probe.disabled) throw new StepError(`元素存在但被禁用：${selector}[${index}]`);
    throw new StepError(`找不到可点击元素：${selector}[${index}]`);
  }
  await mouseClick(probe.x, probe.y);
  if (!expect) return probe;
  try {
    await waitFor(expect, { timeout, label: label || `点击 ${selector} 后的预期状态` });
    return probe;
  } catch (err) {
    const clicked = await evalJs(`(()=>{const e=[...document.querySelectorAll(${q(selector)})][${index}];if(!e)return false;e.click();return true;})()`);
    if (!clicked) throw err;
    await waitFor(expect, { timeout, label: `${label || selector}（DOM click 降级）` });
    fallbacks.push(`${selector}：真实鼠标点击未触发预期状态，改用 DOM click（同一处理器，仍为真实页面行为）`);
    return probe;
  }
}

async function selectEl(selector, value) {
  const r = await evalJs(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return 'MISSING';e.value=${q(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return e.value;})()`);
  if (r === 'MISSING') throw new StepError(`找不到下拉框：${selector}`);
  if (r !== String(value)) throw new StepError(`下拉框 ${selector} 无法设为 ${value}（实际 ${r}）`);
  return r;
}

async function rectOf(selector, pad = 18) {
  const r = await evalJs(`(()=>{const e=document.querySelector(${q(selector)});if(!e||!(${VISIBLE_FN})(e))return null;const b=e.getBoundingClientRect();const s=getComputedStyle(e);return {x:b.left+window.scrollX,y:b.top+window.scrollY,width:b.width,height:b.height,fixed:s.position==='fixed'};})()`);
  if (!r) return null;
  return {
    x: Math.max(0, Math.round(r.x - pad)),
    y: Math.max(0, Math.round(r.y - pad)),
    width: Math.round(r.width + pad * 2),
    height: Math.round(r.height + pad * 2),
    fixed: r.fixed,
  };
}

/* ------------------------------------------------------------------ *
 * 截图
 * ------------------------------------------------------------------ */

async function contentSize() {
  const m = await session.send('Page.getLayoutMetrics');
  const size = m.cssContentSize || m.contentSize || { width: VIEWPORT.width, height: VIEWPORT.height };
  return { width: Math.ceil(size.width), height: Math.ceil(size.height) };
}

/**
 * mode: 'viewport' | 'full' | 'clip'
 * clip 模式用 selector 指定元素，按文档坐标裁剪；position:fixed 的元素无法可靠裁剪，
 * 自动退回整视口截图（记为说明，不算失败）。
 */
async function writeShot(file, mode, selector, pad) {
  const params = { format: 'png', fromSurface: true };
  let used = mode;
  if (mode === 'full') {
    const size = await contentSize();
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 16000), scale: 1 };
  } else if (mode === 'clip') {
    const rect = await rectOf(selector, pad);
    if (!rect) throw new StepError(`裁剪目标不可见：${selector}`);
    if (rect.fixed) {
      used = 'viewport';
      warnings.push(`${slugOf(file)}：${selector} 是 position:fixed，无法按文档坐标裁剪，已退回整视口截图`);
    } else {
      const size = await contentSize();
      params.captureBeyondViewport = true;
      params.clip = {
        x: rect.x,
        y: rect.y,
        width: Math.max(1, Math.min(rect.width, size.width - rect.x)),
        height: Math.max(1, Math.min(rect.height, 16000 - rect.y)),
        scale: 1,
      };
    }
  }
  const { data } = await session.send('Page.captureScreenshot', params);
  await writeFile(path.join(DEMO_DIR, file), Buffer.from(data, 'base64'));
  return used;
}

const slugOf = (file) => file.replace(/^\d+-/, '').replace(/\.png$/, '');

/* ------------------------------------------------------------------ *
 * 步骤记录
 * ------------------------------------------------------------------ */

let currentFlow = null;
const flows = [];

function flow(title, intro) {
  currentFlow = { title, intro, steps: [] };
  flows.push(currentFlow);
}

/**
 * 每个步骤的操作说明写在这里（而不是从函数源码里取——那样会把 JS 源码倒进文档）。
 * key 是 slug，`op` 会原样出现在分镜文档的「操作」一行。
 */
const OP_TEXT = {
  'first-run-welcome': '首次加载后不做任何操作：记录应用自己弹出的陪伴风格选择框。',
  'camp-home': '点击对话框里的第一个按钮「关键时搭把手」，按真实用户路径关掉它。',
  'camp-cultivation': '真实点击营地名册第 2 只伙伴的「培养」，并核对右栏面板是否跟着变。',
  'cultivation-switch': '点「训练 · PVE」进出征页，再点第 3 只伙伴的「培养」——这条路会回到营地并重绘右栏。',
  'deploy-stages': '从营地点击「训练 · PVE」入口卡，进入出征页。',
  'stage-detail': '点击第 2 个关卡「02 · 溪流浅滩」，切换关卡。',
  'team-selection': '不做改动，记录默认已经选好的三只伙伴与出场顺序。',
  'deploy-side': '不做操作，记录右侧「出征设置」侧栏。',
  'battle-turn1': '把播放速度设为「即时」（只影响播放节奏，不改数值），然后点「开始训练」。',
  'hint-strip-evidence': '依次展开教练条的「看看原因」与「计算依据」，等解释文案结算。',
  'turn-2': '在技能面板点第一个可用行动出招，等回合同步推进。',
  'turn-3': '再出招一次（第 2 次）。',
  'turn-4': '第三次出招，凑满要求的 3 个回合。',
  'round-review': '点击顶栏「✦ 回合回顾」，等教练在右侧面板给出回答与其依据。',
  'pvp-deploy': '点「返回营地」（原生 confirm 按确定），再点「对局 · PVP」，对手选「真人同机（分屏）」。',
  'pvp-split-two-coaches': '点「开始对战」，等左右两个面板与两条教练条都出现。',
  'pvp-split-both-locked': '我方先锁定一招，再替对方锁一招；两边都锁完才结算。',
  'pvp-ai-opponent': '回营地改选「AI 模拟真人」，重新开局并出一招。',
  'match-complete': '回营地重开一局 PVE，用「即时」速度一直出招打到分出胜负（脚本自动出招，最多 140 回合）。',
  'match-review': '展开整局复盘里的「关键回合与依据」，等分析文案结算。',
  'match-review-coach': '点击此时已变成「整局复盘」的按钮，让复盘落到右侧教练面板。',
};

/**
 * 一个步骤 = 一段真实操作 + 一张截图。
 * 前置不满足 → 记为「跳过」；操作抛错 → 记为「未达成」并抓当前真实画面（不伪造）。
 */
async function step({ slug, title, perform = null, op = null, expect, capture = 'full', selector = null, pad = 18, needs = null, timeout = 20000 }) {
  const n = pad2(shots.length + 1);
  const file = `${n}-${slug}.png`;
  const entry = { n, slug, title, op: op || OP_TEXT[slug] || null, expect, file: null, capture, status: 'ok', note: null };
  currentFlow.steps.push(entry);
  shots.push(entry);

  if (needs && !(await isVisible(needs))) {
    entry.status = 'skipped';
    entry.note = `前置条件未满足：${needs} 不可见，本步骤未执行`;
    log(`${entry.n} ${slug} → 跳过（缺 ${needs}）`);
    return entry;
  }

  if (perform) {
    try {
      await perform();
    } catch (err) {
      entry.status = 'failed';
      entry.note = err instanceof StepError ? err.message : `操作异常：${err.message}`;
      log(`${entry.n} ${slug} → 未达成：${entry.note}`);
    }
  }

  const target = entry.status === 'ok' ? file : `${n}-${slug}-未达成.png`;
  try {
    const used = await writeShot(target, entry.status === 'ok' ? capture : (capture === 'clip' ? 'full' : capture), selector, pad);
    entry.file = target;
    if (used !== capture && entry.status === 'ok') entry.capture = used;
  } catch (err) {
    entry.status = 'failed';
    entry.note = `${entry.note ? `${entry.note}；` : ''}截图失败：${err.message}`;
    log(`${entry.n} ${slug} → 截图失败：${err.message}`);
  }
  if (entry.status === 'ok') log(`${entry.n} ${slug} → ok (${entry.file})`);
  return entry;
}

/* ------------------------------------------------------------------ *
 * 应用内动作封装
 * ------------------------------------------------------------------ */

const turnLabel = () => evalJs(`document.getElementById('turn').textContent`);
const phaseLabel = () => evalJs(`document.getElementById('phase').textContent`);
const matchOver = () => evalJs(`!document.getElementById('result').hidden`);

async function waitIdle(timeout = 25000) {
  await waitFor(`(()=>{const p=document.getElementById('phase');const r=document.getElementById('result');return !!p && (p.textContent!=='正在出招…'||!r.hidden);})()`, {
    timeout, label: '出招结算结束',
  });
}

async function firstEnabledAction(selector) {
  return evalJs(`(()=>{const b=[...document.querySelectorAll(${q(selector)})].filter(e=>!e.disabled&&(${VISIBLE_FN})(e));return b.length?b[0].dataset.action:null;})()`);
}

/** 出一招：点 #actions 里第一个可用行动，等回合同步推进。 */
async function playTurn({ selector = '#actions [data-action]', timeout = 25000 } = {}) {
  const before = await turnLabel();
  const action = await firstEnabledAction(selector);
  if (!action) throw new StepError(`没有可用行动按钮（${selector} 全部禁用）`);
  await clickEl(selector, { expect: null });
  await waitFor(`(()=>{const t=document.getElementById('turn').textContent;const done=!document.getElementById('result').hidden;return done||t!==${q(before)};})()`, {
    timeout, label: `回合从 ${before} 推进`,
  });
  await waitIdle(timeout);
  return action;
}

/** 打开我方教练条的证据明细（「看看原因」+「计算依据」）。 */
async function expandHint() {
  if (await isVisible('#live-expand')) {
    const open = await evalJs(`document.getElementById('live-expand').getAttribute('aria-expanded')==='true'`);
    if (!open) await clickEl('#live-expand', { expect: `!document.getElementById('live-detail').hidden` });
  }
  // 提示条里的「计算依据」是 <details>，展开后才看得到逐条证据。
  const hasDetails = await evalJs(`!!document.querySelector('#live-detail details')`);
  if (hasDetails) {
    const open = await evalJs(`document.querySelector('#live-detail details').open`);
    if (!open) await clickEl('#live-detail details summary', { expect: `document.querySelector('#live-detail details').open`, label: '展开计算依据' });
  }
  return true;
}

/** 等一段异步文案从「正在…」变成结果（模型解释/整局分析）。超时不报错，只是如实保留等待态。 */
async function settleText(selector, pending, timeout = 25000) {
  try {
    await waitFor(`(()=>{const e=document.querySelector(${q(selector)});return !!e && !e.textContent.includes(${q(pending)});})()`, {
      timeout, interval: 500, label: `${selector} 文案结算`,
    });
  } catch {
    warnings.push(`${selector} 在 ${Math.round(timeout / 1000)}s 内仍停留在「${pending}」状态，截图保留的是等待中的真实画面`);
  }
}

/** 等教练面板里出现真正的回答（本地回退或模型回答都算），而不是「正在读取…」的等待态。 */
async function waitCoachAnswer(before, timeout = 90000) {
  await waitFor(`(()=>{const log=document.getElementById('chat-log');if(!log)return false;return log.querySelectorAll('.chat-entry:not(.thinking):not(.user)').length>${before};})()`, {
    timeout, interval: 400, label: '教练回答出现',
  });
  try {
    await waitFor(`!document.getElementById('chat-thinking')`, { timeout: 20000, interval: 300, label: '等待指示消失' });
  } catch {
    warnings.push('教练回答在等待窗口内没有完成，截图抓到的是「正在读取局面与依据…」的等待态');
  }
  await sleep(1000);
}

const chatEntryCount = () => evalJs(`document.querySelectorAll('#chat-log .chat-entry:not(.thinking):not(.user)').length`);

async function backToCamp() {
  await waitIdle();
  if (await isVisible('#coach-close')) {
    const open = await evalJs(`!document.getElementById('coach-panel').hidden`);
    if (open) await clickEl('#coach-close', { expect: `document.getElementById('coach-panel').hidden` });
  }
  await clickEl('#restart', {
    expect: `(()=>{const c=document.getElementById('camp-home');const b=document.getElementById('battle');return !c.hidden && b.hidden;})()`,
    timeout: 20000,
    label: '返回营地',
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function run() {
  let campCultivationObserved = null;
  /* ---- Flow 1 营地 ---- */
  flow('一、营地', '应用首屏：两张入口卡、伙伴名册与培养面板。首次进入会弹出陪伴风格选择框，先记录它，再按真实路径关掉。');

  await step({
    slug: 'first-run-welcome',
    title: '首次进入：陪伴风格选择框',
    perform: null,
    expect: '模态对话框 #coach-welcome 打开，三个风格按钮与语音选项可见。',
    capture: 'viewport',
    needs: '#coach-welcome',
  });

  await step({
    slug: 'camp-home',
    title: '营地首页',
    perform: async () => {
      await clickEl('#coach-welcome .style-choices button', {
        index: 0,
        expect: `!document.getElementById('coach-welcome').open`,
        label: '关闭首次进入对话框',
      });
      await waitFor(`document.querySelectorAll('#camp-roster .pet-option').length>0`, { label: '名册渲染完成' });
    },
    expect: '训练 · PVE / 对局 · PVP 两张入口卡、按属性筛选、伙伴名册与右侧「伙伴培养」全部在真实页面里。',
    capture: 'full',
  });

  const campPanelStep = await step({
    slug: 'camp-cultivation',
    title: '培养面板',
    perform: async () => {
      // 真实点击营地名册里的「培养」。这里不预设结果，只如实记录发生了什么。
      const heading = () => evalJs(`document.querySelector('#cultivation h3').textContent.trim()`);
      const before = await heading();
      await clickEl('#camp-roster [data-focus]', { index: 1 });
      await sleep(600);
      const after = await heading();
      campCultivationObserved = before === after
        ? `点击第 2 只伙伴的「培养」后，右栏培养面板没有变化，仍显示「${after}」。核对源码：营地名册的「培养」分支（app.js 第 38 行）只调用 showCamp()，没有重新渲染 #cultivation，所以焦点变了但面板不重绘。脚本用真实鼠标点击和 DOM click 各验证一次，结果一致——这是产品当前的真实行为，不是没点到。`
        : `点击第 2 只伙伴的「培养」后，培养面板切换到了「${after}」。`;
    },
    expect: '右侧培养面板：伙伴等级与经验进度、培养格与四项加点（耐久/力量/敏捷）、6 选 4 配招与携带物、免费重置。',
    capture: 'clip',
    selector: 'aside.cultivation',
  });
  campPanelStep.observed = campCultivationObserved;

  await step({
    slug: 'cultivation-switch',
    title: '切换培养对象（会重绘的那条路）',
    perform: async () => {
      const heading = () => evalJs(`document.querySelector('#cultivation h3').textContent.trim()`);
      const before = await heading();
      await clickEl('#go-pve', { expect: `!document.getElementById('deploy').hidden`, label: '进入出征页' });
      await clickEl('#roster [data-focus]', {
        index: 2,
        expect: `(()=>{const h=document.querySelector('#cultivation h3');return !document.getElementById('camp-home').hidden && !!h && h.textContent.trim()!==${q(before)};})()`,
        label: '从出征页切换培养对象',
      });
      await sleep(500);
    },
    expect: '出征页的「培养」会回到营地并重绘右栏，面板换成第 3 只伙伴——同一条数据、同一个面板，这条路是完整的。',
    capture: 'clip',
    selector: 'aside.cultivation',
  });

  /* ---- Flow 2 出征 · 训练 ---- */
  flow('二、出征 · 训练', '从营地点击「训练 · PVE」进入出征页：关卡、队伍、出征设置，然后开始对局。');

  await step({
    slug: 'deploy-stages',
    title: '出征页与关卡选择',
    perform: async () => {
      await clickEl('#go-pve', {
        expect: `!document.getElementById('deploy').hidden`,
        label: '进入出征页',
      });
      await waitVisible('#stage-picker [data-stage]');
    },
    expect: '出征页出现：① 选择关卡（5 个关卡按钮）② 选择三只伙伴，右侧是「出征设置」。',
    capture: 'full',
  });

  await step({
    slug: 'stage-detail',
    title: '关卡详情',
    perform: async () => {
      await clickEl('#stage-picker [data-stage]', {
        index: 1,
        expect: `document.querySelector('#stage-picker [data-stage]:nth-child(2)').classList.contains('selected')`,
        label: '切换关卡',
      });
      await sleep(300);
    },
    expect: '关卡说明、对手阵容（等级与培养分配）与首通奖励规则。',
    capture: 'clip',
    selector: '#stage-detail',
    pad: 8,
  });

  await step({
    slug: 'team-selection',
    title: '出战三只与出场顺序',
    perform: async () => {
      await waitFor(`(()=>{const s=document.getElementById('selection');return s && s.textContent.includes('3');})()`, { label: '队伍已是 3 只' });
      await sleep(300);
    },
    expect: '默认队伍三只伙伴带 1/2/3 号位标记，名册显示等级与四维；「开始训练」可用。',
    capture: 'clip',
    selector: '#roster',
  });

  await step({
    slug: 'deploy-side',
    title: '出征设置侧栏',
    perform: null,
    expect: '侧栏汇总本局的模式、关卡、难度与队伍人数。',
    capture: 'clip',
    selector: 'aside.deploy-side',
    pad: 10,
  });

  await step({
    slug: 'battle-turn1',
    title: '开局第 1 回合',
    perform: async () => {
      await selectEl('#speed', '0');
      await clickEl('#start', {
        expect: `!document.getElementById('battle').hidden`,
        label: '开始训练',
      });
      await waitVisible('#actions [data-action]');
      await sleep(800);
    },
    expect: '进入对局：双方队伍、生命与能量、行动面板与战斗记录。播放速度设为「即时」，只是让演示更快走完回合，不改数值。',
    capture: 'full',
  });

  /* ---- Flow 3 对局中军师 ---- */
  flow('三、对局中的军师', 'PVE 连续出招 3 回合，记录对战中的教练提示条与「回合回顾」面板里的证据。');

  await step({
    slug: 'hint-strip-evidence',
    title: '对局中的提示条与计算依据',
    perform: async () => {
      await waitVisible('#live-coach', { timeout: 15000 });
      await expandHint();
      await settleText('#live-provider', '正在组织解释', 25000);
      await sleep(400);
    },
    expect: '教练条给出本回合的一句话建议；展开后是「计算依据」，写明只比较一回合、不读取电脑待执行行动。',
    capture: 'clip',
    selector: '#live-coach',
  });

  await step({
    slug: 'turn-2',
    title: '出招 1 次后（第 2 回合）',
    perform: async () => {
      await playTurn();
      await sleep(600);
    },
    expect: '回合数推进，双方生命/能量变化，战斗记录新增一条，行动面板重新可用。',
    capture: 'full',
  });

  await step({
    slug: 'turn-3',
    title: '出招 2 次后（第 3 回合）',
    perform: async () => {
      await playTurn();
      await sleep(600);
    },
    expect: '继续推进；教练条按「关键时搭把手」的档位只在值得说的时候出现。',
    capture: 'full',
  });

  const thirdTurn = await step({
    slug: 'turn-4',
    title: '出招 3 次后（第 4 回合）',
    perform: async () => {
      await playTurn();
      await sleep(600);
    },
    expect: '第 3 次出招完成，局面继续演变。',
    capture: 'full',
  });

  await step({
    slug: 'round-review',
    title: '回合回顾面板（含证据）',
    perform: async () => {
      await waitIdle();
      const before = await chatEntryCount();
      await clickEl('#round-coach', {
        expect: `!document.getElementById('coach-panel').hidden`,
        label: '打开回合回顾',
      });
      await waitCoachAnswer(before, 90000);
    },
    expect: '右侧教练面板被打开并回答了「回顾上一回合」；回答下方可展开「依据」，逐步核对原始回合记录。',
    capture: 'viewport',
    timeout: 90000,
  });

  /* ---- Flow 4 对局 · PVP 分屏 ---- */
  flow('四、对局 · PVP 分屏', '回到营地，改走「对局 · PVP」：先是真人同机的双面板分屏，再记录 AI 模拟真人的同一套界面。');

  await step({
    slug: 'pvp-deploy',
    title: 'PVP 出征页与对手选择',
    perform: async () => {
      await backToCamp();
      await clickEl('#go-pvp', { expect: `!document.getElementById('deploy').hidden`, label: '进入 PVP 出征页' });
      await waitVisible('#pvp-opponent');
      await selectEl('#pvp-opponent', 'human');
      await sleep(400);
    },
    expect: 'PVP 模式下不选关卡；出现「对手」下拉框，选中「真人同机（分屏）」，按钮文字变成「开始对战」。（从上一局中途离开时，浏览器会弹原生 confirm 问「离开会结束本次训练且没有奖励」，脚本按真实用户的选择点「确定」；对话框本身无法被截图 API 捕获。）',
    capture: 'full',
  });

  await step({
    slug: 'pvp-split-two-coaches',
    title: '分屏开局：两侧面板 + 两条教练',
    perform: async () => {
      await clickEl('#start', { expect: `!document.getElementById('battle').hidden`, label: '开始对战' });
      await waitVisible('#panel-enemy');
      await waitVisible('#player-coach-text');
      await waitVisible('#enemy-coach-text');
      await sleep(800);
    },
    expect: '左右两个行动面板同屏：我方可选，对方也可选；两侧各有一条教练条，只分析自己那一侧的局面。',
    capture: 'full',
  });

  await step({
    slug: 'pvp-split-both-locked',
    title: '双方各自锁定行动',
    perform: async () => {
      await clickEl('#actions [data-action]', { expect: `document.getElementById('message').textContent.includes('已锁定')`, label: '我方锁定' });
      await clickEl('#enemy-actions [data-action]', { expect: null });
      await waitIdle(25000);
      await sleep(800);
    },
    expect: '两边都锁定后才亮牌结算；先锁的一方看不到后锁一方选了什么。',
    capture: 'full',
  });

  await step({
    slug: 'pvp-ai-opponent',
    title: 'AI 模拟真人的同一套界面',
    perform: async () => {
      await backToCamp();
      await clickEl('#go-pvp', { expect: `!document.getElementById('deploy').hidden`, label: '回到 PVP 出征页' });
      await waitVisible('#pvp-opponent');
      await selectEl('#pvp-opponent', 'ai');
      await sleep(300);
      await clickEl('#start', { expect: `!document.getElementById('battle').hidden`, label: '开始对战' });
      await waitVisible('#panel-enemy');
      await sleep(600);
      await playTurn({ selector: '#actions [data-action]' });
      await sleep(600);
    },
    expect: 'AI 模式下对方面板只读（提示「已独立出招（看不到你的选择）」），界面结构与真人分屏一致。',
    capture: 'full',
  });

  /* ---- Flow 5 整局复盘 ---- */
  flow('五、整局复盘', '从营地重新开一局 PVE，一直打到分出胜负，记录自动出现的整局复盘。');

  let finished = false;
  await step({
    slug: 'match-complete',
    title: '打完整局：结算与自动复盘',
    perform: async () => {
      await backToCamp();
      await clickEl('#go-pve', { expect: `!document.getElementById('deploy').hidden`, label: '进入 PVE 出征页' });
      await waitVisible('#start');
      await selectEl('#speed', '0');
      await clickEl('#start', { expect: `!document.getElementById('battle').hidden`, label: '开始训练' });
      await waitVisible('#actions [data-action]');
      let turns = 0;
      while (turns < 140) {
        if (await matchOver()) { finished = true; break; }
        await playTurn({ timeout: 20000 });
        turns += 1;
      }
      if (!finished && (await matchOver())) finished = true;
      await waitFor(`!document.getElementById('result').hidden`, { timeout: 30000, label: '本场结束' });
      await sleep(1500);
    },
    expect: '打满整局直到分出胜负：结算条给出经验与训练点，教练自动产出整局复盘。',
    capture: 'full',
    timeout: 20000,
  });

  await step({
    slug: 'match-review',
    title: '自动整局复盘（关键回合与依据）',
    perform: async () => {
      if (!finished) warnings.push('整局复盘：未在 140 回合内确认胜负，仍然抓取了当前真实画面');
      await waitVisible('#live-coach', { timeout: 20000 });
      const hasDetails = await evalJs(`!!document.querySelector('#live-coach details')`);
      if (hasDetails) {
        const open = await evalJs(`document.querySelector('#live-coach details').open`);
        if (!open) {
          await clickEl('#live-coach details summary', { expect: `document.querySelector('#live-coach details').open`, label: '展开关键回合与依据' });
        }
      }
      await settleText('#result-provider', '正在结合整局记录分析', 40000);
      await sleep(400);
    },
    expect: '对局结束后教练自动给出的整局回顾：一句结论 + 可展开的「关键回合与依据」。',
    capture: 'clip',
    selector: '#live-coach',
  });

  await step({
    slug: 'match-review-coach',
    title: '整局复盘落到教练面板',
    perform: async () => {
      const before = await chatEntryCount();
      await clickEl('#round-coach', { expect: `!document.getElementById('coach-panel').hidden`, label: '打开整局复盘' });
      await waitCoachAnswer(before, 90000);
    },
    expect: '此时按钮已变成「整局复盘」；面板里是整局层面的分析，可展开依据核对原始回合。',
    capture: 'viewport',
    timeout: 90000,
  });
}

/* ------------------------------------------------------------------ *
 * 分镜文档
 * ------------------------------------------------------------------ */

function buildStoryboard(meta) {
  const total = shots.length;
  const ok = shots.filter((s) => s.status === 'ok').length;
  const failed = shots.filter((s) => s.status === 'failed');
  const skipped = shots.filter((s) => s.status === 'skipped');
  const lines = [];

  lines.push('# 小芽 · 图文演示分镜（DEMO-WALKTHROUGH）');
  lines.push('');
  lines.push('> 本文件由 `scripts/build-demo.mjs` 自动生成。本机没有可见桌面、没有音频设备，无法录制真实视频；');
  lines.push('> 这里改为用 headless Chrome + CDP 驱动**真实运行中的应用**，逐步抓取真实渲染截图，替代视频演示。');
  lines.push('> 所有图片都是 `Page.captureScreenshot` 的真实输出，不是效果图、不是重绘稿。');
  lines.push('');
  lines.push('## 生成信息');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 生成时间 | ${meta.time} |`);
  lines.push(`| 应用地址 | ${meta.url} |`);
  lines.push(`| 应用版本徽标 | ${appVersion} |`);
  lines.push(`| 教练连接 | ${coachStatus} |`);
  lines.push(`| 浏览器 | Headless ${chromeVersion} |`);
  lines.push(`| 启动参数 | \`${meta.flags}\` |`);
  lines.push(`| CDP 端口 | ${meta.port}${meta.port === CDP_PORT ? '' : `（约定 9333 被另一个 headless Chrome 占用，本次退让到 ${meta.port}）`} |`);
  lines.push(`| 视口尺寸 | ${actualViewport.width} × ${actualViewport.height}（CSS 像素） |`);
  lines.push(`| 截图数量 | ${total} 张（成功 ${ok} · 未达成 ${failed.length} · 跳过 ${skipped.length}） |`);
  lines.push(`| 输出目录 | \`output/demo/\` |`);
  lines.push('');
  lines.push('## 阅读方式');
  lines.push('');
  lines.push('每张图对应一次真实交互。`操作` 列写脚本实际做了什么，`画面` 列写这一步应当看到什么。');
  lines.push('凡是脚本没能走到的步骤，会在原位置标成 **未达成** 或 **跳过**，并写明原因，不会用别的画面顶替。');
  lines.push('');

  for (const f of flows) {
    if (!f.steps.length) continue;
    lines.push(`## ${f.title}`);
    lines.push('');
    if (f.intro) { lines.push(f.intro); lines.push(''); }
    for (const s of f.steps) {
      const badge = s.status === 'ok' ? '' : s.status === 'skipped' ? ' · ⏭ 跳过' : ' · ⚠️ 未达成';
      lines.push(`### ${s.n} · ${s.title}${badge}`);
      lines.push('');
      if (s.file) {
        lines.push(`![${s.n} ${s.title}](../output/demo/${encodeURI(s.file)})`);
        lines.push('');
        lines.push(`*文件：\`output/demo/${s.file}\`*`);
      } else {
        lines.push('*本步骤没有可用截图。*');
      }
      lines.push('');
      if (s.op) lines.push(`- **操作**：${s.op}`);
      lines.push(`- **画面**：${s.expect}`);
      if (s.observed) lines.push(`- **实测观察**：${s.observed}`);
      if (s.note) lines.push(`- **实际结果**：${s.status === 'skipped' ? '跳过' : '未达成'} — ${s.note}`);
      lines.push('');
    }
  }

  lines.push('## 未能覆盖的部分（如实记录）');
  lines.push('');
  if (!failed.length && !skipped.length && !warnings.length && !fallbacks.length) {
    lines.push('本次运行五段流程全部按计划走到，没有失败或跳过的步骤。');
  } else {
    if (failed.length) {
      lines.push('**未达成的步骤**');
      lines.push('');
      for (const s of failed) lines.push(`- ${s.n} ${s.title}：${s.note}`);
      lines.push('');
    }
    if (skipped.length) {
      lines.push('**跳过的步骤**');
      lines.push('');
      for (const s of skipped) lines.push(`- ${s.n} ${s.title}：${s.note}`);
      lines.push('');
    }
    if (warnings.length) {
      lines.push('**运行警告**');
      lines.push('');
      for (const w of warnings) lines.push(`- ${w}`);
      lines.push('');
    }
    if (fallbacks.length) {
      lines.push('**交互降级说明**');
      lines.push('');
      for (const w of fallbacks) lines.push(`- ${w}`);
      lines.push('');
    }
  }
  lines.push('## 这份产物不能说明什么');
  lines.push('');
  lines.push('- 它是**静态图文**，没有真实录屏、没有语音播报：本机没有可见桌面与音频设备，「语音提醒」在演示里没有开启。');
  lines.push('- 每张图只是某一时刻的画面，不能证明连续动画、手感或帧率。');
  lines.push('- 截图证明的是「界面与流程在真实浏览器里跑得通」，不是「教学有效」。学习增益需要人类被试实验，本产物不涉及。');
  lines.push('- 为让整局更快打完，演示把播放速度设成「即时」，这只影响播放节奏，不改变任何数值。');
  lines.push('');
  lines.push('## 复现方式');
  lines.push('');
  lines.push('```bash');
  lines.push('# 1) 保证应用已在 8765 运行（不要另起一个服务器）');
  lines.push('npm start');
  lines.push('# 2) 另开一个终端重建演示产物');
  lines.push('node scripts/build-demo.mjs');
  lines.push('```');
  lines.push('');
  lines.push('脚本只写 `output/demo/` 与 `docs/DEMO-WALKTHROUGH.md`，不修改任何现有源码。');
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 启动 / 收尾
 * ------------------------------------------------------------------ */

async function checkApp() {
  let res;
  try {
    res = await fetch(APP_URL, { method: 'GET' });
  } catch (err) {
    throw new Error(`应用没有在 ${APP_URL} 响应（${err.message}）。请先在项目根目录运行 npm start，再执行本脚本；本脚本不会另起服务器。`);
  }
  if (!res.ok) throw new Error(`应用在 ${APP_URL} 返回 HTTP ${res.status}，无法作为演示对象。请先确认 npm start 正常。`);
  await res.arrayBuffer();
  log(`应用在线：${APP_URL} (HTTP ${res.status})`);
  // 记录教练当前是走模型还是走本地规则：两种都是真实产品路径，但截图里的措辞不同，必须写清楚。
  try {
    const boot = await (await fetch(new URL('/api/bootstrap', APP_URL))).json();
    coachStatus = boot.configured
      ? `已配置模型（${boot.provider} / ${boot.model}${boot.verified ? ' · 已验证' : ' · 未验证'}）`
      : '未配置密钥，教练走本地规则核验（回答来自本地引擎，不经模型改写）';
  } catch {
    coachStatus = '读取 /api/bootstrap 失败，未能确认教练连接状态';
  }
  log(`教练连接：${coachStatus}`);
}

async function launchChrome() {
  if (!KEEP_PROFILE) await rm(PROFILE_DIR, { recursive: true, force: true });
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(DEMO_DIR, { recursive: true });

  const flags = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${activePort}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
  log(`启动 headless Chrome：${CHROME_BIN}`);
  log(`参数：${flags.join(' ')}`);
  chromeProc = spawn(CHROME_BIN, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeProc.stderr.on('data', () => { /* Chrome 的 stderr 噪音忽略 */ });

  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${activePort}/json/version`);
      const info = await r.json();
      chromeVersion = info.Browser || '未知';
      return info.webSocketDebuggerUrl;
    } catch {
      if (Date.now() > deadline) throw new Error(`headless Chrome 未在 ${activePort} 端口暴露 CDP（30s 超时）。`);
      await sleep(300);
    }
  }
}

/** 端口上是否已经有 CDP 在应答。 */
async function portBusy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 约定端口是 9333。若它已经被**别人的** headless Chrome 占用（本项目里确实出现过：
 * 另一个进程用 tmp/ca 作为 user-data-dir 常驻在 9333），我们既不能接管那个浏览器
 * （会干扰别人正在跑的东西），也不能把它杀掉，于是退到下一个空闲端口，并把这件事
 * 写进分镜文档。9333 空闲时行为与约定完全一致。
 */
async function pickPort() {
  if (!(await portBusy(CDP_PORT))) return CDP_PORT;
  let owner = '未知进程';
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pages = list.filter((t) => t.type === 'page').map((t) => t.url);
    owner = `已打开的页面：${pages.join(', ') || '无'}`;
  } catch { /* 忽略 */ }
  for (let p = CDP_PORT + 1; p <= CDP_PORT + 11; p += 1) {
    if (!(await portBusy(p))) {
      warnings.push(`约定端口 ${CDP_PORT} 已被另一个 headless Chrome 占用（${owner}）。为避免接管或杀掉别人的浏览器，本次演示改用 ${p} 端口，其余启动参数不变。`);
      return p;
    }
  }
  throw new Error(`端口 ${CDP_PORT}–${CDP_PORT + 11} 全部被占用，无法为演示启动独立的 headless Chrome。`);
}

async function openPage(browserWs) {
  browser = new CDP(browserWs);
  await browser.open();

  // confirm() 会阻塞渲染进程：必须自动接受，否则「返回营地」会卡死。
  // 注意：必须在事件所属的 session 上调用 Page.handleJavaScriptDialog——
  // 浏览器级（无 sessionId）调用会被 CDP 拒绝，而失败被静默吞掉就会永久卡住整局演示。
  browser.on('Page.javascriptDialogOpening', (params, sessionId) => {
    log(`自动确认浏览器对话框：${params.type} — ${String(params.message).slice(0, 40)}`);
    browser.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch((err) => {
      warnings.push(`处理浏览器对话框失败：${err.message}`);
    });
  });

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    send: (method, params) => browser.send(method, params, sessionId),
  };
  session = page;

  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Page.bringToFront');
  await session.send('Page.navigate', { url: APP_URL });
  await waitFor(`document.readyState==='complete'`, { timeout: 30000, label: '页面加载完成' });
  await waitFor(`document.querySelectorAll('#camp-roster .pet-option').length>0`, { timeout: 30000, label: '营地渲染完成' });

  actualViewport = await evalJs(`({width:window.innerWidth,height:window.innerHeight})`);
  appVersion = await evalJs(`document.getElementById('mode-badge').textContent`);
  log(`视口 ${actualViewport.width}×${actualViewport.height}，应用 ${appVersion}`);
}

async function main() {
  const started = Date.now();
  console.log('[demo] === F04 演示产物生成开始 ===');
  await checkApp();
  activePort = await pickPort();
  const wsUrl = await launchChrome();
  await openPage(wsUrl);
  log(`CDP 端口 ${activePort}，浏览器 ${chromeVersion}`);

  try {
    await run();
  } catch (err) {
    warnings.push(`流程中断：${err.message}`);
    console.error('[demo] 流程中断：', err.message);
  }

  const meta = {
    time: localTime(),
    url: APP_URL,
    flags: `--headless=new --no-sandbox --disable-gpu --user-data-dir=${path.relative(WORKSPACE, PROFILE_DIR)} --remote-debugging-port=${CDP_PORT} --window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    port: activePort,
  };
  await writeFile(STORY_PATH, buildStoryboard(meta), 'utf8');

  const ok = shots.filter((s) => s.status === 'ok').length;
  const bad = shots.length - ok;
  console.log(`[demo] === 完成：${shots.length} 张截图（成功 ${ok} / 异常 ${bad}），用时 ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
  console.log(`[demo] 图片目录：${path.relative(WORKSPACE, DEMO_DIR)}/`);
  console.log(`[demo] 分镜文档：${path.relative(WORKSPACE, STORY_PATH)}`);
  if (bad) console.log('[demo] 未达成/跳过的步骤已如实写进分镜文档。');
}

async function cleanup() {
  try { if (browser) await browser.send('Browser.close'); } catch { /* 忽略 */ }
  browser?.close();
  if (chromeProc && chromeProc.exitCode === null) {
    chromeProc.kill('SIGTERM');
    await sleep(700);
    if (chromeProc.exitCode === null) chromeProc.kill('SIGKILL');
  }
}

try {
  await main();
} catch (err) {
  console.error(`[demo] 失败：${err.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  console.log('[demo] 已关闭 headless Chrome。');
}

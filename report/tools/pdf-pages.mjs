// 把 PDF 逐页截成 PNG。
// 本机没有 pdftoppm / ghostscript，唯一的渲染器是 Chrome 自带的 PDF 查看器，
// 所以走 CDP：用 #page=N 导航到指定页，再截视口。
// 用法：node report/tools/pdf-pages.mjs <pdf> <outDir> <pages>
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pdf = resolve(process.argv[2]);
const outDir = resolve(process.argv[3]);
const pages = Number(process.argv[4] || 1);
mkdirSync(outDir, {recursive: true});

const profile = mkdtempSync(join(tmpdir(), 'pdfshot-'));
const PORT = 9411 + Math.floor(Math.random() * 200);

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--disable-crash-reporter', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1240,1754', 'about:blank',
], {stdio: ['ignore', 'ignore', 'ignore']});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(path) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw Error('CDP 未就绪: ' + path);
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {ok, fail} = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(Error(msg.error.message)) : ok(msg.result);
    }
  });
  const ready = new Promise((ok, fail) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', fail);
  });
  return {
    ready,
    send(method, params = {}) {
      const mid = ++id;
      return new Promise((ok, fail) => {
        pending.set(mid, {ok, fail});
        ws.send(JSON.stringify({id: mid, method, params}));
      });
    },
    close: () => ws.close(),
  };
}

try {
  const targets = await json('/json/list');
  const page = targets.find(t => t.type === 'page');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1240, height: 1754, deviceScaleFactor: 1.4, mobile: false,
  });

  for (let n = 1; n <= pages; n++) {
    // 只改 #hash 不会重新导航，加一个查询参数强制重新加载，跳页才生效
    await cdp.send('Page.navigate', {url: `file://${pdf}?p=${n}#page=${n}&zoom=page-width&toolbar=0`});
    await sleep(n === 1 ? 4500 : 2200);
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    const file = join(outDir, `page-${String(n).padStart(2, '0')}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('wrote', file);
  }
  cdp.close();
} finally {
  chrome.kill('SIGKILL');
  try { rmSync(profile, {recursive: true, force: true}); } catch {}
}

// 报告里每张截图的体检：有没有被切、底下有没有大片废白、印出来字号够不够。
//
// 起因：teacher-review.png 最后一行文字被从中间水平切开，底下还拖着 89pt 高的页面底色。
// 肉眼看缩略图不一定看得出来（尤其是「切在半行上」这种），所以这里全部按像素判。
//
// 用法：
//   node report/tools/fig-audit.mjs            # 表格
//   node report/tools/fig-audit.mjs --verbose  # 连每张图的文字行段一起打
//
// 只读：不改图片、不改 tex。
import {readdirSync, readFileSync} from 'node:fs';
import {audit} from './png.mjs';

const FIGS = 'report/figs';
const SECTIONS = ['report/sections', 'report'];
const verbose = process.argv.includes('--verbose');

// 从 .tex 里读出每张图实际插入的栏宽比例。只读——正文正由别人在改，这里不写回。
function insertFractions() {
  const map = new Map();
  const files = [];
  for (const dir of SECTIONS) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.tex')) files.push(`${dir}/${n}`);
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // \shot[0.8]{x.png}{...}    默认 0.72
    for (const m of text.matchAll(/\\shot(?:pair)?(?:\[([\d.]+)\])?\{([^}]+)\}/g)) {
      const frac = Number(m[1] || (m[0].startsWith('\\shotpair') ? 0.46 : 0.72));
      if (m[2].endsWith('.png')) map.set(m[2], {frac, file: file.replace('report/', '')});
    }
    // \shotpair{a.png}{..}{b.png}{..}
    for (const m of text.matchAll(/\\shotpair(?:\[([\d.]+)\])?\{([^}]+)\}\{[^}]*\}\{([^}]+)\}/g)) {
      const frac = Number(m[1] || 0.46);
      for (const name of [m[2], m[3]]) if (name.endsWith('.png')) map.set(name, {frac, file: file.replace('report/', '')});
    }
    // \includegraphics[width=0.9\linewidth]{figs/x.png}
    for (const m of text.matchAll(/\\includegraphics\[width=([\d.]+)\\linewidth\]\{figs\/([^}]+)\}/g)) {
      map.set(m[2], {frac: Number(m[1]), file: file.replace('report/', '')});
    }
  }
  return map;
}

const fracs = insertFractions();
const rows = [];
for (const name of readdirSync(FIGS).filter(n => n.endsWith('.png')).sort()) {
  const info = fracs.get(name);
  const a = audit(`${FIGS}/${name}`, info ? info.frac : null);
  rows.push({...a, name, frac: info?.frac ?? null, used: info?.file ?? null});
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('图', 26) + pad('像素', 12) + pad('栏宽', 6) + pad('拟合pt', 7) + pad('底部空白', 9) + pad('行段', 5) + '判定');
console.log('─'.repeat(100));
const problems = [];
for (const r of rows) {
  const flags = [];
  // 底部废白：正常截图的底部留白 = pad（脚本里的 6~8pt/cs px）×scale，不超过 ~24 设备像素。
  if (r.bottomPad > 30) flags.push(`底部废白 ${r.bottomPad}px`);
  if (r.used === null) flags.push('未被引用');
  if (r.pt !== null && r.pt < 6) flags.push(`字号 ${r.pt.toFixed(1)}pt 偏小`);
  if (r.bands === 0) flags.push('无文字行段');
  if (flags.length) problems.push({name: r.name, flags});
  console.log(
    pad(r.name, 26) + pad(`${r.width}x${r.height}`, 12) +
    pad(r.frac ?? '—', 6) +
    pad(r.pt ? r.pt.toFixed(1) : '—', 7) +
    pad(`${r.bottomPad}px/${(r.bottomPad / 2).toFixed(0)}css`, 9) +
    pad(r.bands, 5) +
    (flags.length ? '⚠ ' + flags.join('；') : '✓'));
  if (verbose) {
    console.log(`   行距 ${r.pitch ?? '—'} 设备px → 字号 ${r.fontPx ? r.fontPx.toFixed(1) : '—'} → 插入 ${r.frac ?? '—'} 栏宽`);
  }
}

console.log('\n引用情况（正文正在被别人改，这里只报当前状态）：');
for (const r of rows) console.log(`  ${pad(r.name, 26)} ${r.used ? `\\shot ${r.frac} 栏宽 ← ${r.used}` : '正文里没有引用'}`);
console.log(`\n${problems.length} 张有疑点：`);
for (const p of problems) console.log(`  ${p.name}: ${p.flags.join('；')}`);

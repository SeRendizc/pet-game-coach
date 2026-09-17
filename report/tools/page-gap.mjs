// 一次性自检：逐页量「最后一行内容离页面底边还有多远」（渲染后的像素，换算成 pt）。
// 用途是看 [H] 固定浮动体留下的空白有多大——LaTeX 不会为 [H] 造成的提前分页报
// underfull \vbox，所以这条只能自己量。
import {readFileSync, readdirSync} from 'node:fs';
import {decodePng, pixel} from './png.mjs';

const dir = process.argv[2] || 'tmp/render/pg';
const dpi = Number(process.argv[3] || 110);
const ptPerPx = 72 / dpi;
for (const f of readdirSync(dir).filter(x => x.endsWith('.png')).sort()) {
  const img = decodePng(`${dir}/${f}`);
  const bg = pixel(img, 2, 2).slice(0, 3);
  // 页码（plain 样式的 folio）永远在最底下那一行，量空白时要把它排除掉：
  // 只在「页脚带」以上找最后一行内容。页脚带 = 下边距 + 20pt。
  const marginPx = Math.round(68 / ptPerPx);
  const footerBand = marginPx + Math.round(20 / ptPerPx);
  let last = -1;
  for (let y = img.height - 1 - footerBand; y >= 0; y--) {
    let n = 0;
    for (let x = 0; x < img.width; x++) {
      const p = pixel(img, x, y);
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 24) n++;
    }
    if (n > 3) { last = y; break; }
  }
  const gapPx = (img.height - marginPx) - 1 - last;
  console.log(`${f}  ${img.width}×${img.height}  正文最后一行 y=${last}  到版心底边还空 ${(gapPx * ptPerPx).toFixed(0)}pt`);
}

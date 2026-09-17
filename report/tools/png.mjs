// 报告截图用的 PNG 小工具：解码、编码、拼接、按行统计。
//
// 为什么要自己写：这台机器上没有 PIL，也没有装任何图像库，而「图有没有被切」「底下那片
// 空白有多高」这类判断必须**看像素**——肉眼看缩略图会漏掉「最后一行被裁掉半截」的图。
// 只依赖 node 自带的 zlib。
//
// 坐标系约定：图里所有量出来的长度都是**设备像素**（截图时 scale=2/3 放大过的那些）。
// 打印字号那一步不需要知道 scale：字号与元素宽度同乘一个 scale，比值不变。
import {readFileSync, writeFileSync} from 'node:fs';
import {inflateSync, deflateSync} from 'node:zlib';

const CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};

export const decodePng = path => decodePngBuffer(readFileSync(path), path);

export function decodePngBuffer(buf, label = 'PNG') {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${label} 不是 PNG`);
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  let plte = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`只支持 8bit（${label} 是 ${depth}bit）`);
  if (interlace) throw new Error('不支持隔行扫描的 PNG');
  const channels = CHANNELS[color];
  if (!channels) throw new Error(`不支持的颜色类型 ${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const planes = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = planes.subarray(y * stride, (y + 1) * stride);
    const prev = y ? planes.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  // 统一转成 RGBA。调色板图（Chrome 对小图会这么存）必须查表，否则「像素值」只是个索引，
  // 拿它当亮度用会得出「整张图没有文字」这种假结论——这一步踩过。
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b, a = 255;
    if (color === 0) { r = g = b = planes[i]; }
    else if (color === 4) { r = g = b = planes[i * 2]; a = planes[i * 2 + 1]; }
    else if (color === 2) { r = planes[i * 3]; g = planes[i * 3 + 1]; b = planes[i * 3 + 2]; }
    else if (color === 6) { r = planes[i * 4]; g = planes[i * 4 + 1]; b = planes[i * 4 + 2]; a = planes[i * 4 + 3]; }
    else {
      const idx = planes[i];
      r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return {width, height, data: rgba};
}

export const pixel = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = buf => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

// 写成 8bit RGBA、filter 0（不预测）。报告里的图只有几百 KB，够用。
export function encodePng(img) {
  const {width, height, data} = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, {level: 9})), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const writePng = (path, img) => writeFileSync(path, encodePng(img));

// 纵向拼接：把若干张等宽的图按顺序摞起来，每张只取指定的行区间。
export function stackPng(slices) {
  const width = slices[0].img.width;
  const height = slices.reduce((n, s) => n + (s.to - s.from), 0);
  const out = {width, height, data: Buffer.alloc(width * height * 4)};
  let row = 0;
  for (const {img, from, to} of slices) {
    if (img.width !== width) throw new Error('拼接的图宽度不一致');
    for (let y = from; y < to; y++, row++) {
      img.data.copy(out.data, row * width * 4, y * width * 4, (y + 1) * width * 4);
    }
  }
  return out;
}

// 每行「与基准色不同」的像素数。用来找元素底边、量底部空白。
export function rowProfile(img, base, tol = 24) {
  const out = new Array(img.height).fill(0);
  for (let y = 0; y < img.height; y++) {
    let diff = 0;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const d = Math.abs(img.data[i] - base[0]) + Math.abs(img.data[i + 1] - base[1]) + Math.abs(img.data[i + 2] - base[2]);
      if (d > tol) diff++;
    }
    out[y] = diff;
  }
  return out;
}

// 每行的「亮像素」数（深色界面上就是文字）。用来量行距、反推字号。
export function inkProfile(img, threshold = 360) {
  const out = new Array(img.height).fill(0);
  for (let y = 0; y < img.height; y++) {
    let n = 0;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] > threshold) n++;
    }
    out[y] = n;
  }
  return out;
}

// 找出连续的文字行段（一组相邻的、有墨的行），返回每段的起止与高度。
export function inkBands(img, {threshold = 360, minInk = 2, minRows = 3} = {}) {
  const prof = inkProfile(img, threshold);
  const bands = [];
  let start = -1;
  for (let y = 0; y <= img.height; y++) {
    const has = y < img.height && prof[y] >= minInk;
    if (has && start < 0) start = y;
    if (!has && start >= 0) { if (y - start >= minRows) bands.push({from: start, to: y - 1, h: y - start}); start = -1; }
  }
  return {bands, prof};
}

// 中位数行距 → 字号。报告的页面统一 line-height:1.5（少数地方 1.6），
// 所以「相邻两行文字的起点之差」就是 1.5 倍字号。取中位数抗住标题、空行与短行。
export function linePitch(bands) {
  const tops = bands.map(b => b.from);
  const gaps = [];
  for (let i = 1; i < tops.length; i++) { const g = tops[i] - tops[i - 1]; if (g >= 4) gaps.push(g); }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  // 只有两三个行段时，中位数可能落在「标题到正文」这种大跨度上，
  // 折出来的字号会离谱（teacher-roles.png 曾算出 657pt）。宁可不报，也不报错数。
  if (bands.length < 4 || median < 8 || median > 80) return null;
  return median;
}

// 一张图的体检：底部空白多高、内容顶到哪一行、字号折算成打印 pt。
// 正文栏宽 453.5pt（preamble 里的 \linewidth），图按 fraction 栏宽插入。
export const COLUMN_PT = 453.5;
export function audit(path, fraction = null) {
  const img = decodePng(path);
  const base = pixel(img, 1, 1).slice(0, 3);
  const prof = rowProfile(img, base);
  const wide = img.width * 0.02;
  let lastContent = -1, firstContent = img.height;
  prof.forEach((n, y) => { if (n > wide) { lastContent = y; if (y < firstContent) firstContent = y; } });
  const {bands} = inkBands(img);
  const pitch = linePitch(bands);
  // 行距 → 字号（1.5 倍）→ 打印 pt。字号与元素宽度在同一个坐标里，scale 自动约掉。
  const fontPx = pitch ? pitch / 1.5 : null;
  const pt = fraction && fontPx ? (fontPx / img.width) * fraction * COLUMN_PT : null;
  return {
    path, width: img.width, height: img.height,
    rows: img.height, bands: bands.length, pitch, fontPx, pt,
    bottomPad: img.height - 1 - lastContent,
    topPad: firstContent,
    bg: base,
  };
}

#!/usr/bin/env node
// 从原始 world.js（window.WORLD_LAND = [[[lon,lat],...],...]）生成差分编码版。
//
// 编码规则：每个环内一阶差分，整数单位 = 1/s 度（s = 10^小数位数，本数据为 10）。
// 解码规则必须与 viewer/index.html 的 decodeLand() 一致。
//
// 用法：
//   node scripts/build-world-land.mjs               # 就地生成 viewer/world.js
//   node scripts/build-world-land.mjs --check       # 只校验当前文件与生成结果逐字节一致
//   node scripts/build-world-land.mjs --source <原始 world.js> [--target <输出>]
//
// 幂等：对编码后的文件再跑一次，会先解码、再按同一规则编码，输出字节不变。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = path.resolve(HERE, '../viewer/world.js');

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? path.resolve(argv[i + 1]) : null;
};
const target = opt('--target') || DEFAULT_TARGET;
const source = opt('--source') || target;

const HEADER = [
  '// Natural Earth 110m land, simplified (0.1 deg rounding, small islands dropped).',
  '// Source: natural-earth-vector (public domain). Bundled so the viewer works offline.',
  '// 编码：环内一阶差分，单位为 1/s 度；解码见 viewer/index.html 的 decodeLand()。',
  '// 生成/校验：node scripts/build-world-land.mjs [--check]',
].join('\n');

function decode(enc) {
  const out = [];
  for (const a of enc.d) {
    const ring = [];
    let x = 0, y = 0;
    for (let i = 0; i < a.length; i += 2) {
      x += a[i];
      y += a[i + 1];
      ring.push([x / enc.s, y / enc.s]);
    }
    out.push(ring);
  }
  return out;
}

function load(file) {
  const text = fs.readFileSync(file, 'utf8');
  const w = {};
  // world.js 是一段给浏览器执行的赋值语句；这里只借它取数据，不引入脚本加载。
  new Function('window', text + '\nreturn window;')(w);
  if (w.WORLD_LAND_ENC) {
    if (!Array.isArray(w.WORLD_LAND_ENC.d)) throw new Error('WORLD_LAND_ENC.d 不是数组');
    return decode(w.WORLD_LAND_ENC);
  }
  if (Array.isArray(w.WORLD_LAND)) return w.WORLD_LAND;
  throw new Error('源文件里既没有 window.WORLD_LAND，也没有 window.WORLD_LAND_ENC');
}

// 找出让全部坐标都落在整数格点上的最小 10^k（坐标精度决定 k）。
function decimalsNeeded(land) {
  let k = 0;
  for (const ring of land) {
    for (const p of ring) {
      for (const v of p) {
        let found = -1;
        for (let i = 0; i <= 6; i++) {
          const t = v * 10 ** i;
          if (Math.abs(t - Math.round(t)) < 1e-9) { found = i; break; }
        }
        if (found < 0) throw new Error('坐标精度超过 1e-6，拒绝编码: ' + v);
        if (found > k) k = found;
      }
    }
  }
  return k;
}

function encode(land, k) {
  const s = 10 ** k;
  return land.map((ring) => {
    const a = [];
    let px = 0, py = 0;
    for (const p of ring) {
      const x = Math.round(p[0] * s);
      const y = Math.round(p[1] * s);
      a.push(x - px, y - py);
      px = x; py = y;
    }
    return a;
  });
}

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

const land = load(source);
const k = decimalsNeeded(land);
const s = 10 ** k;
const d = encode(land, k);
const back = decode({ s, d });

const srcSha = sha(land);
const backSha = sha(back);
const same = srcSha === backSha;

const points = land.reduce((n, r) => n + r.length, 0);
console.log('rings=' + land.length + ' points=' + points + ' scale=' + s);
console.log('sha256(orig)=' + srcSha);
console.log('sha256(decode(encode(orig)))=' + backSha);
console.log('lossless=' + same);
if (!same) throw new Error('往返不相等，拒绝写文件');

const enc = { v: 1, s, rings: land.length, points, d };
const out = HEADER + '\nwindow.WORLD_LAND_ENC = ' + JSON.stringify(enc) + ';\n';
console.log('encoded_bytes=' + Buffer.byteLength(out) +
  ' gzip=' + zlib.gzipSync(Buffer.from(out), { level: 6 }).length);

if (check) {
  // 兼容 core.autocrlf 检出的 CRLF：按 LF 归一后再逐字节比较。
  const cur = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  if (cur === out) {
    console.log('check=OK  ' + target);
    process.exit(0);
  }
  let i = 0;
  while (i < cur.length && i < out.length && cur[i] === out[i]) i++;
  console.log('check=DIFF  ' + target + '  首个差异 offset=' + i);
  console.log('  current : ' + JSON.stringify(cur.slice(Math.max(0, i - 40), i + 40)));
  console.log('  expected: ' + JSON.stringify(out.slice(Math.max(0, i - 40), i + 40)));
  process.exit(1);
}

fs.writeFileSync(target, out, 'utf8');
console.log('wrote=' + target);

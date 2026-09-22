// The app icon, for all three platforms, from one description of the mark.
//
//   node scripts/make-icons.mjs
//
// Writes build/icon.ico (Windows), build/icon.icns (macOS) and
// build/icons/*.png (Linux). No image library: PNG is deflate plus a few
// headers, ICO and ICNS are containers, and adding a dependency to draw a
// hexagon with two wings would be silly.
//
// The mark is the hive bee from the SWARM brand sheet: two honey wings over an
// orange hexagon with two dark stripes.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const ICONS = path.join(BUILD, 'icons');
fs.mkdirSync(ICONS, { recursive: true });

const BG = [0x0a, 0x09, 0x08, 0xff];      // #0A0908
const ORANGE = [0xff, 0x8a, 0x1f, 0xff];  // #FF8A1F
const HONEY = [0xff, 0xb0, 0x20, 0xff];   // #FFB020

/** RGBA pixels of the mark at `size`, drawn in the 64x64 space of the brand sheet. */
function pixels(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const X = ((x + 0.5) * 64) / size;
      const Y = ((y + 0.5) * 64) / size;
      let c = BG;
      // Two wings, ellipses rotated away from the body.
      const wing = (cx, cy, rot) => {
        const dx = X - cx;
        const dy = Y - cy;
        const a = (rot * Math.PI) / 180;
        const rx = dx * Math.cos(a) + dy * Math.sin(a);
        const ry = -dx * Math.sin(a) + dy * Math.cos(a);
        return (rx * rx) / (12 * 12) + (ry * ry) / (6.5 * 6.5) <= 1;
      };
      if (wing(21, 17, -28) || wing(43, 17, 28)) c = HONEY;
      // The hexagon body, with the two stripes cut out of it.
      const dx = Math.abs(X - 32);
      const dy = Y - 39;
      const inHex = X >= 18 && X <= 46 && Y >= 22 && Y <= 56
        && dx / 14 + Math.max(0, Math.abs(dy) - 9) / 8 <= 1;
      if (inHex) {
        c = ORANGE;
        if ((Y >= 35 && Y <= 39) || (Y >= 44 && Y <= 48)) c = BG;
      }
      const o = (y * size + x) * 4;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = c[3];
    }
  }
  return buf;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** A true-colour-with-alpha PNG. */
function png(size) {
  const rgba = pixels(size);
  // Each row is prefixed with a filter byte; filter 0 (None) keeps this simple.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Windows .ico, BMP payloads (what Windows expects for small sizes). */
function ico(sizes) {
  const images = sizes.map((size) => {
    const rgba = pixels(size);
    const bmp = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      // BMP rows run bottom-up and are BGRA.
      for (let x = 0; x < size; x += 1) {
        const s = (y * size + x) * 4;
        const d = ((size - 1 - y) * size + x) * 4;
        bmp[d] = rgba[s + 2]; bmp[d + 1] = rgba[s + 1]; bmp[d + 2] = rgba[s]; bmp[d + 3] = rgba[s + 3];
      }
    }
    const andSize = ((size + 31) >> 5) * 4 * size;
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(bmp.length + andSize, 20);
    return { size, data: Buffer.concat([header, bmp, Buffer.alloc(andSize)]) };
  });
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir[e] = img.size === 256 ? 0 : img.size;
    dir[e + 1] = img.size === 256 ? 0 : img.size;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

/** macOS .icns with PNG payloads, which macOS has accepted since 10.7. */
function icns() {
  const TYPES = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64],
    ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]
  ];
  const entries = TYPES.map(([type, size]) => {
    const data = png(size);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length + 8);
    return Buffer.concat([Buffer.from(type, 'ascii'), len, data]);
  });
  const body = Buffer.concat(entries);
  const total = Buffer.alloc(4);
  total.writeUInt32BE(body.length + 8);
  return Buffer.concat([Buffer.from('icns', 'ascii'), total, body]);
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(icoSizes));
fs.writeFileSync(path.join(BUILD, 'icon.icns'), icns());
// electron-builder picks the Linux icon set out of a directory of PNGs whose
// names are their pixel size.
const pngSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
for (const size of pngSizes) fs.writeFileSync(path.join(ICONS, `${size}x${size}.png`), png(size));
// A single 512 png is also what some tools look for.
fs.writeFileSync(path.join(BUILD, 'icon.png'), png(512));

const show = (f) => `${path.relative(ROOT, f)}  ${(fs.statSync(f).size / 1024).toFixed(0)} KB  sha256 ${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12)}`;
console.log(show(path.join(BUILD, 'icon.ico')));
console.log(show(path.join(BUILD, 'icon.icns')));
console.log(show(path.join(BUILD, 'icon.png')));
console.log(`build/icons/: ${pngSizes.map((s) => `${s}x${s}`).join(', ')}`);

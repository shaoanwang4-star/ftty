// 生成测试用 PNG 样张（纯 zlib，无依赖）：node scripts/make-sample-pngs.js
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let c, table = crc32.t || (crc32.t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })());
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function makePng(w, h, painter) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = painter(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 用 5x7 位图点阵把页码画成大色块图案（辨识度足够测试用）
const DIGITS = {
  "0": ["11111", "10001", "10011", "10101", "11001", "10001", "11111"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["11111", "00001", "11111", "10000", "10000", "10000", "11111"],
  "3": ["11111", "00001", "11111", "00001", "00001", "00001", "11111"],
  "4": ["10001", "10001", "11111", "00001", "00001", "00001", "00001"],
  "5": ["11111", "10000", "11111", "00001", "00001", "10001", "11111"],
  "6": ["11111", "10000", "11111", "10001", "10001", "10001", "11111"],
};

function painterFor(num, hue) {
  const s = String(num);
  const cell = 60, ox = 40, oy = 100;
  const bg1 = hsl(hue, 30, 18), bg2 = hsl(hue + 40, 45, 38);
  const fg = hsl(hue + 20, 85, 65);
  return (x, y) => {
    const t = y / 720;
    const base = [
      Math.round(bg1[0] + (bg2[0] - bg1[0]) * t),
      Math.round(bg1[1] + (bg2[1] - bg1[1]) * t),
      Math.round(bg1[2] + (bg2[2] - bg1[2]) * t),
    ];
    const di = Math.floor((x - ox) / cell);
    const px = (x - ox) % cell, py = y - oy;
    if (di >= 0 && di < s.length && py >= 0 && py < 7 * cell) {
      const row = DIGITS[s[di]][Math.floor(py / cell)];
      if (row[Math.min(4, Math.floor(px / (cell / 5)))] === "1") return fg;
    }
    if (y > 640 && (Math.floor(x / 40) + Math.floor(y / 40)) % 2 === 0) return hsl(hue, 20, 26);
    return base;
  };
}

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
  return [Math.round(f(0)), Math.round(f(8)), Math.round(f(4))];
}

const out = path.join(__dirname, "..", "sample-assets");
fs.mkdirSync(out, { recursive: true });
for (let i = 1; i <= 6; i++) {
  const png = makePng(600, 720, painterFor(i, i * 47));
  fs.writeFileSync(path.join(out, `page${i}.png`), png);
  console.log(`page${i}.png ${(png.length / 1024).toFixed(1)}KB`);
}

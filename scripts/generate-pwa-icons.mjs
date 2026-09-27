// Deterministic raster of src/app/icon.svg: green rounded square and cream check.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}

function image(size, opaqueBackground = false) {
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * 64 / size;
      const py = (y + 0.5) * 64 / size;
      const dx = Math.max(14 - px, 0, px - 50);
      const dy = Math.max(14 - py, 0, py - 50);
      const inside = Math.hypot(dx, dy) <= 14;
      const check = Math.min(segmentDistance(px, py, 17, 33, 27, 43), segmentDistance(px, py, 27, 43, 48, 20)) <= 3.5;
      const index = y * (1 + size * 4) + 1 + x * 4;
      const color = check ? [246, 244, 237, 255] : inside ? [36, 92, 59, 255] : opaqueBackground ? [246, 244, 237, 255] : [36, 92, 59, 0];
      for (let channel = 0; channel < 4; channel++) rows[index + channel] = color[channel];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(join("public", "icons", `icon-${size}.png`), image(size));
writeFileSync(join("public", "icons", "apple-touch-icon-180.png"), image(180, true));

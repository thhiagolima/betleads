// Generates the neutral Storage placeholders committed under placeholders/:
//   silence.mp3 — 2 s of silence (MPEG-2 Layer III, 22.05 kHz, 32 kbps, mono)
//   neutral.png — 240×120 flat light-grey image, no text or brand
// Deterministic: running it again produces byte-identical files.
//   node scripts/demo/make-placeholders.mjs
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

export const PLACEHOLDER_SECONDS = 2;

export function silentMp3(seconds = PLACEHOLDER_SECONDS) {
  const frameBytes = 104; // 72 * 32000 / 22050, no padding
  const frames = Math.ceil((22050 * seconds) / 576);
  const out = Buffer.alloc(frames * frameBytes);
  for (let i = 0; i < frames; i += 1) {
    // sync + MPEG-2 + Layer III + no CRC | 32 kbps, 22.05 kHz | mono
    out.set([0xff, 0xf3, 0x40, 0xc0], i * frameBytes);
  }
  return out;
}

export function neutralPng(width = 240, height = 120, rgb = [0xe5, 0xe7, 0xeb]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "placeholders");
  writeFileSync(resolve(dir, "silence.mp3"), silentMp3());
  writeFileSync(resolve(dir, "neutral.png"), neutralPng());
  console.log("placeholders written to", dir);
}

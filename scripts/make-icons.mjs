import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
const directory = new URL('../icons/', import.meta.url);
await mkdir(directory, { recursive: true });
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([size, t, data, crc]); }
for (const size of [180, 192, 512]) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = x / size, ny = y / size;
    let color = [54, 87, 77];
    if (nx > .22 && nx < .78 && ny > .17 && ny < .83) color = [250, 247, 237];
    if (nx > .28 && nx < .72 && [.36, .48, .6, .72].some(line => Math.abs(ny - line) < .007)) color = [193, 207, 197];
    if (nx > .28 && nx < .32 && ny > .17 && ny < .83) color = [218, 157, 96];
    if (nx > .47 && nx < .78 && Math.abs(ny - (.96 - nx * .65)) < .028) color = [47, 69, 62];
    const offset = y * (size * 4 + 1) + 1 + x * 4; pixels.set([...color, 255], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(new URL(size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`, directory), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}
console.log('180 / 192 / 512px PNG icons generated.');

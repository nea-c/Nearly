// Render the original vector asset with an existing Chromium installation.
// No image package, network request, or alteration of the application icon.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sizes = [16, 24, 32, 48, 64, 256];

export function encodeIco(frames) {
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  const images = frames.map(({size, rgba}, i) => {
    if (rgba.length !== size * size * 4) throw Error('Invalid RGBA frame length');
    const maskStride = Math.ceil(size / 32) * 4;
    const dib = Buffer.alloc(40 + rgba.length + maskStride * size);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    dib.writeUInt32LE(rgba.length, 20);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4;
      const dest = 40 + ((size - y - 1) * size + x) * 4;
      dib[dest] = rgba[source + 2];
      dib[dest + 1] = rgba[source + 1];
      dib[dest + 2] = rgba[source];
      dib[dest + 3] = rgba[source + 3];
      if (rgba[source + 3] === 0) {
        dib[40 + rgba.length + (size - y - 1) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    const entry = 6 + i * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(dib.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += dib.length;
    return dib;
  });
  return Buffer.concat([directory, ...images]);
}

export async function generateUninstallIcon(output = path.join(root, 'src-tauri/icons/uninstall.ico')) {
  const svg = await fs.readFile(path.join(root, 'src-tauri/icons/uninstall-source.svg'), 'utf8');
  const executablePath = process.env.NEARLY_ICON_BROWSER;
  const browser = await chromium.launch(executablePath ? {executablePath} : process.platform === 'win32' ? {channel: 'msedge'} : {});
  try {
    const page = await browser.newPage({deviceScaleFactor: 1});
    const frames = await page.evaluate(async ({svg, sizes}) => {
      const image = new Image();
      image.src = 'data:image/svg+xml;base64,' + btoa(svg);
      await image.decode();
      return sizes.map(size => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, size, size);
        return {size, rgba: Array.from(context.getImageData(0, 0, size, size).data)};
      });
    }, {svg, sizes});
    const bytes = encodeIco(frames);
    await fs.writeFile(output, bytes);
    console.log(`${output}: ${bytes.length} bytes; ${sizes.join('/')}px`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateUninstallIcon(process.argv[2]);
}

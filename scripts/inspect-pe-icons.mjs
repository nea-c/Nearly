// Static PE resource inspection only: never loads or executes the inspected file.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

export function icoImages(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x10000, 'ICO signature');
  return Array.from({length: bytes.readUInt16LE(4)}, (_, i) => {
    const entry = 6 + i * 16;
    const offset = bytes.readUInt32LE(entry + 12);
    return {size: bytes[entry] || 256, bytes: bytes.subarray(offset, offset + bytes.readUInt32LE(entry + 8))};
  });
}

export function peResources(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0x5a4d, 'PE DOS signature');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt32LE(pe), 0x4550, 'PE signature');
  const count = bytes.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const sections = optional + bytes.readUInt16LE(pe + 20);
  const rvaOffset = rva => {
    for (let i = 0; i < count; i++) {
      const s = sections + i * 40;
      const va = bytes.readUInt32LE(s + 12), length = bytes.readUInt32LE(s + 16);
      if (rva >= va && rva - va < length) return bytes.readUInt32LE(s + 20) + rva - va;
    }
    throw Error(`Unmapped resource RVA ${rva}`);
  };
  const magic = bytes.readUInt16LE(optional);
  assert.ok(magic === 0x10b || magic === 0x20b, 'PE optional header');
  const resource = rvaOffset(bytes.readUInt32LE(optional + (magic === 0x20b ? 112 : 96) + 16));
  const found = [];
  function visit(relative, ids) {
    assert.ok(ids.length < 4, 'bounded PE resource tree');
    const directory = resource + relative;
    const entries = bytes.readUInt16LE(directory + 12) + bytes.readUInt16LE(directory + 14);
    for (let i = 0; i < entries; i++) {
      const e = directory + 16 + i * 8;
      const id = bytes.readUInt32LE(e), target = bytes.readUInt32LE(e + 4);
      if (target & 0x80000000) visit(target & 0x7fffffff, [...ids, id]);
      else {
        const data = resource + target;
        const start = rvaOffset(bytes.readUInt32LE(data)), length = bytes.readUInt32LE(data + 4);
        assert.ok(start + length <= bytes.length, 'resource fits file');
        found.push({ids: [...ids, id], bytes: bytes.subarray(start, start + length)});
      }
    }
  }
  visit(0, []);
  return found;
}

export function assertPeIconMatches(peBytes, icoBytes) {
  const resources = peResources(peBytes);
  const groups = resources.filter(r => r.ids[0] === 14);
  const frames = icoImages(icoBytes);
  assert.ok(groups.length > 0, 'PE has an icon group');
  for (const group of groups) {
    assert.equal(group.bytes.readUInt16LE(4), frames.length, 'icon group frame count');
    frames.forEach((frame, i) => {
      const e = 6 + i * 14;
      assert.equal(group.bytes[e] || 256, frame.size, 'icon group size');
      const id = group.bytes.readUInt16LE(e + 12);
      const image = resources.find(r => r.ids[0] === 3 && r.ids[1] === id && r.ids[2] === group.ids[2]);
      assert.ok(image, `RT_ICON ${id} exists`);
      // NSIS reserves the larger installer/uninstaller resource size in both
      // stubs. Shorter PNG icons retain their original bytes plus zero padding.
      assert.ok(image.bytes.subarray(0, frame.bytes.length).equals(frame.bytes), `${frame.size}px icon resource matches source`);
      assert.ok(image.bytes.subarray(frame.bytes.length).every(byte => byte === 0), 'only zero resource padding is allowed');
    });
  }
  return frames.map(f => f.size);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [exe, ico] = process.argv.slice(2);
  if (!exe || !ico) throw Error('Usage: node scripts/inspect-pe-icons.mjs <exe> <ico>');
  const sizes = assertPeIconMatches(fs.readFileSync(exe), fs.readFileSync(ico));
  console.log(`Verified PE icon resources: ${sizes.join('/')}px in ${exe}`);
}

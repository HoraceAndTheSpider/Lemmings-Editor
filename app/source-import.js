(() => {
  'use strict';

  const text = (bytes, start, length) => {
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[start + i]);
    return s;
  };
  const le16 = (b, o) => b[o] | (b[o + 1] << 8);
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const be32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const basename = (p) => p.replace(/\\/g, '/').split('/').pop();
  const canonicalName = (name) => {
    const base = basename(name);
    let m;
    if ((m = /^level(\d{3})$/i.exec(base))) return `Level${m[1]}`;
    if ((m = /^ground(\d+)$/i.exec(base))) return `Ground${Number(m[1])}`;
    if ((m = /^objects(\d+)$/i.exec(base))) return `Objects${Number(m[1])}`;
    if ((m = /^special(\d+)$/i.exec(base))) return `special${Number(m[1])}`;
    if (/^oddtable$/i.test(base)) return 'oddtable';
    return base;
  };
  const align1024 = (v) => (v + 1023) & ~1023;
  const readFileBytes = async (file) => {
    if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name || 'selected file'}.`));
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.readAsArrayBuffer(file);
    });
  };

  function parseLha(bytes) {
    const entries = [];
    let offset = 0;

    while (offset + 24 <= bytes.length && bytes[offset] !== 0) {
      const level = bytes[offset + 20];
      if (level > 3) throw new Error(`Unsupported LHA header level ${level}.`);
      if (level === 3 && le16(bytes, offset) !== 4) throw new Error('Unsupported LHA level-3 word size.');

      let packedLength = le32(bytes, offset + 7);
      const originalLength = le32(bytes, offset + 11);
      let name = '';
      const nameLength = bytes[offset + 21];
      if (level < 2 && nameLength) name = text(bytes, offset + 22, nameLength).split('\0')[0];

      let extendedOffset = level === 3 ? 28 : level === 2 ? 24 : bytes[offset];
      const extendedSizeBytes = level === 3 ? 4 : 2;
      const readExtendedLength = (at) => level === 3 ? le32(bytes, at) : le16(bytes, at);
      let directory = '';

      if (level > 0) {
        while (true) {
          const length = readExtendedLength(offset + extendedOffset);
          if (length === 0) break;
          const typeOffset = offset + extendedOffset + extendedSizeBytes;
          const dataOffset = typeOffset + 1;
          const dataLength = length - extendedSizeBytes - 1;
          const type = bytes[typeOffset];
          if (type === 1) name = text(bytes, dataOffset, dataLength);
          else if (type === 2) directory = text(bytes, dataOffset, dataLength);
          extendedOffset += length;
        }
        extendedOffset += extendedSizeBytes;
        if (directory) name = directory.replace(/\xff/g, '/') + name;
      }

      let headersLength = level < 2 ? bytes[offset] + 2 : level === 2 ? le16(bytes, offset) : le32(bytes, offset + 24);
      if (level === 1) {
        packedLength -= extendedOffset - headersLength;
        headersLength = extendedOffset;
      }
      if (offset + headersLength + packedLength > bytes.length) throw new Error(`Truncated LHA entry ${name || '(unnamed)'}.`);

      entries.push({
        name,
        method: text(bytes, offset + 2, 5),
        packedLength,
        length: originalLength,
        data: bytes.subarray(offset + headersLength, offset + headersLength + packedLength)
      });
      offset += headersLength + packedLength;
    }
    return entries;
  }

  function createTree(symbolCount, directBits) {
    return {
      symbolCount,
      directBits,
      lengths: new Uint8Array(symbolCount),
      nodes: new Uint16Array(Math.max(1 << directBits, symbolCount * 2) + symbolCount * 2)
    };
  }

  function fillSingle(tree, symbol) {
    tree.nodes.fill(symbol, 0, 1 << tree.directBits);
    tree.lengths.fill(0);
  }

  function buildHuffman(tree) {
    const { symbolCount, directBits, lengths, nodes } = tree;
    const directSize = 1 << directBits;
    let position = 0;

    for (let bitLength = 1, fill = directSize >> 1; bitLength <= directBits; bitLength++, fill >>= 1) {
      for (let symbol = 0; symbol < symbolCount; symbol++) {
        if (lengths[symbol] !== bitLength) continue;
        if (position + fill > directSize) throw new Error('Invalid LHA Huffman table.');
        for (let i = 0; i < fill; i++) nodes[position++] = symbol;
      }
    }
    if (position === directSize) return;
    for (let i = position; i < directSize; i++) nodes[i] = 0xffff;

    let nextNode = Math.max(directSize >> 1, symbolCount);
    position <<= 16;
    const target = directSize << 16;
    let longest = 0;
    for (const n of lengths) longest = Math.max(longest, n);

    for (let bitLength = directBits + 1, step = 1 << 15; bitLength <= longest; bitLength++, step >>= 1) {
      for (let symbol = 0; symbol < symbolCount; symbol++) {
        if (lengths[symbol] !== bitLength) continue;
        if (position >= target) throw new Error('Invalid LHA Huffman tree.');
        let leaf = position >> 16;
        for (let depth = 0; depth < bitLength - directBits; depth++) {
          if (nodes[leaf] === 0xffff) {
            nodes[nextNode * 2] = 0xffff;
            nodes[nextNode * 2 + 1] = 0xffff;
            nodes[leaf] = nextNode++;
          }
          leaf = (nodes[leaf] * 2) | ((position >> (15 - depth)) & 1);
        }
        nodes[leaf] = symbol;
        position += step;
      }
    }
    if (position !== target) throw new Error('Incomplete LHA Huffman table.');
  }

  function unpackLha2(windowBits, input, outputLength) {
    // LHA -lh4-/-lh5-/-lh6-/-lh7- share this Huffman/LZ stream shape;
    // only the history-window size changes. The bitstream is MSB-first.
    const output = new Uint8Array(outputLength);
    const history = new Uint8Array(1 << windowBits);
    history.fill(0x20);
    const windowMask = history.length - 1;
    const pretree = createTree(20, 7);
    const mainTree = createTree(510, 9);
    const distanceTree = createTree(windowBits, 7);

    let inPos = 0, outPos = 0, historyPos = 0;
    let bitBuffer = 0, bitCount = 0;

    const peekBits = (count) => {
      while (bitCount < count) {
        bitBuffer = (bitBuffer << 8) | (input[inPos++] ?? 0);
        bitCount += 8;
      }
      return (bitBuffer >> (bitCount - count)) & ((1 << count) - 1);
    };
    const readBits = (count) => {
      const value = peekBits(count);
      bitCount -= count;
      return value;
    };
    const emit = (value) => {
      output[outPos++] = value;
      history[historyPos] = value;
      historyPos = (historyPos + 1) & windowMask;
    };
    const readTree = (tree, readLength) => {
      tree.lengths.fill(0);
      const countBits = Math.ceil(Math.log2(tree.symbolCount + 1));
      const count = Math.min(readBits(countBits), tree.symbolCount);
      if (count === 0) {
        fillSingle(tree, readBits(countBits));
        return;
      }
      for (let i = 0; i < count; i++) i += readLength(tree.lengths, i) || 0;
      buildHuffman(tree);
    };
    const readCode = (tree) => {
      let bits = tree.directBits;
      let code = tree.nodes[peekBits(bits)];
      while (code >= tree.symbolCount) code = tree.nodes[(code * 2) | (peekBits(++bits) & 1)];
      bitCount -= tree.lengths[code];
      return code;
    };

    while (outPos < outputLength) {
      let commands = readBits(16);

      readTree(pretree, (lengths, i) => {
        lengths[i] = readBits(3);
        if (lengths[i] === 7) while (readBits(1)) lengths[i]++;
        return i === 2 ? readBits(2) : 0;
      });
      readTree(mainTree, (lengths, i) => {
        const c = readCode(pretree);
        if (c === 1) return readBits(4) + 2;
        if (c === 2) return readBits(9) + 19;
        if (c > 2) lengths[i] = c - 2;
        return 0;
      });
      readTree(distanceTree, (lengths, i) => {
        lengths[i] = readBits(3);
        if (lengths[i] === 7) while (readBits(1)) lengths[i]++;
        return 0;
      });

      while (commands-- > 0 && outPos < outputLength) {
        const code = readCode(mainTree);
        if (code < 256) {
          emit(code);
          continue;
        }
        let length = code - 253;
        const distanceCode = readCode(distanceTree);
        const distance = distanceCode === 0 ? 0 : distanceCode === 1 ? 1 : (1 << (distanceCode - 1)) + readBits(distanceCode - 1);
        let copyPos = historyPos - distance - 1;
        while (length-- > 0 && outPos < outputLength) emit(history[copyPos++ & windowMask]);
      }
    }
    return output;
  }

  function unpackLhaEntry(entry) {
    if (entry.method === '-lh0-' || entry.method === '-lz4-' || entry.method === '-pm0-' || entry.method === '-lhd-') return entry.data;
    if (entry.method === '-lh4-') return unpackLha2(13, entry.data, entry.length);
    if (entry.method === '-lh5-') return unpackLha2(14, entry.data, entry.length);
    if (entry.method === '-lh6-') return unpackLha2(16, entry.data, entry.length);
    if (entry.method === '-lh7-') return unpackLha2(17, entry.data, entry.length);
    throw new Error(`Unsupported LHA compression method ${entry.method} for ${entry.name}.`);
  }

  function parseLemmingsDiskImage(bytes) {
    const tableOffset = 0x3000;
    const recordSize = 16;
    if (bytes.length < 0x4000 || text(bytes, tableOffset, 8) !== 'Reserved') return null;

    const table = [];
    for (let i = 0; i < 256; i++) {
      const p = tableOffset + i * recordSize;
      if (p + recordSize > bytes.length) break;
      const rawName = bytes.subarray(p, p + 12);
      const size = be32(bytes, p + 12);
      if (size === 0xffffffff && Array.from(rawName).every(v => v === 0xff || v === 0)) break;
      let name = '';
      for (const c of rawName) {
        if (c === 0 || c === 0xff) break;
        name += String.fromCharCode(c);
      }
      if (!name || size === 0xffffffff) break;
      table.push({ name, size });
    }
    if (!table.length || table[0].name !== 'Reserved') return null;

    let dataOffset = table[0].size;
    const extracted = new Map();
    const entries = [];
    for (let i = 1; i < table.length; i++) {
      dataOffset = align1024(dataOffset);
      const { name, size } = table[i];
      if (dataOffset + size > bytes.length) throw new Error(`Disk image file ${name} extends past the end of the image.`);
      const payload = bytes.slice(dataOffset, dataOffset + size);
      extracted.set(name, payload);
      entries.push({ name, size, offset: dataOffset });
      dataOffset += size;
    }
    return { files: extracted, entries, reservedBytes: table[0].size };
  }

  async function collectSources(fileList, onProgress = () => {}) {
    const loose = new Map();
    const diskImages = [];
    const archives = [];
    const notes = [];
    const progress = async (message) => {
      try { onProgress(message); } catch (_) {}
      // Yield a task so status/diagnostic text has a chance to paint before
      // synchronous LHA decompression or disk parsing.
      await new Promise(resolve => setTimeout(resolve, 0));
    };

    const registerLoose = (name, bytes, origin) => {
      const key = canonicalName(name);
      if (!key || key.startsWith('._') || key === '.DS_Store') return;
      if (!loose.has(key)) loose.set(key, { bytes: bytes.slice ? bytes.slice() : new Uint8Array(bytes), origin });
    };
    const consumeDisk = (name, bytes, origin) => {
      const parsed = parseLemmingsDiskImage(bytes);
      if (!parsed) return false;
      diskImages.push({ name: basename(name), origin, ...parsed });
      for (const [fileName, payload] of parsed.files) registerLoose(fileName, payload, `${origin} → ${basename(name)}`);
      return true;
    };

    for (const file of fileList) {
      const name = file.webkitRelativePath || file.name;
      await progress(`Reading ${basename(name)}…`);
      const bytes = await readFileBytes(file);
      const lower = basename(name).toLowerCase();

      if (lower.endsWith('.lha') || lower.endsWith('.lzh')) {
        const entries = parseLha(bytes);
        archives.push({ name: basename(name), entries: entries.map(e => ({ name: e.name, method: e.method, length: e.length })) });
        await progress(`${basename(name)}: ${entries.length} LHA entries found.`);
        for (const entry of entries) {
          if (entry.method === '-lhd-') continue;
          const entryName = basename(entry.name);
          const interesting = /^disk\.\d+$/i.test(entryName) || /^(Level\d{3}|Ground\d+|Objects\d+|oddtable|special\d+)$/i.test(entryName);
          if (!interesting) continue;
          await progress(`Extracting ${entry.name} (${entry.method})…`);
          const payload = unpackLhaEntry(entry);
          if (/^disk\.\d+$/i.test(entryName)) {
            if (!consumeDisk(entryName, payload, `${basename(name)}:${entry.name}`)) notes.push(`${entry.name} was extracted from the LHA but does not use the recognised Lemmings disk-image table.`);
            else await progress(`${entryName}: recognised Lemmings disk image and indexed embedded files.`);
          } else {
            registerLoose(entryName, payload, `${basename(name)}:${entry.name}`);
          }
        }
        continue;
      }

      if (/^disk\.\d+$/i.test(lower)) {
        if (!consumeDisk(name, bytes, basename(name))) notes.push(`${basename(name)} does not use the recognised Lemmings disk-image table.`);
        else await progress(`${basename(name)}: recognised Lemmings disk image and indexed embedded files.`);
        continue;
      }
      registerLoose(name, bytes, 'loose file/folder');
    }

    await progress(`Source scan complete: ${loose.size} files indexed.`);
    return { files: loose, diskImages, archives, notes };
  }

  globalThis.LEMMINGS_SOURCE_IMPORT = {
    parseLha,
    unpackLhaEntry,
    parseLemmingsDiskImage,
    collectSources
  };
})();

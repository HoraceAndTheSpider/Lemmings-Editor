const { APP_VERSION, CAMPAIGN_ORDER, STYLE_META, encodedToPhysical } = window.LEMMINGS_DATA;

const STYLE_NAMES = ['Dirt', 'Fire', 'Marble', 'Pillar', 'Crystal'];
const BASE_DIFFICULTIES = ['Fun', 'Tricky', 'Taxing', 'Mayhem'];
const TWO_PLAYER = '2-Player';
const PROJECT_FORMAT = 'LEMMINGS_AMIGA_HTML5_EDITOR_PROJECT';
const PROJECT_FORMAT_VERSION = 1;
const $ = (id) => document.getElementById(id);
const clone = (v) => JSON.parse(JSON.stringify(v));
const clamp = (v, min, max) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
const snap4 = (v) => Math.round(v / 4) * 4;

const canvas = $('levelCanvas');
const ctx = canvas.getContext('2d', { alpha: true });
const workCanvas = document.createElement('canvas');
const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
const files = new Map();
const byteCache = new Map();
const unpackCache = new Map();
const terrainCache = new Map();
const objectCache = new Map();
const specialCache = new Map();

let sourcePhysicalLevels = [];
let physicalLevels = [];
let sourceOddRecords = [];
let oddRecords = [];
let sourceCampaignOrder = null;
let campaignOrder = null;
let sourceDifficultyOrder = [...BASE_DIFFICULTIES];
let difficultyOrder = [...BASE_DIFFICULTIES];
let loaded = false;
let dirty = false;
let currentLevel = null;
let selectedPiece = null;
let dragState = null;
let renderToken = 0;

$('version').textContent = `v${APP_VERSION}`;

function status(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function setDirty(value = true) {
  dirty = value;
  const badge = $('dirtyBadge');
  badge.textContent = !loaded ? 'No project loaded' : dirty ? 'Modified in memory' : 'Project clean';
  badge.className = `dirty-badge ${!loaded ? '' : dirty ? 'dirty' : 'clean'}`;
}

function baseName(path) {
  return path.replace(/\\/g, '/').split('/').pop();
}

function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32be(b, o) { return (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0); }
function i32be(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
function setU16be(b, o, v) { v = clamp(Math.round(Number(v)), 0, 0xffff); b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; }
function setU32be(b, o, v) { v >>>= 0; b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }

async function getBytes(name) {
  if (byteCache.has(name)) return byteCache.get(name);
  const f = files.get(name);
  if (!f) throw new Error(`Missing required file: ${name}`);
  const b = new Uint8Array(await f.arrayBuffer());
  byteCache.set(name, b);
  return b;
}

function byteKillerUnpack(src) {
  let srcPos = src.length - 4;
  let size = u32be(src, srcPos); srcPos -= 4;
  const out = new Uint8Array(size);
  let dst = size - 1;
  let crc = u32be(src, srcPos); srcPos -= 4;
  let bits = u32be(src, srcPos); srcPos -= 4;
  crc = (crc ^ bits) >>> 0;

  const nextBit = () => {
    let carry = bits & 1;
    bits >>>= 1;
    if (bits === 0) {
      if (srcPos < 0) throw new Error('ByteKiller source underrun');
      bits = u32be(src, srcPos); srcPos -= 4;
      crc = (crc ^ bits) >>> 0;
      carry = bits & 1;
      bits = (0x80000000 | (bits >>> 1)) >>> 0;
    }
    return carry;
  };
  const getBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | nextBit();
    return v >>> 0;
  };
  const literal = (bitCount, baseLen) => {
    let count = getBits(bitCount) + baseLen + 1;
    if (count > size) count = size;
    for (let i = 0; i < count; i++) out[dst - i] = getBits(8);
    dst -= count; size -= count;
  };
  const reference = (bitCount, count) => {
    if (count > size) count = size;
    const offset = getBits(bitCount);
    for (let i = 0; i < count; i++) out[dst - i] = out[dst - i + offset];
    dst -= count; size -= count;
  };

  while (size > 0) {
    if (!nextBit()) {
      if (!nextBit()) literal(3, 0);
      else reference(8, 2);
    } else {
      const cmd = getBits(2);
      if (cmd === 3) literal(8, 8);
      else if (cmd === 2) reference(12, getBits(8) + 1);
      else if (cmd === 1) reference(10, 4);
      else reference(9, 3);
    }
  }
  if (crc !== 0) throw new Error(`ByteKiller CRC failed (${crc.toString(16)})`);
  return out;
}

async function unpackFile(name) {
  if (unpackCache.has(name)) return unpackCache.get(name);
  const out = byteKillerUnpack(await getBytes(name));
  unpackCache.set(name, out);
  return out;
}

function decodeTitle(bytes) {
  return new TextDecoder('latin1').decode(bytes).replace(/\0/g, '').trimEnd();
}

function parseLevelRecord(b, off = 0) {
  const props = {
    releaseRate: u16be(b, off), lemmings: u16be(b, off + 2), rescue: u16be(b, off + 4), time: u16be(b, off + 6),
    skills: Array.from({ length: 8 }, (_, i) => u16be(b, off + 8 + i * 2))
  };
  const screenX = u16be(b, off + 0x18);
  const graphicSet = u16be(b, off + 0x1a);
  const specialSet = u16be(b, off + 0x1c);
  const superLemming = u16be(b, off + 0x1e);
  const objects = [];
  for (let i = 0; i < 32; i++) {
    const p = off + 0x20 + i * 8;
    const flags = u16be(b, p + 6);
    if (flags === 0) continue;
    objects.push({ slot: i, x: u16be(b, p) - 16, y: u16be(b, p + 2), id: u16be(b, p + 4), flags });
  }
  const terrain = [];
  for (let i = 0; i < 400; i++) {
    const p = off + 0x120 + i * 4;
    const v = i32be(b, p);
    if (v === -1) continue;
    const x = ((v >>> 16) & 0x0fff) - 16;
    const yy = (v >>> 7) & 0x01ff;
    const y = yy - (yy > 256 ? 516 : 4);
    terrain.push({ slot: i, x, y, id: v & 0x3f, flags: (v >>> 29) & 0x07, raw: v >>> 0 });
  }
  const steel = [];
  for (let i = 0; i < 32; i++) {
    const p = off + 0x760 + i * 4;
    const pos = u16be(b, p), size = b[p + 2], unknown = b[p + 3];
    if ((pos === 0 && size === 0) || unknown !== 0) continue;
    steel.push({ slot: i, x: (pos & 0x1ff) * 4 - 16, y: ((pos >>> 9) & 0x7f) * 4, w: (size & 0x0f) * 4 + 4, h: ((size >>> 4) & 0x0f) * 4 + 4 });
  }
  props.title = decodeTitle(b.slice(off + 0x7e0, off + 0x800));
  return { props, screenX, graphicSet, specialSet, superLemming, objects, terrain, steel };
}

function parseOddRecordFromBytes(b, index) {
  const o = index * 56;
  if (o + 56 > b.length) return null;
  return {
    releaseRate: u16be(b, o), lemmings: u16be(b, o + 2), rescue: u16be(b, o + 4), time: u16be(b, o + 6),
    skills: Array.from({ length: 8 }, (_, i) => u16be(b, o + 8 + i * 2)),
    title: decodeTitle(b.slice(o + 24, o + 56))
  };
}

async function loadPhysicalFromSource(physicalIndex) {
  const pack = Math.floor(physicalIndex / 4), part = physicalIndex % 4;
  const name = `Level${String(pack).padStart(3, '0')}`;
  const b = await unpackFile(name);
  if (b.length !== 8192) throw new Error(`${name}: expected 8192 decrunched bytes, got ${b.length}`);
  return { ...parseLevelRecord(b, part * 2048), physicalIndex, pack, part };
}

function makeDefaultCampaignOrder() {
  const order = {};
  for (const rating of BASE_DIFFICULTIES) {
    order[rating] = CAMPAIGN_ORDER[rating].map((encoded) => ({ physical: encodedToPhysical(encoded), odd: encoded < 0 }));
  }
  order[TWO_PLAYER] = Array.from({ length: 20 }, (_, i) => ({ physical: 80 + i, odd: false }));
  return order;
}

function physicalToEncoded(physical) {
  return Math.floor(physical / 8) * 10 + (physical % 8);
}

function getEntry(rating = $('rating').value, number = Number($('levelNo').value)) {
  return campaignOrder?.[rating]?.[number - 1] || null;
}

function activePropsFor(entry, level) {
  if (entry && entry.odd && entry.physical < 80 && entry.physical !== 0) return oddRecords[entry.physical];
  return level.props;
}

function resolveCurrentLevel() {
  if (!loaded) return null;
  const rating = $('rating').value;
  const number = Number($('levelNo').value);
  const entry = getEntry(rating, number);
  if (!entry) return null;
  const level = physicalLevels[entry.physical];
  if (!level) return null;
  return { ...level, props: activePropsFor(entry, level), baseProps: level.props, rating, number, entry, isRepeat: !!entry.odd };
}

function rgbaPalette(meta) {
  return meta.palette.map(([r, g, b]) => [Math.round(r * 255 / 63), Math.round(g * 255 / 63), Math.round(b * 255 / 63), 255]);
}

async function getTerrainTile(style, id) {
  const key = `${style}:${id}`;
  if (terrainCache.has(key)) return terrainCache.get(key);
  const meta = STYLE_META[style];
  const rec = meta?.terrain.find(r => r[0] === id);
  if (!rec) return null;
  const [, w, h, offset] = rec;
  const data = await unpackFile(`Ground${style + 1}`);
  const planeSize = w * h / 8, stride = w / 8;
  const pal = rgbaPalette(meta);
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let p = 0; p < 4; p++) {
      const q = offset + p * planeSize + y * stride + (x >> 3);
      if (data[q] & (0x80 >> (x & 7))) v |= 1 << p;
    }
    const k = (y * w + x) * 4;
    const c = pal[v] || [255, 0, 255, 255];
    img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = v === 0 ? 0 : 255;
  }
  terrainCache.set(key, img);
  return img;
}

async function getObjectFrame(style, id, frame = 0) {
  const key = `${style}:${id}:${frame}`;
  if (objectCache.has(key)) return objectCache.get(key);
  const meta = STYLE_META[style];
  const rec = meta?.objects.find(r => r[0] === id);
  if (!rec) return null;
  const [, frames, w, h, frameWithMask, offset] = rec;
  frame = ((frame % frames) + frames) % frames;
  const data = await unpackFile(`Objects${style + 1}`);
  const pal = rgbaPalette(meta), planeSize = w * h / 8, stride = w / 8;
  const start = offset + frame * frameWithMask;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let p = 0; p < 4; p++) {
      const q = start + p * planeSize + y * stride + (x >> 3);
      if (data[q] & (0x80 >> (x & 7))) v |= 1 << p;
    }
    const maskQ = start + 4 * planeSize + y * stride + (x >> 3);
    const opaque = (data[maskQ] & (0x80 >> (x & 7))) !== 0;
    const k = (y * w + x) * 4, c = pal[v] || [255, 0, 255, 255];
    img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = opaque ? 255 : 0;
  }
  objectCache.set(key, img);
  return img;
}

function blitImageData(dst, dstW, dstH, src, dx, dy, opts = {}) {
  const flipY = !!opts.flipY, erase = !!opts.erase, noOverwrite = !!opts.noOverwrite;
  for (let sy = 0; sy < src.height; sy++) {
    const ty = dy + (flipY ? (src.height - 1 - sy) : sy);
    if (ty < 0 || ty >= dstH) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const tx = dx + sx; if (tx < 0 || tx >= dstW) continue;
      const si = (sy * src.width + sx) * 4; if (src.data[si + 3] === 0) continue;
      const di = (ty * dstW + tx) * 4;
      if (erase) { dst.data[di + 3] = 0; continue; }
      if (noOverwrite && dst.data[di + 3] !== 0) continue;
      dst.data[di] = src.data[si]; dst.data[di + 1] = src.data[si + 1]; dst.data[di + 2] = src.data[si + 2]; dst.data[di + 3] = src.data[si + 3];
    }
  }
}

function byteRun1(data, expected) {
  const out = new Uint8Array(expected); let si = 0, di = 0;
  while (si < data.length && di < expected) {
    const n = data[si++];
    if (n <= 127) { const c = n + 1; out.set(data.slice(si, si + c), di); si += c; di += c; }
    else if (n >= 129) { const c = 257 - n, v = data[si++]; out.fill(v, di, Math.min(expected, di + c)); di += c; }
  }
  return out;
}

function decodeILBM(bytes) {
  const tag = (o) => String.fromCharCode(...bytes.slice(o, o + 4));
  if (tag(0) !== 'FORM' || tag(8) !== 'ILBM') throw new Error('Special file did not decrunch to ILBM');
  let pos = 12, bmhd = null, cmap = null, body = null;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos), n = u32be(bytes, pos + 4), d = bytes.slice(pos + 8, pos + 8 + n);
    if (id === 'BMHD') bmhd = d; else if (id === 'CMAP') cmap = d; else if (id === 'BODY') body = d;
    pos += 8 + n + (n & 1);
  }
  if (!bmhd || !cmap || !body) throw new Error('ILBM missing BMHD/CMAP/BODY');
  const w = u16be(bmhd, 0), h = u16be(bmhd, 2), planes = bmhd[8], masking = bmhd[9], compression = bmhd[10];
  const rowBytes = ((w + 15) >> 4) << 1, rowsPerLine = planes + (masking === 1 ? 1 : 0), expected = rowBytes * rowsPerLine * h;
  const raw = compression === 1 ? byteRun1(body, expected) : body.slice(0, expected);
  const pal = []; for (let i = 0; i < cmap.length; i += 3) pal.push([cmap[i], cmap[i + 1], cmap[i + 2], 255]);
  const img = new ImageData(w, h); let p = 0;
  for (let y = 0; y < h; y++) {
    const rows = []; for (let plane = 0; plane < rowsPerLine; plane++) { rows.push(raw.slice(p, p + rowBytes)); p += rowBytes; }
    for (let x = 0; x < w; x++) {
      let v = 0; for (let plane = 0; plane < planes; plane++) if (rows[plane][x >> 3] & (0x80 >> (x & 7))) v |= 1 << plane;
      let a = v === 0 ? 0 : 255; if (masking === 1) a = (rows[planes][x >> 3] & (0x80 >> (x & 7))) ? 255 : 0;
      const c = pal[v] || [255, 0, 255, 255], k = (y * w + x) * 4;
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = a;
    }
  }
  return img;
}

async function getSpecial(index) {
  if (specialCache.has(index)) return specialCache.get(index);
  const name = `special${index}`;
  if (!files.has(name)) throw new Error(`Special backdrop ${index + 1} requires ${name}, which is not loaded.`);
  const img = decodeILBM(await unpackFile(name));
  specialCache.set(index, img); return img;
}

function currentEditLayer() {
  return document.querySelector('input[name="editLayer"]:checked')?.value || 'terrain';
}

function itemBounds(level, type, item) {
  if (!item) return null;
  if (type === 'steel') return { x: item.x, y: item.y, w: item.w, h: item.h };
  if (type === 'terrain') {
    const rec = STYLE_META[level.graphicSet]?.terrain.find(r => r[0] === item.id);
    return { x: item.x, y: item.y, w: rec?.[1] || 16, h: rec?.[2] || 16 };
  }
  const rec = STYLE_META[level.graphicSet]?.objects.find(r => r[0] === item.id);
  return { x: item.x, y: item.y, w: rec?.[2] || 16, h: rec?.[3] || 16 };
}

function drawSelection(level) {
  if (!$('showSelection').checked || !selectedPiece || selectedPiece.physical !== level.physicalIndex) return;
  const list = selectedPiece.type === 'terrain' ? level.terrain : selectedPiece.type === 'objects' ? level.objects : level.steel;
  const item = list[selectedPiece.index];
  if (!item) return;
  const b = itemBounds(level, selectedPiece.type, item);
  workCtx.save();
  workCtx.strokeStyle = '#ffd85c';
  workCtx.lineWidth = 1;
  workCtx.setLineDash([3, 2]);
  workCtx.strokeRect(b.x + .5, b.y + .5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
  workCtx.setLineDash([]);
  workCtx.fillStyle = '#ffd85c';
  workCtx.fillRect(b.x - 2, b.y - 2, 5, 5);
  workCtx.restore();
}

async function renderLevel(level) {
  const token = ++renderToken;
  if (!level) return;
  const special = level.specialSet > 0;
  const worldW = special ? 960 : 1600, worldH = 160;
  let world = new ImageData(worldW, worldH);

  if (special) {
    const bg = await getSpecial(level.specialSet - 1);
    if (token !== renderToken) return;
    for (let y = 0; y < Math.min(worldH, bg.height); y++) {
      const srcStart = y * bg.width * 4, dstStart = y * worldW * 4;
      world.data.set(bg.data.slice(srcStart, srcStart + Math.min(worldW, bg.width) * 4), dstStart);
    }
  } else {
    if (level.graphicSet < 0 || level.graphicSet >= STYLE_META.length) throw new Error(`Unsupported graphics set ${level.graphicSet}`);
    for (const t of level.terrain) {
      const tile = await getTerrainTile(level.graphicSet, t.id); if (!tile) continue;
      if (token !== renderToken) return;
      const upside = (t.flags & 2) !== 0, noOverwrite = (t.flags & 4) !== 0, erase = (t.flags & 1) !== 0 && !noOverwrite;
      blitImageData(world, worldW, worldH, tile, t.x, t.y, { flipY: upside, noOverwrite, erase });
    }
  }

  const terrainAlpha = new Uint8Array(worldW * worldH); for (let i = 0; i < terrainAlpha.length; i++) terrainAlpha[i] = world.data[i * 4 + 3];
  if ($('showObjects').checked) {
    for (const o of level.objects) {
      const frame = await getObjectFrame(level.graphicSet, o.id, 0); if (!frame) continue;
      if (token !== renderToken) return;
      const upside = (o.flags & 0x0080) !== 0, noOverwrite = (o.flags & 0x8000) !== 0, onlyOverwrite = (o.flags & 0x4000) !== 0;
      if (onlyOverwrite) {
        const temp = new ImageData(new Uint8ClampedArray(world.data), worldW, worldH);
        blitImageData(temp, worldW, worldH, frame, o.x, o.y, { flipY: upside });
        for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
          const yy = o.y + (upside ? (frame.height - 1 - y) : y), xx = o.x + x;
          if (xx < 0 || yy < 0 || xx >= worldW || yy >= worldH) continue;
          const k = yy * worldW + xx;
          if (!terrainAlpha[k]) { const q = k * 4; temp.data[q] = world.data[q]; temp.data[q + 1] = world.data[q + 1]; temp.data[q + 2] = world.data[q + 2]; temp.data[q + 3] = world.data[q + 3]; }
        }
        world = temp;
      } else blitImageData(world, worldW, worldH, frame, o.x, o.y, { flipY: upside, noOverwrite });
    }
  }

  if (token !== renderToken) return;
  workCanvas.width = worldW; workCanvas.height = worldH;
  workCtx.putImageData(world, 0, 0);
  if ($('showSteel').checked) {
    workCtx.save(); workCtx.fillStyle = 'rgba(0,180,255,.28)'; workCtx.strokeStyle = 'rgba(80,220,255,.9)';
    for (const s of level.steel) { workCtx.fillRect(s.x, s.y, s.w, s.h); workCtx.strokeRect(s.x + .5, s.y + .5, s.w - 1, s.h - 1); }
    workCtx.restore();
  }
  if ($('showTerrainBounds').checked && !special) {
    workCtx.save(); workCtx.strokeStyle = 'rgba(255,255,255,.22)';
    for (const t of level.terrain) { const rec = STYLE_META[level.graphicSet].terrain.find(r => r[0] === t.id); if (rec) workCtx.strokeRect(t.x + .5, t.y + .5, rec[1] - 1, rec[2] - 1); }
    workCtx.restore();
  }
  drawSelection(level);
  canvas.width = worldW; canvas.height = worldH; ctx.imageSmoothingEnabled = false; ctx.drawImage(workCanvas, 0, 0);
  applyZoom();
}

function applyZoom() {
  const z = Number($('zoom').value);
  canvas.style.width = `${canvas.width * z}px`;
  canvas.style.height = `${canvas.height * z}px`;
}

function rebuildRatingOptions(preferred = null) {
  const rating = $('rating');
  const current = preferred || rating.value || difficultyOrder[0];
  rating.innerHTML = [...difficultyOrder, TWO_PLAYER].map(r => `<option>${r}</option>`).join('');
  rating.value = [...difficultyOrder, TWO_PLAYER].includes(current) ? current : difficultyOrder[0];
  $('swapRating').innerHTML = difficultyOrder.map(r => `<option>${r}</option>`).join('');
  if (difficultyOrder.includes(current)) $('swapRating').value = current;
  updateLevelNumberRange();
}

function updateLevelNumberRange() {
  const rating = $('rating').value, max = rating === TWO_PLAYER ? 20 : 30;
  $('levelNo').max = max;
  if (Number($('levelNo').value) > max) $('levelNo').value = max;
}

function propertyObjectForEditor() {
  if (!currentLevel) return null;
  const mode = $('propertySource').value;
  if (mode === 'base') return physicalLevels[currentLevel.physicalIndex].props;
  if (mode === 'odd') return currentLevel.physicalIndex < 80 ? oddRecords[currentLevel.physicalIndex] : null;
  return activePropsFor(currentLevel.entry, physicalLevels[currentLevel.physicalIndex]);
}

function populatePropertyForm() {
  const p = propertyObjectForEditor();
  const oddOption = $('propertySource').querySelector('option[value="odd"]');
  if (oddOption) oddOption.disabled = !currentLevel || currentLevel.physicalIndex >= 80;
  if (!p) {
    $('propTitle').value = '';
    return;
  }
  $('propTitle').value = p.title || '';
  $('propRelease').value = p.releaseRate;
  $('propLemmings').value = p.lemmings;
  $('propRescue').value = p.rescue;
  $('propTime').value = p.time;
  document.querySelectorAll('.skill').forEach(el => { el.value = p.skills[Number(el.dataset.skill)] ?? 0; });
}

function renderInfo(l) {
  const p = l.props;
  $('levelTitle').textContent = `${l.rating} ${String(l.number).padStart(2, '0')} — ${p.title.trim()}`;
  $('levelSource').textContent = `Physical map ${l.physicalIndex} · Level${String(l.pack).padStart(3, '0')} slot ${l.part} · ${l.entry.odd ? 'oddtable properties' : 'base properties'}`;
  const rows = [
    ['Release rate', p.releaseRate], ['Lemmings', p.lemmings], ['To rescue', p.rescue], ['Time', `${p.time} min`],
    ['Skills', p.skills.join(' / ')], ['Graphics set', `${l.graphicSet} (${STYLE_NAMES[l.graphicSet] ?? 'unknown'})`],
    ['Special set', l.specialSet || 'none'], ['Start X', l.screenX], ['Terrain pieces', l.terrain.length], ['Objects', l.objects.length], ['Steel areas', l.steel.length]
  ];
  $('info').innerHTML = rows.map(([a, b]) => `<div class="kv"><span>${a}</span><strong>${b}</strong></div>`).join('');
  $('mapScreenX').value = l.screenX;
  $('mapGraphicSet').value = String(l.graphicSet);
  $('mapSpecialSet').value = String(clamp(l.specialSet, 0, 4));
  $('slotOddOverride').checked = !!l.entry.odd;
  $('slotOddOverride').disabled = l.rating === TWO_PLAYER || l.physicalIndex === 0;
  $('mapNote').innerHTML = l.specialSet > 0
    ? 'This map currently uses a special ILBM backdrop. Terrain-piece entries are retained in the record but are not used by the special-level render path.'
    : 'Geometry edits affect the physical map and therefore every campaign slot that reuses this map. Oddtable changes affect properties/title only.';
}

function renderDifficultyOrder() {
  $('difficultyOrder').innerHTML = difficultyOrder.map((r, i) => `
    <div class="difficulty-chip"><span>${i + 1}. ${r}</span>
      <button type="button" data-group-move="${i}" data-delta="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" data-group-move="${i}" data-delta="1" ${i === difficultyOrder.length - 1 ? 'disabled' : ''}>↓</button>
    </div>`).join('');
  $('difficultyOrder').querySelectorAll('button[data-group-move]').forEach(btn => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.groupMove), j = i + Number(btn.dataset.delta);
    if (j < 0 || j >= difficultyOrder.length) return;
    [difficultyOrder[i], difficultyOrder[j]] = [difficultyOrder[j], difficultyOrder[i]];
    const keep = $('rating').value;
    setDirty(); renderDifficultyOrder(); rebuildRatingOptions(keep); renderCampaignTable();
  }));
}

function titleForEntry(entry) {
  const level = physicalLevels[entry.physical];
  if (!level) return '';
  return activePropsFor(entry, level)?.title || '';
}

function renderCampaignTable() {
  if (!loaded) { $('campaignBody').innerHTML = ''; return; }
  const rating = $('rating').value;
  const rows = campaignOrder[rating] || [];
  const currentNo = Number($('levelNo').value);
  $('campaignBody').innerHTML = rows.map((entry, i) => {
    const level = physicalLevels[entry.physical];
    const title = titleForEntry(entry).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const is2 = rating === TWO_PLAYER;
    return `<tr class="${i + 1 === currentNo ? 'current' : ''}">
      <td>${i + 1}</td>
      <td>${title}</td>
      <td><input class="campaign-physical" data-index="${i}" type="number" min="${is2 ? 80 : 0}" max="${is2 ? 99 : 79}" value="${entry.physical}"></td>
      <td><label><input class="campaign-odd" data-index="${i}" type="checkbox" ${entry.odd ? 'checked' : ''} ${is2 || entry.physical === 0 ? 'disabled' : ''}> oddtable</label></td>
      <td>${level?.specialSet ? `special${level.specialSet - 1}` : '—'}</td>
      <td class="order-buttons"><button data-action="up" data-index="${i}" ${i === 0 ? 'disabled' : ''}>↑</button> <button data-action="down" data-index="${i}" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button></td>
      <td><button data-action="edit" data-index="${i}">Edit</button></td>
    </tr>`;
  }).join('');

  $('campaignBody').querySelectorAll('.campaign-physical').forEach(el => el.addEventListener('change', () => {
    const i = Number(el.dataset.index), entry = campaignOrder[rating][i];
    entry.physical = clamp(Math.round(Number(el.value)), rating === TWO_PLAYER ? 80 : 0, rating === TWO_PLAYER ? 99 : 79);
    if (entry.physical === 0) entry.odd = false;
    setDirty();
    if (i + 1 === Number($('levelNo').value)) refresh(); else renderCampaignTable();
  }));
  $('campaignBody').querySelectorAll('.campaign-odd').forEach(el => el.addEventListener('change', () => {
    const i = Number(el.dataset.index), entry = campaignOrder[rating][i];
    entry.odd = !!el.checked && entry.physical > 0 && entry.physical < 80;
    setDirty();
    if (i + 1 === Number($('levelNo').value)) refresh(); else renderCampaignTable();
  }));
  $('campaignBody').querySelectorAll('button[data-action]').forEach(btn => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.index), action = btn.dataset.action;
    if (action === 'edit') {
      $('levelNo').value = i + 1; refresh(); activateTab('level'); return;
    }
    const j = action === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    setDirty();
    const cur = Number($('levelNo').value) - 1;
    if (cur === i) $('levelNo').value = j + 1; else if (cur === j) $('levelNo').value = i + 1;
    refresh();
  }));
}

function renderPieceList() {
  const layer = currentEditLayer();
  $('pieceListTitle').textContent = layer === 'terrain' ? 'Terrain pieces' : layer === 'objects' ? 'Objects' : 'Steel areas';
  if (!currentLevel) { $('pieceList').innerHTML = ''; return; }
  const list = layer === 'terrain' ? currentLevel.terrain : layer === 'objects' ? currentLevel.objects : currentLevel.steel;
  $('pieceList').innerHTML = list.map((item, i) => {
    const selected = selectedPiece && selectedPiece.physical === currentLevel.physicalIndex && selectedPiece.type === layer && selectedPiece.index === i;
    const summary = layer === 'steel' ? `${item.w}×${item.h}` : `ID ${item.id}`;
    const flagText = layer === 'steel' ? '' : `0x${item.flags.toString(16).toUpperCase().padStart(layer === 'objects' ? 4 : 1, '0')}`;
    return `<button class="piece-row ${selected ? 'selected' : ''}" data-index="${i}" type="button"><span class="kind">${String(item.slot ?? i).padStart(3, '0')}</span><span class="summary">${summary}${flagText ? ` · ${flagText}` : ''}</span><span class="coords">${item.x}, ${item.y}</span></button>`;
  }).join('') || '<div class="note">No entries on this layer.</div>';
  $('pieceList').querySelectorAll('.piece-row').forEach(row => row.addEventListener('click', () => {
    selectedPiece = { type: layer, index: Number(row.dataset.index), physical: currentLevel.physicalIndex };
    renderPieceList(); populatePieceEditor(); renderLevel(currentLevel);
  }));
  $('deletePiece').disabled = !(selectedPiece && selectedPiece.physical === currentLevel.physicalIndex && selectedPiece.type === layer);
}

function getSelectedItem() {
  if (!currentLevel || !selectedPiece || selectedPiece.physical !== currentLevel.physicalIndex) return null;
  const list = selectedPiece.type === 'terrain' ? currentLevel.terrain : selectedPiece.type === 'objects' ? currentLevel.objects : currentLevel.steel;
  return list[selectedPiece.index] || null;
}

function populatePieceEditor() {
  const item = getSelectedItem();
  const layer = selectedPiece?.type || currentEditLayer();
  $('pieceEmpty').classList.toggle('hidden', !!item);
  $('pieceEditor').classList.toggle('hidden', !item);
  if (!item) return;
  const steel = layer === 'steel';
  $('pieceIdLabel').classList.toggle('hidden', steel);
  $('pieceWLabel').classList.toggle('hidden', !steel);
  $('pieceHLabel').classList.toggle('hidden', !steel);
  $('pieceFlagsLabel').classList.toggle('hidden', steel);
  $('terrainFlagControls').classList.toggle('hidden', layer !== 'terrain');
  $('objectFlagControls').classList.toggle('hidden', layer !== 'objects');
  $('pieceX').value = item.x; $('pieceY').value = item.y;
  if (steel) { $('pieceW').value = item.w; $('pieceH').value = item.h; }
  else {
    $('pieceId').value = item.id;
    $('pieceFlags').value = `0x${item.flags.toString(16).toUpperCase().padStart(layer === 'objects' ? 4 : 1, '0')}`;
    if (layer === 'terrain') {
      $('terrainErase').checked = !!(item.flags & 1);
      $('terrainUpside').checked = !!(item.flags & 2);
      $('terrainNoOverwrite').checked = !!(item.flags & 4);
    } else {
      $('objectUpside').checked = !!(item.flags & 0x0080);
      $('objectOnlyOverwrite').checked = !!(item.flags & 0x4000);
      $('objectNoOverwrite').checked = !!(item.flags & 0x8000);
    }
  }
}

function parseFlags(value, fallback = 0) {
  const text = String(value).trim();
  const v = text.toLowerCase().startsWith('0x') ? parseInt(text.slice(2), 16) : parseInt(text, 10);
  return Number.isFinite(v) ? v : fallback;
}

function canvasWorldPoint(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left) * canvas.width / r.width, y: (ev.clientY - r.top) * canvas.height / r.height };
}

function hitTest(level, type, x, y) {
  const list = type === 'terrain' ? level.terrain : type === 'objects' ? level.objects : level.steel;
  for (let i = list.length - 1; i >= 0; i--) {
    const b = itemBounds(level, type, list[i]);
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return i;
  }
  return -1;
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'campaign') renderCampaignTable();
  if (name === 'pieces') { renderPieceList(); populatePieceEditor(); }
}

async function refresh() {
  if (!loaded) return;
  try {
    const next = resolveCurrentLevel();
    if (!next) return;
    currentLevel = next;
    if (!selectedPiece || selectedPiece.physical !== currentLevel.physicalIndex) selectedPiece = null;
    renderInfo(currentLevel);
    populatePropertyForm();
    renderPieceList(); populatePieceEditor(); renderCampaignTable();
    status('Rendering…');
    await renderLevel(currentLevel);
    status(`Rendered ${currentLevel.rating} ${currentLevel.number} from editable project data.`, 'ok');
  } catch (e) {
    console.error(e); status(e.message || String(e), 'error');
  }
}

function readPropertiesFromForm(target) {
  target.title = $('propTitle').value.slice(0, 32);
  target.releaseRate = clamp(Math.round(Number($('propRelease').value)), 0, 0xffff);
  target.lemmings = clamp(Math.round(Number($('propLemmings').value)), 0, 0xffff);
  target.rescue = clamp(Math.round(Number($('propRescue').value)), 0, 0xffff);
  target.time = clamp(Math.round(Number($('propTime').value)), 0, 0xffff);
  target.skills = Array.from(document.querySelectorAll('.skill')).sort((a, b) => Number(a.dataset.skill) - Number(b.dataset.skill)).map(el => clamp(Math.round(Number(el.value)), 0, 0xffff));
}

function writeTitle(target, offset, title, length = 32) {
  const text = String(title || '').slice(0, length);
  for (let i = 0; i < length; i++) target[offset + i] = i < text.length ? (text.charCodeAt(i) & 0xff) : 0x20;
}

function encodeLevelRecord(level) {
  if (level.terrain.length > 400) throw new Error('Level has more than 400 terrain entries.');
  if (level.objects.length > 32) throw new Error('Level has more than 32 object entries.');
  if (level.steel.length > 32) throw new Error('Level has more than 32 steel entries.');
  const out = new Uint8Array(2048);
  out.fill(0xff, 0x120, 0x760);
  const p = level.props;
  setU16be(out, 0x00, p.releaseRate); setU16be(out, 0x02, p.lemmings); setU16be(out, 0x04, p.rescue); setU16be(out, 0x06, p.time);
  for (let i = 0; i < 8; i++) setU16be(out, 0x08 + i * 2, p.skills[i] || 0);
  setU16be(out, 0x18, level.screenX); setU16be(out, 0x1a, level.graphicSet); setU16be(out, 0x1c, level.specialSet); setU16be(out, 0x1e, level.superLemming || 0);
  level.objects.forEach((o, i) => {
    const slot = Number.isInteger(o.slot) && o.slot >= 0 && o.slot < 32 ? o.slot : i;
    const q = 0x20 + slot * 8;
    setU16be(out, q, clamp(Math.round(o.x + 16), 0, 0xffff)); setU16be(out, q + 2, o.y); setU16be(out, q + 4, o.id);
    setU16be(out, q + 6, o.flags || 0x000f);
  });
  level.terrain.forEach((t, i) => {
    const slot = Number.isInteger(t.slot) && t.slot >= 0 && t.slot < 400 ? t.slot : i;
    const q = 0x120 + slot * 4;
    const xs = (Math.round(t.x) + 16) & 0x0fff;
    let yy = Math.round(t.y) >= -4 ? Math.round(t.y) + 4 : Math.round(t.y) + 516;
    yy &= 0x01ff;
    const preserved = (t.raw >>> 0) & 0x10000040; // observed source bits outside the decoded x/y/id/flags fields
    const v = (preserved | ((t.flags & 0x07) << 29) | (xs << 16) | (yy << 7) | (t.id & 0x3f)) >>> 0;
    setU32be(out, q, v);
  });
  level.steel.forEach((s, i) => {
    const slot = Number.isInteger(s.slot) && s.slot >= 0 && s.slot < 32 ? s.slot : i;
    const q = 0x760 + slot * 4;
    const x = clamp(Math.round((snap4(s.x) + 16) / 4), 0, 0x1ff);
    const y = clamp(Math.round(snap4(s.y) / 4), 0, 0x7f);
    const w = clamp(Math.round((snap4(s.w) - 4) / 4), 0, 0x0f);
    const h = clamp(Math.round((snap4(s.h) - 4) / 4), 0, 0x0f);
    setU16be(out, q, ((y & 0x7f) << 9) | (x & 0x1ff));
    out[q + 2] = ((h & 0x0f) << 4) | (w & 0x0f); out[q + 3] = 0;
  });
  writeTitle(out, 0x7e0, p.title, 32);
  return out;
}

function encodeOddtable() {
  const out = new Uint8Array(80 * 56);
  oddRecords.forEach((p, i) => {
    const o = i * 56;
    setU16be(out, o, p.releaseRate); setU16be(out, o + 2, p.lemmings); setU16be(out, o + 4, p.rescue); setU16be(out, o + 6, p.time);
    for (let s = 0; s < 8; s++) setU16be(out, o + 8 + s * 2, p.skills[s] || 0);
    writeTitle(out, o + 24, p.title, 32);
  });
  return out;
}

function downloadBlob(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function projectObject() {
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    appVersion: APP_VERSION,
    difficultyOrder: clone(difficultyOrder),
    campaignOrder: clone(campaignOrder),
    physicalLevels: clone(physicalLevels),
    oddRecords: clone(oddRecords),
    customSpecials: []
  };
}

function saveProject() {
  if (!loaded) return;
  downloadBlob('Lemmings_Amiga_Editor_Project.json', JSON.stringify(projectObject(), null, 2), 'application/json');
  setDirty(false); status('Project JSON saved.', 'ok');
}

function normaliseImportedProject(p) {
  if (!p || p.format !== PROJECT_FORMAT || p.formatVersion !== PROJECT_FORMAT_VERSION) throw new Error('Not a compatible Lemmings Amiga editor project.');
  if (!Array.isArray(p.physicalLevels) || p.physicalLevels.length !== 100) throw new Error('Project must contain 100 physical levels.');
  if (!Array.isArray(p.oddRecords) || p.oddRecords.length !== 80) throw new Error('Project must contain 80 oddtable records.');
  for (const rating of [...BASE_DIFFICULTIES, TWO_PLAYER]) if (!Array.isArray(p.campaignOrder?.[rating]) || p.campaignOrder[rating].length !== (rating === TWO_PLAYER ? 20 : 30)) throw new Error(`Project campaign order for ${rating} is invalid.`);
  return p;
}

function resetAll() {
  if (!loaded) return;
  if (!confirm('Reset every in-memory edit to the data that was loaded from the game folder?')) return;
  physicalLevels = clone(sourcePhysicalLevels); oddRecords = clone(sourceOddRecords); campaignOrder = clone(sourceCampaignOrder); difficultyOrder = clone(sourceDifficultyOrder);
  selectedPiece = null; setDirty(false); rebuildRatingOptions(BASE_DIFFICULTIES[0]); $('levelNo').value = 1; renderDifficultyOrder(); refresh();
  status('All edits reset to loaded source data.', 'ok');
}

function encodedCampaignExport() {
  const out = { difficultyOrder: clone(difficultyOrder), ratings: {}, twoPlayerPhysicalOrder: campaignOrder[TWO_PLAYER].map(e => e.physical) };
  for (const rating of BASE_DIFFICULTIES) {
    out.ratings[rating] = campaignOrder[rating].map(e => {
      const n = physicalToEncoded(e.physical);
      if (e.odd && n === 0) throw new Error('Physical map 0 cannot be represented as a negative signed campaign-order entry.');
      return e.odd ? -n : n;
    });
  }
  return out;
}

async function initialiseFromFolder() {
  const l0 = await unpackFile('Level000'), g1 = await unpackFile('Ground1'), g5 = await unpackFile('Ground5');
  if (l0.length !== 8192 || g1.length !== 30008 || g5.length !== 40840) throw new Error('Unexpected decrunched sizes; this may not be the expected Amiga Lemmings data set.');
  sourcePhysicalLevels = [];
  for (let i = 0; i < 100; i++) {
    if (i % 16 === 0) status(`Decoding level records… ${i}/100`);
    sourcePhysicalLevels.push(await loadPhysicalFromSource(i));
  }
  const odd = await getBytes('oddtable');
  if (odd.length !== 4480) throw new Error(`oddtable: expected 4480 bytes, got ${odd.length}`);
  sourceOddRecords = Array.from({ length: 80 }, (_, i) => parseOddRecordFromBytes(odd, i));
  sourceCampaignOrder = makeDefaultCampaignOrder(); sourceDifficultyOrder = [...BASE_DIFFICULTIES];
  physicalLevels = clone(sourcePhysicalLevels); oddRecords = clone(sourceOddRecords); campaignOrder = clone(sourceCampaignOrder); difficultyOrder = clone(sourceDifficultyOrder);
  loaded = true; setDirty(false); $('saveProject').disabled = false;
  rebuildRatingOptions(BASE_DIFFICULTIES[0]); $('levelNo').value = 1; renderDifficultyOrder();
}

// --- UI events ---------------------------------------------------------

$('dataFolder').addEventListener('change', async (e) => {
  loaded = false; setDirty(false); files.clear(); byteCache.clear(); unpackCache.clear(); terrainCache.clear(); objectCache.clear(); specialCache.clear();
  for (const f of e.target.files) {
    const n = baseName(f.webkitRelativePath || f.name);
    if (n.startsWith('._') || n === '.DS_Store') continue;
    if (!files.has(n)) files.set(n, f);
  }
  const required = [
    ...Array.from({ length: 25 }, (_, i) => `Level${String(i).padStart(3, '0')}`),
    ...Array.from({ length: 5 }, (_, i) => `Ground${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `Objects${i + 1}`),
    'oddtable', ...Array.from({ length: 4 }, (_, i) => `special${i}`)
  ];
  const missing = required.filter(n => !files.has(n));
  if (missing.length) { status(`Folder loaded, but key files are missing: ${missing.join(', ')}`, 'error'); return; }
  status(`Loaded ${files.size} files. Verifying and decoding source data…`);
  try { await initialiseFromFolder(); await refresh(); status('Amiga data loaded. Editor project initialised from source.', 'ok'); }
  catch (err) { console.error(err); status(`Data check failed: ${err.message}`, 'error'); }
});

$('projectFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    if (!loaded) throw new Error('Load the original game-data folder first so the editor has graphics to render.');
    const p = normaliseImportedProject(JSON.parse(await f.text()));
    physicalLevels = clone(p.physicalLevels); oddRecords = clone(p.oddRecords); campaignOrder = clone(p.campaignOrder);
    difficultyOrder = Array.isArray(p.difficultyOrder) && p.difficultyOrder.length === 4 ? clone(p.difficultyOrder) : [...BASE_DIFFICULTIES];
    selectedPiece = null; setDirty(false); rebuildRatingOptions(difficultyOrder[0]); $('levelNo').value = 1; renderDifficultyOrder(); await refresh();
    status(`Imported editor project created with v${p.appVersion || '?'}.`, 'ok');
  } catch (err) { console.error(err); status(err.message, 'error'); }
  e.target.value = '';
});

$('rating').addEventListener('change', () => { updateLevelNumberRange(); $('levelNo').value = 1; selectedPiece = null; refresh(); });
$('levelNo').addEventListener('change', () => { selectedPiece = null; refresh(); });
$('prev').addEventListener('click', () => { const el = $('levelNo'); el.value = Math.max(1, Number(el.value) - 1); selectedPiece = null; refresh(); });
$('next').addEventListener('click', () => { const el = $('levelNo'); el.value = Math.min(Number(el.max), Number(el.value) + 1); selectedPiece = null; refresh(); });
$('zoom').addEventListener('change', applyZoom);
for (const id of ['showObjects', 'showSteel', 'showTerrainBounds', 'showSelection']) $(id).addEventListener('change', () => currentLevel && renderLevel(currentLevel));

document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
document.querySelectorAll('input[name="editLayer"]').forEach(el => el.addEventListener('change', () => { selectedPiece = null; renderPieceList(); populatePieceEditor(); currentLevel && renderLevel(currentLevel); }));
$('propertySource').addEventListener('change', populatePropertyForm);

$('applyProperties').addEventListener('click', () => {
  if (!currentLevel) return;
  const target = propertyObjectForEditor();
  if (!target) { status('This level has no oddtable record.', 'error'); return; }
  readPropertiesFromForm(target); setDirty(); refresh(); status('Properties updated in memory.', 'ok');
});

$('applyMapSettings').addEventListener('click', () => {
  if (!currentLevel) return;
  const level = physicalLevels[currentLevel.physicalIndex];
  level.screenX = clamp(Math.round(Number($('mapScreenX').value)), 0, 0xffff);
  level.graphicSet = clamp(Math.round(Number($('mapGraphicSet').value)), 0, 4);
  level.specialSet = clamp(Math.round(Number($('mapSpecialSet').value)), 0, 4);
  if (currentLevel.rating !== TWO_PLAYER) currentLevel.entry.odd = !!$('slotOddOverride').checked && currentLevel.physicalIndex > 0 && currentLevel.physicalIndex < 80;
  setDirty(); selectedPiece = null; refresh(); status('Physical map settings updated in memory.', 'ok');
});

function updateFlagTextFromChecks() {
  if (!selectedPiece) return;
  let f = parseFlags($('pieceFlags').value, selectedPiece.type === 'objects' ? 0x000f : 0);
  if (selectedPiece.type === 'terrain') {
    f = (f & ~7) | ($('terrainErase').checked ? 1 : 0) | ($('terrainUpside').checked ? 2 : 0) | ($('terrainNoOverwrite').checked ? 4 : 0);
    $('pieceFlags').value = `0x${(f & 0x07).toString(16).toUpperCase()}`;
  } else if (selectedPiece.type === 'objects') {
    f = (f & ~(0x0080 | 0x4000 | 0x8000)) | ($('objectUpside').checked ? 0x0080 : 0) | ($('objectOnlyOverwrite').checked ? 0x4000 : 0) | ($('objectNoOverwrite').checked ? 0x8000 : 0);
    if ((f & 0xffff) === 0) f = 0x000f;
    $('pieceFlags').value = `0x${(f & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
  }
}
for (const id of ['terrainErase', 'terrainUpside', 'terrainNoOverwrite', 'objectUpside', 'objectOnlyOverwrite', 'objectNoOverwrite']) $(id).addEventListener('change', updateFlagTextFromChecks);

$('applyPiece').addEventListener('click', () => {
  const item = getSelectedItem(); if (!item) return;
  const type = selectedPiece.type;
  if (type === 'steel') {
    item.x = snap4(Number($('pieceX').value)); item.y = snap4(Number($('pieceY').value));
    item.w = clamp(snap4(Number($('pieceW').value)), 4, 64); item.h = clamp(snap4(Number($('pieceH').value)), 4, 64);
  } else {
    item.x = Math.round(Number($('pieceX').value)); item.y = Math.round(Number($('pieceY').value));
    item.id = clamp(Math.round(Number($('pieceId').value)), 0, type === 'terrain' ? 63 : 15);
    item.flags = parseFlags($('pieceFlags').value, type === 'objects' ? 0x000f : 0) & (type === 'terrain' ? 0x07 : 0xffff);
    if (type === 'objects' && item.flags === 0) item.flags = 0x000f;
  }
  setDirty(); renderPieceList(); populatePieceEditor(); renderLevel(currentLevel); renderCampaignTable(); status('Item updated in memory.', 'ok');
});

$('addPiece').addEventListener('click', () => {
  if (!currentLevel) return;
  const type = currentEditLayer();
  const list = type === 'terrain' ? currentLevel.terrain : type === 'objects' ? currentLevel.objects : currentLevel.steel;
  const max = type === 'terrain' ? 400 : 32;
  if (list.length >= max) { status(`${type} list is already at its ${max}-entry format limit.`, 'error'); return; }
  const z = Number($('zoom').value), sc = $('canvasScroll');
  const x = Math.round((sc.scrollLeft + sc.clientWidth / 2) / z), y = 80;
  const previous = selectedPiece && selectedPiece.physical === currentLevel.physicalIndex && selectedPiece.type === type ? getSelectedItem() : null;
  const usedSlots = new Set(list.map(v => v.slot).filter(Number.isInteger));
  let slot = 0; while (usedSlots.has(slot) && slot < max) slot++;
  if (type === 'terrain') list.push({ slot, x, y, id: previous?.id ?? 0, flags: previous?.flags ?? 0 });
  else if (type === 'objects') list.push({ slot, x, y, id: previous?.id ?? 0, flags: previous?.flags || 0x000f });
  else list.push({ slot, x: snap4(x), y: snap4(y), w: 32, h: 16 });
  list.sort((a, b) => (a.slot ?? 9999) - (b.slot ?? 9999));
  selectedPiece = { type, index: list.findIndex(v => v.slot === slot), physical: currentLevel.physicalIndex };
  setDirty(); renderPieceList(); populatePieceEditor(); renderLevel(currentLevel); status(`Added ${type === 'objects' ? 'object' : type === 'terrain' ? 'terrain piece' : 'steel area'}.`, 'ok');
});

$('deletePiece').addEventListener('click', () => {
  const item = getSelectedItem(); if (!item) return;
  const type = selectedPiece.type;
  const list = type === 'terrain' ? currentLevel.terrain : type === 'objects' ? currentLevel.objects : currentLevel.steel;
  list.splice(selectedPiece.index, 1); selectedPiece = null; setDirty(); renderPieceList(); populatePieceEditor(); renderLevel(currentLevel); status('Selected item deleted.', 'ok');
});

canvas.addEventListener('pointerdown', (ev) => {
  if (!currentLevel) return;
  const type = currentEditLayer(), p = canvasWorldPoint(ev), i = hitTest(currentLevel, type, p.x, p.y);
  if (i < 0) { selectedPiece = null; renderPieceList(); populatePieceEditor(); renderLevel(currentLevel); return; }
  selectedPiece = { type, index: i, physical: currentLevel.physicalIndex };
  const item = getSelectedItem();
  dragState = { pointerId: ev.pointerId, type, index: i, physical: currentLevel.physicalIndex, dx: p.x - item.x, dy: p.y - item.y, moved: false };
  canvas.setPointerCapture(ev.pointerId); renderPieceList(); populatePieceEditor(); renderLevel(currentLevel);
});

canvas.addEventListener('pointermove', (ev) => {
  if (!dragState || dragState.pointerId !== ev.pointerId || !currentLevel || dragState.physical !== currentLevel.physicalIndex) return;
  const item = getSelectedItem(); if (!item) return;
  const p = canvasWorldPoint(ev);
  let x = p.x - dragState.dx, y = p.y - dragState.dy;
  if (dragState.type === 'steel') { x = snap4(x); y = snap4(y); } else { x = Math.round(x); y = Math.round(y); }
  if (item.x === x && item.y === y) return;
  item.x = x; item.y = y; dragState.moved = true; setDirty(); populatePieceEditor(); renderPieceList(); renderLevel(currentLevel);
});

function endDrag(ev) {
  if (!dragState || dragState.pointerId !== ev.pointerId) return;
  try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
  if (dragState.moved) status('Item moved in memory.', 'ok');
  dragState = null;
}
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);

$('swapSlots').addEventListener('click', () => {
  if (!loaded || $('rating').value === TWO_PLAYER) { status('Cross-group swapping is for the four single-player difficulty groups.', 'error'); return; }
  const aRating = $('rating').value, aIndex = Number($('levelNo').value) - 1;
  const bRating = $('swapRating').value, bIndex = clamp(Number($('swapLevel').value) - 1, 0, 29);
  [campaignOrder[aRating][aIndex], campaignOrder[bRating][bIndex]] = [campaignOrder[bRating][bIndex], campaignOrder[aRating][aIndex]];
  setDirty(); refresh(); status(`Swapped ${aRating} ${aIndex + 1} with ${bRating} ${bIndex + 1}.`, 'ok');
});

$('saveProject').addEventListener('click', saveProject); $('projectSave2').addEventListener('click', saveProject); $('projectReset').addEventListener('click', resetAll);
$('exportRecord').addEventListener('click', () => {
  if (!currentLevel) return;
  const level = physicalLevels[currentLevel.physicalIndex];
  downloadBlob(`physical_${String(level.physicalIndex).padStart(3, '0')}.lvl`, encodeLevelRecord(level));
  status('Exported active uncompressed 2048-byte level record.', 'ok');
});
$('exportPack').addEventListener('click', () => {
  if (!currentLevel) return;
  const pack = Math.floor(currentLevel.physicalIndex / 4), out = new Uint8Array(8192);
  for (let i = 0; i < 4; i++) out.set(encodeLevelRecord(physicalLevels[pack * 4 + i]), i * 2048);
  downloadBlob(`Level${String(pack).padStart(3, '0')}.raw`, out); status('Exported active uncompressed 8192-byte Level pack.', 'ok');
});
$('exportOddtable').addEventListener('click', () => { if (!loaded) return; downloadBlob('oddtable', encodeOddtable()); status('Exported modified 4480-byte oddtable.', 'ok'); });
$('exportOrder').addEventListener('click', () => {
  if (!loaded) return;
  try { downloadBlob('campaign-order.json', JSON.stringify(encodedCampaignExport(), null, 2), 'application/json'); status('Exported campaign-order JSON.', 'ok'); }
  catch (err) { status(err.message, 'error'); }
});

rebuildRatingOptions(BASE_DIFFICULTIES[0]); renderDifficultyOrder(); updateLevelNumberRange(); setDirty(false);
status('Choose the extracted Lemmings data folder to begin.');

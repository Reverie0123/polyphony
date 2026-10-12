// Small QR code encoder: byte mode, error correction level L, versions 1 to 9 (up to 230 bytes). No dependencies.
// Used for the LAN access link so a phone can scan it without the token ever leaving this machine.

const EC_L = { total: [26, 44, 70, 100, 134, 172, 196, 242, 292], ecPerBlock: [7, 10, 15, 20, 26, 18, 20, 24, 30], blocks: [1, 1, 1, 1, 1, 2, 2, 2, 2] };
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]];
const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99 };

// GF(256) tables with the QR polynomial 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}

function ecBytes(data, n) {
  const g = generator(n);
  const res = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    for (let i = 0; i < n; i++) res[i] ^= mul(g[i + 1], factor);
  }
  return res;
}

function bytesOf(text) {
  return [...new TextEncoder().encode(text)];
}

function pickVersion(len) {
  for (let v = 1; v <= 9; v++) {
    const dataCw = EC_L.total[v - 1] - EC_L.ecPerBlock[v - 1] * EC_L.blocks[v - 1];
    if (dataCw - 2 >= len) return v; // mode + length header is 2 bytes for versions under 10
  }
  throw new Error("text too long for this QR encoder");
}

function codewords(text, version) {
  const data = bytesOf(text);
  const dataCw = EC_L.total[version - 1] - EC_L.ecPerBlock[version - 1] * EC_L.blocks[version - 1];
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(data.length, 8);
  for (const b of data) push(b, 8);
  push(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; bytes.length < dataCw; pad = pad === 0xec ? 0x11 : 0xec) bytes.push(pad);
  // Split into blocks, compute EC, interleave.
  const nb = EC_L.blocks[version - 1];
  const per = dataCw / nb;
  const blocks = [];
  for (let i = 0; i < nb; i++) blocks.push(bytes.slice(i * per, (i + 1) * per));
  const ecs = blocks.map((b) => ecBytes(b, EC_L.ecPerBlock[version - 1]));
  const out = [];
  for (let i = 0; i < per; i++) for (const b of blocks) out.push(b[i]);
  for (let i = 0; i < EC_L.ecPerBlock[version - 1]; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

export function qrMatrix(text) {
  const version = pickVersion(bytesOf(text).length);
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = v; fixed[r][c] = true; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r; const cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
  const al = ALIGN[version - 1];
  const last = al.length - 1;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    // Only the three patterns that would sit on a finder are left out; the ones on the timing lines are drawn.
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    const r0 = al[i]; const c0 = al[j];
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(r0 + r, c0 + c, Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0);
  }
  // Reserve format areas (filled after masking) and the dark module.
  for (let i = 0; i < 8; i++) { fixed[8][i < 6 ? i : i + 1] = true; fixed[i < 6 ? i : i + 1][8] = true; fixed[8][size - 1 - i] = true; fixed[size - 1 - i][8] = true; }
  fixed[8][8] = true;
  set(size - 8, 8, 1);
  if (version >= 7) {
    const vi = VERSION_INFO[version];
    for (let i = 0; i < 18; i++) { const bit = (vi >> i) & 1; set(Math.floor(i / 3), size - 11 + (i % 3), bit); set(size - 11 + (i % 3), Math.floor(i / 3), bit); }
  }
  // Place data in the zigzag.
  const cw = codewords(text, version);
  const bits = [];
  for (const b of cw) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let bi = 0;
  const dataPos = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fixed[r][c]) continue;
        m[r][c] = bits[bi++] ?? 0;
        dataPos.push([r, c]);
      }
    }
  }
  // Try all masks, keep the one with the lowest penalty.
  const maskFn = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const applyFormat = (grid, mask) => {
    const f = FORMAT_L[mask];
    const bit = (i) => (f >> i) & 1;
    for (let i = 0; i < 6; i++) grid[8][i] = bit(14 - i);
    grid[8][7] = bit(8); grid[8][8] = bit(7); grid[7][8] = bit(6);
    for (let i = 9; i < 15; i++) grid[14 - i][8] = bit(14 - i);
    // Second copy: bits 0..7 along row 8 from the right edge, bits 8..14 down column 8 above the bottom edge.
    for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) grid[size - 15 + i][8] = bit(i);
    grid[size - 8][8] = 1;
  };
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map((row) => row.slice());
    for (const [r, c] of dataPos) if (maskFn[mask](r, c)) g[r][c] ^= 1;
    applyFormat(g, mask);
    const score = penalty(g, size);
    if (score < bestScore) { bestScore = score; best = g; }
  }
  return best;
}

function penalty(g, n) {
  let s = 0;
  for (let r = 0; r < n; r++) for (let c = 0, run = 1; c < n; c++) { if (c > 0 && g[r][c] === g[r][c - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; }
  for (let c = 0; c < n; c++) for (let r = 0, run = 1; r < n; r++) { if (r > 0 && g[r][c] === g[r - 1][c]) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const v = g[r][c]; if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) s += 3; }
  let dark = 0;
  for (const row of g) for (const v of row) dark += v;
  s += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return s;
}

/** Draws the QR code onto a canvas element. */
export function drawQr(canvas, text, scale = 4) {
  const m = qrMatrix(text);
  const n = m.length;
  const quiet = 4;
  canvas.width = canvas.height = (n + quiet * 2) * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
}

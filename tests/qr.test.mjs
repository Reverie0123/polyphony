import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

// qr.js is a browser module but has no DOM dependency except drawQr; qrMatrix runs in Node.
const { qrMatrix } = await import(pathToFileURL(path.resolve("web/qr.js")).href);

function finderOk(m, r0, c0) {
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const expect = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4) ? 1 : 0;
    if (m[r0 + r][c0 + c] !== expect) return false;
  }
  return true;
}

test("qrMatrix: sizes, finder patterns, timing, dark module for versions 1 to 9", () => {
  for (let v = 1; v <= 9; v++) {
    const len = v === 1 ? 5 : v === 2 ? 20 : v === 3 ? 40 : v === 4 ? 60 : v === 5 ? 90 : v === 6 ? 120 : v === 7 ? 140 : v === 8 ? 170 : 210;
    const m = qrMatrix("x".repeat(len));
    const n = m.length;
    assert.equal(n, v * 4 + 17, `version ${v} size`);
    assert.ok(finderOk(m, 0, 0) && finderOk(m, 0, n - 7) && finderOk(m, n - 7, 0), `version ${v} finders`);
    for (let i = 8; i < n - 8; i++) { assert.equal(m[6][i], i % 2 === 0 ? 1 : 0); assert.equal(m[i][6], i % 2 === 0 ? 1 : 0); }
    assert.equal(m[n - 8][8], 1, "dark module");
  }
  // Structural check for the symbols verified end to end with jsQR during development (versions 1, 4, 6, 7, 8, 9).
  assert.throws(() => qrMatrix("y".repeat(300)), /too long/);
});

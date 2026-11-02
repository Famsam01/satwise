/* Minimal QR code generator (byte mode, error correction level M, versions 1-10).
   Exposes window.NXQR.matrix(text) and window.NXQR.svg(text). No dependencies. */
(function (root) {
  // [ecc codewords per block, [[blockCount, dataCodewordsPerBlock], ...]] for level M
  const EC = {
    1: [10, [[1, 16]]],
    2: [16, [[1, 28]]],
    3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],
    5: [24, [[2, 43]]],
    6: [16, [[4, 27]]],
    7: [18, [[4, 31]]],
    8: [
      22,
      [
        [2, 38],
        [2, 39],
      ],
    ],
    9: [
      22,
      [
        [3, 36],
        [2, 37],
      ],
    ],
    10: [
      26,
      [
        [4, 43],
        [1, 44],
      ],
    ],
  };
  const ALIGN = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };

  // GF(256)
  const EXP = new Array(512),
    LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 256) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }
  function rsEncode(data, n) {
    const gen = rsGen(n);
    const res = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ res[0];
      res.shift();
      res.push(0);
      if (f) for (let i = 0; i < n; i++) res[i] ^= mul(gen[i + 1], f);
    }
    return res;
  }

  function utf8(str) {
    return Array.from(unescape(encodeURIComponent(str)), (c) =>
      c.charCodeAt(0),
    );
  }

  function bch(value, poly, bitsData, bitsTotal) {
    let v = value << (bitsTotal - bitsData);
    const polyLen = poly.toString(2).length;
    for (let i = bitsTotal - 1; i >= polyLen - 1; i--)
      if ((v >> i) & 1) v ^= poly << (i - polyLen + 1);
    return (value << (bitsTotal - bitsData)) | v;
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function build(text) {
    const bytes = utf8(text);
    let ver = 0;
    for (let v = 1; v <= 10; v++) {
      const dataCw = EC[v][1].reduce((s, b) => s + b[0] * b[1], 0);
      const lenBits = v < 10 ? 8 : 16;
      if (4 + lenBits + bytes.length * 8 <= dataCw * 8) {
        ver = v;
        break;
      }
    }
    if (!ver) throw new Error("Text too long for QR");
    const [eccLen, groups] = EC[ver];
    const dataCw = groups.reduce((s, b) => s + b[0] * b[1], 0);

    // bit stream
    const bits = [];
    const put = (val, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    const cap = dataCw * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8)
      cw.push(parseInt(bits.slice(i, i + 8).join(""), 2));

    // split into blocks, add ecc, interleave
    const blocks = [];
    let pos = 0;
    groups.forEach(([count, size]) => {
      for (let i = 0; i < count; i++) {
        const d = cw.slice(pos, pos + size);
        pos += size;
        blocks.push({ d, e: rsEncode(d, eccLen) });
      }
    });
    const out = [];
    const maxD = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxD; i++)
      blocks.forEach((b) => i < b.d.length && out.push(b.d[i]));
    for (let i = 0; i < eccLen; i++) blocks.forEach((b) => out.push(b.e[i]));
    const stream = [];
    out.forEach((b) => put2(b));
    function put2(b) {
      for (let i = 7; i >= 0; i--) stream.push((b >> i) & 1);
    }
    if (ver >= 2 && ver <= 6) for (let i = 0; i < 7; i++) stream.push(0);

    // matrix + function patterns
    const n = 17 + ver * 4;
    const M = Array.from({ length: n }, () => new Array(n).fill(0));
    const F = Array.from({ length: n }, () => new Array(n).fill(false));
    const set = (r, c, v) => {
      if (r >= 0 && r < n && c >= 0 && c < n) {
        M[r][c] = v ? 1 : 0;
        F[r][c] = true;
      }
    };
    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++)
        for (let c = -1; c <= 7; c++) {
          const inb = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          const dark =
            inb &&
            (r === 0 ||
              r === 6 ||
              c === 0 ||
              c === 6 ||
              (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          set(r0 + r, c0 + c, dark);
        }
    };
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);
    const ap = ALIGN[ver];
    ap.forEach((r) =>
      ap.forEach((c) => {
        if (F[r][c]) return; // overlaps a finder
        for (let dr = -2; dr <= 2; dr++)
          for (let dc = -2; dc <= 2; dc++)
            set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }),
    );
    for (let i = 8; i < n - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    // reserve format + dark module
    for (let i = 0; i < 9; i++) {
      F[8][i] = true;
      F[i][8] = true;
    }
    for (let i = 0; i < 8; i++) {
      F[8][n - 1 - i] = true;
      F[n - 1 - i][8] = true;
    }
    set(n - 8, 8, 1);
    if (ver >= 7) {
      const info = bch(ver, 0x1f25, 6, 18);
      for (let i = 0; i < 18; i++) {
        const bit = (info >> i) & 1;
        const a = Math.floor(i / 3),
          b = (i % 3) + n - 11;
        set(a, b, bit);
        set(b, a, bit);
      }
    }

    // place data zig-zag
    const placed = [];
    let idx = 0;
    for (let c = n - 1; c > 0; c -= 2) {
      if (c === 6) c--;
      for (let i = 0; i < n; i++) {
        const r = ((c + 1) & 2) === 0 ? n - 1 - i : i; // direction by column pair
        for (let k = 0; k < 2; k++) {
          const cc = c - k;
          if (!F[r][cc]) {
            M[r][cc] = idx < stream.length ? stream[idx] : 0;
            idx++;
            placed.push([r, cc]);
          }
        }
      }
    }

    // choose best mask by penalty
    const penalty = (g) => {
      let p = 0;
      for (let i = 0; i < n; i++) {
        for (const get of [(a, b) => g[a][b], (a, b) => g[b][a]]) {
          let run = 1;
          for (let j = 1; j < n; j++) {
            if (get(i, j) === get(i, j - 1)) {
              run++;
              if (j === n - 1 && run >= 5) p += run - 2;
            } else {
              if (run >= 5) p += run - 2;
              run = 1;
            }
          }
        }
      }
      for (let r = 0; r < n - 1; r++)
        for (let c = 0; c < n - 1; c++) {
          const v = g[r][c];
          if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1])
            p += 3;
        }
      const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
      const rev = pat.slice().reverse();
      for (let i = 0; i < n; i++)
        for (let j = 0; j <= n - 11; j++)
          for (const pp of [pat, rev]) {
            let h = true,
              v = true;
            for (let k = 0; k < 11; k++) {
              if (g[i][j + k] !== pp[k]) h = false;
              if (g[j + k][i] !== pp[k]) v = false;
            }
            if (h) p += 40;
            if (v) p += 40;
          }
      let dark = 0;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += g[r][c];
      p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
      return p;
    };
    const withMask = (m) => {
      const g = M.map((row) => row.slice());
      placed.forEach(([r, c]) => {
        if (MASKS[m](r, c)) g[r][c] ^= 1;
      });
      // format info: EC level M = 00
      const fmt = bch((0 << 3) | m, 0x537, 5, 15) ^ 0x5412;
      for (let i = 0; i < 15; i++) {
        const bit = (fmt >> i) & 1;
        // around top-left finder
        if (i < 6) g[i][8] = bit;
        else if (i < 8) g[i + 1][8] = bit;
        else if (i === 8) g[8][7] = bit;
        else g[8][14 - i] = bit;
        // split copy
        if (i < 8) g[8][n - 1 - i] = bit;
        else g[n - 15 + i][8] = bit;
      }
      g[n - 8][8] = 1;
      return g;
    };
    let best = null,
      bestP = Infinity;
    for (let m = 0; m < 8; m++) {
      const g = withMask(m);
      const p = penalty(g);
      if (p < bestP) {
        bestP = p;
        best = g;
      }
    }
    return best;
  }

  function svg(text, opts) {
    const o = Object.assign(
      { margin: 2, dark: "#111", light: "#fff" },
      opts || {},
    );
    const m = build(text);
    const n = m.length,
      size = n + o.margin * 2;
    let d = "";
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (m[r][c])
          d += "M" + (c + o.margin) + " " + (r + o.margin) + "h1v1h-1z";
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      size +
      " " +
      size +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="100%" height="100%" fill="' +
      o.light +
      '"/><path d="' +
      d +
      '" fill="' +
      o.dark +
      '"/></svg>'
    );
  }

  root.NXQR = { matrix: build, svg: svg };
  if (typeof module !== "undefined") module.exports = root.NXQR;
})(typeof window !== "undefined" ? window : globalThis);

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView, StyleSheet, DeviceEventEmitter, NativeModules } from 'react-native';
import { FileUtils, PluginCommAPI, PluginDocAPI, PluginFileAPI, PluginManager } from 'sn-plugin-lib';
import { runExport, readSidecar, resolveColor, strokeGeomKey, isHighlightColor } from './exporter';

const RN = NativeModules.CombinedColorPdfRenderer;

// Group bboxes that are within `margin` px of each other (union-find). Returns arrays of
// the ORIGINAL boxes per cluster — so contiguous underlines/highlights/handwriting on
// adjacent lines get consolidated into one entry.
function clusterGroups(boxes: any[], margin: number): any[][] {
  const parent = boxes.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const near = (a: any, b: any) =>
    a.minX - margin <= b.maxX && b.minX - margin <= a.maxX &&
    a.minY - margin <= b.maxY && b.minY - margin <= a.maxY;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (near(boxes[i], boxes[j])) parent[find(i)] = find(j);
  const groups: Record<number, any[]> = {};
  boxes.forEach((b, i) => { const r = find(i); (groups[r] = groups[r] || []).push(b); });
  return Object.values(groups);
}
function unionBox(boxes: any[]) {
  return {
    minX: Math.min(...boxes.map((b) => b.minX)), minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)), maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function settle(p: any) {
  try { return { ok: true, val: await p, err: null as any }; }
  catch (e: any) { return { ok: false, val: null, err: e?.message ?? String(e) }; }
}
function unpack(resp: any) {
  if (resp && typeof resp === 'object' && 'success' in resp) {
    if (resp.success) return { ok: true, val: resp.result, err: null };
    return { ok: false, val: null, err: (resp.error && resp.error.message) || 'success=false' };
  }
  return { ok: true, val: resp, err: null };
}
function baseName(path: string) {
  const last = (path || 'doc').split('/').pop() || 'doc';
  return last.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'doc';
}
async function getEls(page: number, path: string): Promise<any[]> {
  const r = await settle(PluginFileAPI.getElements(page, path));
  const v = unpack(r.val).val;
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.val)) return v.val;
  return [];
}
async function bboxOf(el: any) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  let sx = 0, sy = 0, lmY = 0, rmY = 0;   // centroid + y of leftmost/rightmost point (for ( vs ) shape)
  const polys: number[][] = [];           // contour polygons (device px) — for ink-only rendering
  try {
    const cs = el.contoursSrc;
    const nC = (cs && cs.size) ? await cs.size() : 0;
    for (let ci = 0; ci < nC; ci++) {
      const poly = await cs.get(ci);
      if (Array.isArray(poly)) {
        const flat: number[] = [];
        for (const p of poly) {
          if (p.x < minX) { minX = p.x; lmY = p.y; } if (p.x > maxX) { maxX = p.x; rmY = p.y; }
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
          sx += p.x; sy += p.y; n++;
          flat.push(Math.round(p.x), Math.round(p.y));
        }
        if (flat.length >= 6) polys.push(flat);
      }
    }
  } catch {}
  if (!n) return null;
  return { minX: Math.round(minX), minY: Math.round(minY), maxX: Math.round(maxX), maxY: Math.round(maxY),
    cx: Math.round(sx / n), cy: Math.round(sy / n), lmY: Math.round(lmY), rmY: Math.round(rmY), polys };
}
// Open `(` vs close `)` from the stroke shape: a paren's curve BULGES toward its open
// side, so its extreme point on that side sits near the vertical MIDDLE while the other
// side's extreme sits at a tip. `(` → leftmost point nearest mid; `)` → rightmost nearest
// mid. (validated on real strokes: classified all 6 sides correctly.)
function parenDir(b: any): '(' | ')' {
  const h = Math.max(b.maxY - b.minY, 1);
  const lpos = (b.lmY - b.minY) / h, rpos = (b.rmY - b.minY) / h;
  return Math.abs(lpos - 0.5) < Math.abs(rpos - 0.5) ? '(' : ')';
}
function classify(penType: number, b: any): string {
  const w = b.maxX - b.minX, h = b.maxY - b.minY, asp = w / Math.max(h, 1);
  if (w >= 90 && h >= 90 && asp >= 0.4 && asp <= 2.5) return penType === 11 ? 'drawing' : 'enclosure';  // big loop: HIGHLIGHTER doodle = drawing (ink-only); PEN loop = lasso (text-lift)
  if (penType === 11) return 'highlight';                 // flat marker swipe over text
  if (h <= 25 && asp >= 8) return 'underline';            // wide & short
  return 'ambig';  // other pen strokes — paren OR handwriting; resolved by clustering below
}
const pendingPath = (exportDir: string) => `${exportDir}/docnote_pending.json`;
// Parse a human "specific pages" spec (1-based, e.g. "3-7, 9") → 0-based page indices.
function parseRange(spec: string): number[] {
  const out = new Set<number>();
  for (const part of (spec || '').split(',')) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) { const t = a; a = b; b = t; } for (let i = a; i <= b; i++) if (i > 0) out.add(i - 1); }
    else { const n = parseInt(part.trim(), 10); if (n > 0) out.add(n - 1); }
  }
  return [...out].sort((a, b) => a - b);
}

export default function App() {
  const [lines, setLines] = useState<string[]>(['Doc → Note']);
  const [mode, setMode] = useState<string>('init');
  const [scopeSel, setScopeSel] = useState<string>('all');
  const [rangeText, setRangeText] = useState<string>('');
  const [progress, setProgress] = useState<{ done: number; total: number; label: string }>({ done: 0, total: 0, label: '' });
  const [isEpubDoc, setIsEpubDoc] = useState<boolean>(false);   // EPUB extraction is BETA → show a heads-up
  const ctx = useRef<{ filePath: string; exportDir: string }>({ filePath: '', exportDir: '' });
  const busy = useRef(false);
  const log = (s: string) => setLines((prev) => [...prev, s]);

  // ── PHASE 1: in a DOC → extract annotations (within the chosen scope), save a hand-off file ──
  async function phase1(pdfPath: string, exportDir: string, scope: { kind: string; range?: string }) {
    log(`PHASE 1 — extracting from:\n${pdfPath}`);
    // EPUB (and other non-PDF DOC formats) have NO text layer — PdfBox can't read them, and the SDK
    // only exposes whole-page text without coordinates. So EVERY business rule below is shared
    // (they work on strokes/geometry), but wherever the PDF path LIFTS TEXT we instead crop the
    // region as an IMAGE from the rendered page (which generateDocImage produces for EPUB too).
    const isEpub = !/\.pdf$/i.test(pdfPath);
    log(`docType = ${isEpub ? 'EPUB/DOC (image-crop mode)' : 'PDF (text-lift mode)'}`);
    // Resolve the scope ("what to move to the note") → the page list to scan.
    let pages: number[] = [];
    if (scope.kind === 'current') {
      const cp = unpack(await settle(PluginCommAPI.getCurrentPageNum()).then((x) => x.val)).val;
      pages = [Number(cp) || 0];
    } else if (scope.kind === 'full') {
      const tot = unpack(await settle(PluginDocAPI.getCurrentTotalPages()).then((x) => x.val)).val;
      pages = Array.from({ length: Number(tot) || 0 }, (_, i) => i);
    } else if (scope.kind === 'range') {
      pages = parseRange(scope.range || '');
    } else {  // 'all' or 'new' → annotated pages
      const mp = unpack(await settle(PluginFileAPI.getMarkPages(pdfPath)).then((x) => x.val)).val;
      if (Array.isArray(mp) && mp.length) pages = mp.map((n: any) => Number(n)).sort((a, b) => a - b);
    }
    log(`scope=${scope.kind} pages: [${pages.join(', ')}]`);

    // "New annotations": a per-doc manifest of mark signatures (page+penType+bbox). Marks
    // already seen are skipped; the manifest is updated after every run so "new" = since now.
    const manifestPath = `${exportDir}/.ccp/${baseName(pdfPath)}_seenmarks.json`;
    let seen = new Set<string>();
    try { const mr = (await settle(RN.readFile(manifestPath))).val; if (mr) { const a = JSON.parse(mr); if (Array.isArray(a)) seen = new Set(a); } } catch {}
    const seenNow = new Set<string>(seen);

    // CustomColorPalette colours for the source doc's strokes — used to (a) re-route a MARKER
    // drawn in a PEN colour to the pen path (a coloured marker is writing/brackets, not a
    // highlight) and (b) render doodle drawings in their real colour. allowIndex=true: doc
    // annotation indices are stable (matches the exporter's document path).
    const sidecar = await readSidecar(RN, exportDir, baseName(pdfPath));

    // Render the annotated pages IN COLOR (reuse ExportColorPDF) → per-page colored PNGs,
    // so highlight/handwriting/circle crops keep their CustomColorPalette colors.
    // Colour render via ExportColorPDF (generateDocImage + drawn strokes) — the SAME aligned render
    // ECP uses, for PDF AND EPUB. We crop the annotated regions out of it.
    log('rendering colored pages…');
    const ex = await settle(runExport({ mode: 'annotated', format: 'png', pngMode: 'perPage' }));
    const coloredDir = (ex.ok && ex.val?.path) ? ex.val.path : '';
    if (!coloredDir) log(`color render failed (${ex.err}); crops will be uncolored`);
    const colorPng = (p: number) => coloredDir ? `${coloredDir}/p${String(p + 1).padStart(4, '0')}.png` : '';

    const items: any[] = [];
    const spanReqs: any[] = [];     // reading-order span requests (underlines + parentheses)
    const textReqs: any[] = [];     // plain rect text requests (digest highlights)
    const pageSizes: Record<number, { width: number; height: number }> = {};
    const stamp = Date.now();
    let cropN = 0;
    const addSpan = (page: number, cW: number, cH: number, ox: number, oy: number, cx: number, cy: number, ul = false) => {
      spanReqs.push({ page, canvasW: cW, canvasH: cH, ox, oy, cx, cy, ul }); return spanReqs.length - 1;
    };
    const addText = (page: number, cW: number, cH: number, x: number, y: number, w: number, h: number) => {
      textReqs.push({ page, canvasW: cW, canvasH: cH, x, y, w, h }); return textReqs.length - 1;
    };
    // crop a region from the COLORED page render (fallback: bare PDF render), with a
    // small PAD so edge strokes/letters aren't clipped (cropPng clamps to image bounds).
    const PAD = 26;
    // colored crop (from the annotated render) — for highlights & handwriting (keep the mark).
    // padX/padY default to PAD; highlights pass a TINY padY so the crop hugs the swiped line
    // instead of grabbing slivers of the lines above/below (a text line is only ~34px tall).
    const cropColor = async (p: number, b: any, cW: number, cH: number, padX = PAD, padY = PAD) => {
      const out = `${exportDir}/docnote_crop_${cropN++}_${stamp}.png`;
      const x = b.minX - padX, y = b.minY - padY;
      const w = (b.maxX - b.minX) + 2 * padX, h = (b.maxY - b.minY) + 2 * padY;
      const r = colorPng(p)
        ? await settle(RN.cropPng(colorPng(p), x, y, w, h, out))
        : await settle(RN.cropRegionToPng(pdfPath, p, cW, cH, x, y, w, h, out));
      return r.ok ? out : null;
    };
    // bare crop (from the plain PDF, no annotation strokes) — for circles: capture the
    // CONTENT inside the loop without drawing the circle itself.
    const cropBare = async (p: number, b: any, cW: number, cH: number) => {
      const out = `${exportDir}/docnote_crop_${cropN++}_${stamp}.png`;
      const x = b.minX - PAD, y = b.minY - PAD;
      const w = (b.maxX - b.minX) + 2 * PAD, h = (b.maxY - b.minY) + 2 * PAD;
      const r = await settle(RN.cropRegionToPng(pdfPath, p, cW, cH, x, y, w, h, out));
      return r.ok ? out : null;
    };
    // ink-only render — for handwriting & drawings: draw the pen-stroke contours on a TRANSPARENT
    // canvas so the note shows just the writing, NOT the printed text underneath it.
    const M = 8;   // small margin
    const renderInk = async (b: any, polys: number[][], hex?: string | null, wash = false) => {
      if (!polys || !polys.length) return null;
      const out = `${exportDir}/docnote_crop_${cropN++}_${stamp}.png`;
      const w = (b.maxX - b.minX) + 2 * M, h = (b.maxY - b.minY) + 2 * M;
      const color = hex || '#202020';        // pen ink default = near-black
      const alpha = wash ? 115 : 255;         // highlighter doodle = translucent wash; pen ink = opaque
      const r = await settle(RN.renderStrokesPng(JSON.stringify(polys), b.minX - M, b.minY - M, w, h, out, color, alpha));
      return (r.ok && r.val) ? out : null;
    };
    // PDF lifts the printed TEXT under an annotation (selectable). EPUB has no text layer → crop the
    // annotated REGION as an image instead. Callers pass BOTH the PDF span coords AND the EPUB crop
    // box; returns the item fields to spread in (`spanIdx` for PDF, `image`+`region` for EPUB).
    const liftText = async (p: number, cW: number, cH: number,
      ox: number, oy: number, cx: number, cy: number, box: any, ul = false) => {
      if (!isEpub) return { spanIdx: addSpan(p, cW, cH, ox, oy, cx, cy, ul) } as any;
      // EPUB: SNAP the crop's TOP/BOTTOM to the rendered text-line bands (no clipped letter tops) AND
      // its LEFT/RIGHT to the line's real text extent (no clipped first/last letters). For an UNDERLINE
      // the text is ABOVE the stroke, so probe a band just above box.maxY.
      const { bands } = await pageData(p, cW, cH);
      const dy = pageShift[p] || 0;                          // per-page reflow correction (marks sit low)
      const bx = { minX: box.minX, minY: box.minY + dy, maxX: box.maxX, maxY: box.maxY + dy };
      const probeMinY = ul ? bx.minY - 70 : bx.minY;
      const sn = snapYToBands(bands, probeMinY, ul ? bx.minY : bx.maxY);
      // sn snaps to the overlapping OR nearest text line; it's only null on a page with NO text at
      // all → fall back to the mark's own region so the marked area is still captured (never lost).
      const b = sn ? { ...epubX(sn, bx.minX, bx.maxX), minY: sn.minY, maxY: sn.maxY } : bx;
      return { image: await cropColor(p, b, cW, cH, 8, 4), region: b } as any;
    };
    // The full Y-range of the rendered text-line bands a region overlaps (snap a crop to whole lines).
    // Snap a region to the rendered text lines it overlaps: full Y of those lines AND their text X
    // extent (so a crop never clips letter tops/bottoms OR the first/last letters).
    const snapYToBands = (bands: Band[], minY: number, maxY: number) => {
      if (!bands.length) return null;                       // page has NO detectable text at all
      let ins = bands.filter((bd) => Math.min(bd.bot, maxY) - Math.max(bd.top, minY) > 0);
      if (!ins.length) {
        // The mark didn't land squarely ON a line — reflow shifts text by varying amounts, so rather
        // than LOSE the note, attach it to the NEAREST text line (closest by vertical center).
        const mc = (minY + maxY) / 2;
        const dist = (b: Band) => Math.abs((b.top + b.bot) / 2 - mc);
        ins = [bands.reduce((a, b) => (dist(b) < dist(a) ? b : a))];
      }
      return {
        minY: Math.min(...ins.map((b) => b.top)) - 5, maxY: Math.max(...ins.map((b) => b.bot)) + 5,
        lineLeft: Math.min(...ins.map((b) => b.left)), lineRight: Math.max(...ins.map((b) => b.right)),
      };
    };
    // EPUB crop X: snap to the line's real text extent, but clamp to the marked span + a generous
    // margin so a short mid-line mark doesn't grab the whole line, while edges never clip.
    const epubX = (sn: any, markMinX: number, markMaxX: number) => {
      const lineW = Math.max(1, sn.lineRight - sn.lineLeft), markW = markMaxX - markMinX;
      // If the mark spans most of the line (a title/heading), capture the WHOLE line — a short swipe
      // on big text must not clip the rest of the word (fixes "Hand Le[ttering]"). Otherwise it's a
      // mid-line phrase: keep the mark + a generous margin, clamped to the line's real text edges.
      if (markW >= lineW * 0.5) return { minX: sn.lineLeft - 6, maxX: sn.lineRight + 6 };
      return { minX: Math.max(sn.lineLeft - 6, markMinX - 60), maxX: Math.min(sn.lineRight + 6, markMaxX + 130) };
    };
    // EPUB REFLOW CORRECTION: generateDocImage lays the text out shifted vs where the marks were drawn
    // (the marks land ~1 line low). There's no API to fix it, so we DETECT the per-page vertical shift:
    // the dy (in px) that best lands all the page's text-marks ONTO the detected text-line bands. A page
    // with no shift → 0; a shifted page → whatever aligns them. Applied to every crop on that page.
    const pageShift: Record<number, number> = {};
    const bestShift = (marks: any[], bands: Band[]) => {
      if (!marks.length || !bands.length) return 0;
      let bestDy = 0, bestScore = -1;
      for (let dy = -170; dy <= 30; dy += 3) {
        let score = 0;
        for (const m of marks) {
          const t = m.minY + dy, b = m.maxY + dy;
          let best = 0;
          for (const bd of bands) { const ov = Math.min(b, bd.bot) - Math.max(t, bd.top); if (ov > best) best = ov; }
          score += best;
        }
        if (score > bestScore + 1 || (Math.abs(score - bestScore) <= 1 && Math.abs(dy) < Math.abs(bestDy))) { bestScore = score; bestDy = dy; }
      }
      return bestDy;
    };
    // EPUB crop region for a bracketed/spanned passage: tight between the two anchors when they sit
    // on the SAME line, else a full-width band over the lines (the text wraps across the column).
    const spanRegionBox = (topY: number, botY: number, leftX: number, rightX: number, cW: number) =>
      (botY - topY < 42)
        ? { minX: leftX, minY: topY - 30, maxX: rightX, maxY: botY + 14 }
        : { minX: 92, minY: topY - 30, maxX: cW - 80, maxY: botY + 14 };
    // Per-page text WORDS + derived line BANDS (device px), fetched once. Used to snap a colour
    // crop's edges to the white space BETWEEN lines (vertical) and BETWEEN words (horizontal).
    type Word = { x0: number; x1: number; top: number; bot: number };
    type Band = { top: number; bot: number; left: number; right: number; cy: number };
    const pageCache: Record<number, { words: Word[]; bands: Band[] }> = {};
    const pageData = async (p: number, cW: number, cH: number) => {
      if (isEpub) {   // no PdfBox text layer → recover line BANDS from the rendered page image (dark text rows)
        if (!(p in pageCache)) {
          const r = await settle(RN.textRowsPng(colorPng(p)));
          const flat = (r.ok && Array.isArray(r.val)) ? r.val : [];
          const bands: Band[] = [];
          for (let i = 0; i + 3 < flat.length; i += 4) bands.push({ top: flat[i], bot: flat[i + 1], left: flat[i + 2], right: flat[i + 3], cy: (flat[i] + flat[i + 1]) / 2 });
          pageCache[p] = { words: [], bands };   // words stay empty → no horizontal word-snap for EPUB
        }
        return pageCache[p];
      }
      if (!(p in pageCache)) {
        const r = await settle(RN.pageWords(pdfPath, p, cW, cH));
        const flat = (r.ok && Array.isArray(r.val)) ? r.val : [];
        const words: Word[] = [];
        for (let i = 0; i + 3 < flat.length; i += 4) words.push({ x0: Math.round(flat[i]), x1: Math.round(flat[i + 1]), top: Math.round(flat[i + 2]), bot: Math.round(flat[i + 3]) });
        const bands: Band[] = [];
        for (const w of [...words].sort((a, b) => (a.top + a.bot) - (b.top + b.bot))) {
          const cy = (w.top + w.bot) / 2, last = bands[bands.length - 1];
          if (!last || cy - last.cy > 10) bands.push({ top: w.top, bot: w.bot, cy });
          else { last.top = Math.min(last.top, w.top); last.bot = Math.max(last.bot, w.bot); last.cy = cy; }
        }
        pageCache[p] = { words, bands };
      }
      return pageCache[p];
    };
    // Snap a crop bbox to white-space gaps: top/bottom to the line gaps, left/right to the word
    // gaps of the words the highlight actually covers. Logos/images (no words) keep their x.
    const snapBox = ({ words, bands }: { words: Word[]; bands: Band[] }, b: any) => {
      const pad = (x: any) => ({ minX: x.minX - 12, minY: x.minY - 12, maxX: x.maxX + 12, maxY: x.maxY + 12 });
      if (!bands.length) return pad(b);
      // a line counts only if the swipe covers MOST of it (>40% of band height) — drops a line the
      // swipe merely droops into (the "extra lines" complaint). Fall back to any-overlap for a thin
      // swipe so we never lose the crop.
      let cov = bands.filter((bd) => Math.min(b.maxY, bd.bot) - Math.max(b.minY, bd.top) > 0.4 * (bd.bot - bd.top));
      if (!cov.length) cov = bands.filter((bd) => b.maxY > bd.top && b.minY < bd.bot);
      if (!cov.length) return pad(b);   // no text line here (e.g. SHORTFORM logo) → keep crop + small pad
      const ci = bands.indexOf(cov[0]), cj = bands.indexOf(cov[cov.length - 1]);
      const top = ci > 0 ? Math.round((bands[ci - 1].bot + bands[ci].top) / 2) : bands[ci].top - 8;
      const bot = cj < bands.length - 1 ? Math.round((bands[cj].bot + bands[cj + 1].top) / 2) : bands[cj].bot + 8;
      const ymin = cov[0].top - 4, ymax = cov[cov.length - 1].bot + 4;
      const onLine = words.filter((w) => (w.top + w.bot) / 2 >= ymin && (w.top + w.bot) / 2 <= ymax);
      // a word counts only if the swipe covers MOST of it (>50% of its width) — drops an edge word
      // the swipe merely clips ("overlapping the next word but not the whole word").
      const covW = onLine.filter((w) => (Math.min(b.maxX, w.x1) - Math.max(b.minX, w.x0)) > 0.5 * (w.x1 - w.x0));
      if (!covW.length) return { ...b, minY: top, maxY: bot };   // highlight over a non-text mark → y-snap only
      const lx = Math.min(...covW.map((w) => w.x0)), rx = Math.max(...covW.map((w) => w.x1));
      const prev = onLine.filter((w) => w.x1 <= lx).sort((a, c) => c.x1 - a.x1)[0];
      const next = onLine.filter((w) => w.x0 >= rx).sort((a, c) => a.x0 - c.x0)[0];
      const left = prev ? Math.round((prev.x1 + lx) / 2) : lx - 6;
      const right = next ? Math.round((rx + next.x0) / 2) : rx + 6;
      return { minX: left, minY: top, maxX: right, maxY: bot };
    };
    // For a circle/lasso: the text-lift span should cover only lines MORE THAN HALF inside the
    // loop's bbox — excludes the line the loop merely arcs OVER at top/bottom (the "picked up
    // words before the circle" problem). Returns {oy,cy} = first/last inside line centers.
    const insideSpanY = (bands: Band[], minY: number, maxY: number) => {
      const ins = bands.filter((b) => (Math.min(b.bot, maxY) - Math.max(b.top, minY)) > 0.5 * (b.bot - b.top));
      if (!ins.length) return { oy: minY + 18, cy: maxY - 18 };   // no text lines → fall back to old trim
      return { oy: Math.round((ins[0].top + ins[0].bot) / 2), cy: Math.round((ins[ins.length - 1].top + ins[ins.length - 1].bot) / 2) };
    };

    const dbg: any[] = [];   // diagnostic: every stroke's page/penType/classification/bbox
    let pdone = 0;
    for (const p of pages) {
      setProgress({ done: ++pdone, total: pages.length, label: 'Extracting' });
      const size = unpack(await settle(PluginFileAPI.getPageSize(pdfPath, p)).then((x) => x.val)).val;
      const cW = size?.width || 1404, cH = size?.height || 1872;
      pageSizes[p] = { width: cW, height: cH };
      dbg.push({ pg: p, pt: -99, k: 'pagesize', x0: cW, y0: cH, x1: 0, y1: 0 });   // DIAGNOSTIC: getPageSize frame
      const els = await getEls(p, pdfPath);
      dbg.push({ pg: p, pt: -98, k: `totalEls:${els.length}`, x0: els.length, y0: 0, x1: 0, y1: 0 });   // PROBE: element count getElements returns
      if (p === pages[0]) {   // PROBE: layer structure (once)
        const lyr = unpack(await settle(PluginFileAPI.getLayers(pdfPath, p)).then((x) => x.val)).val;
        dbg.push({ pg: p, pt: -97, k: `layers:${JSON.stringify(lyr).slice(0, 260)}`, x0: 0, y0: 0, x1: 0, y1: 0 });
      }
      const ambig: any[] = [], underlines: any[] = [], highlights: any[] = [], drawings: any[] = [], brackets: any[] = [];
      for (const el of els) {
        if (el.type !== 0 || !el.stroke) {
          let rr: any = null; try { rr = el.textBox?.textRect || el.picture?.rect || null; } catch {}   // PROBE: non-stroke elements
          dbg.push({ pg: p, pt: -96, k: `nonstroke type=${el.type}`, x0: rr?.left || 0, y0: rr?.top || 0, x1: rr?.right || 0, y1: rr?.bottom || 0 });
          try { el.recycle && el.recycle(); } catch {} continue;
        }
        const b = await bboxOf(el);
        const penType = el.stroke.penType;
        let penColor: any; try { penColor = el.stroke.penColor; } catch {}   // DIAGNOSTIC: raw stroke colour
        let colorHex: string | null = null;   // resolved CCP colour (BEFORE recycle — needs points/uuid)
        try { const gk = sidecar.hasGeom ? await strokeGeomKey(el) : ''; colorHex = resolveColor(el, p, sidecar, gk, true).colorHex; } catch {}
        try { el.recycle && el.recycle(); } catch {}
        if (!b) continue;
        const sig = `${p}:${penType}:${b.minX},${b.minY},${b.maxX},${b.maxY}`;
        if (scope.kind === 'new' && seen.has(sig)) continue;   // already extracted on a prior run
        seenNow.add(sig);
        // A MARKER (penType 11) drawn in a PEN colour is writing/brackets, NOT a highlight. A
        // tall-thin one = a one-sided margin BRACKET (lift its text, handled separately so it can't
        // disturb pen parens); any other pen-colour marker is treated as a pen stroke.
        const penColorMarker = penType === 11 && !!colorHex && !isHighlightColor(colorHex);
        const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
        // A tall, thin MARKER stroke (≥80px tall, ≤80px wide, clearly taller than wide) = a one-sided
        // margin BRACKET — detected by SHAPE, since CCP colour doesn't always resolve on heavily-edited
        // pages (the colour test alone misses it). Other pen-colour markers = pen writing.
        let kind = (penType === 11 && bw <= 80 && bh >= 80 && bh > bw) ? 'bracket'
                   : classify(penColorMarker ? 10 : penType, b);
        // EPUB: a highlighter LOOP is the user circling a passage to extract it (a lasso), not a
        // decorative doodle — crop the enclosed content instead of filling the loop.
        if (isEpub && kind === 'drawing') kind = 'enclosure';
        b.colorHex = colorHex;
        dbg.push({ pg: p, pt: penType, k: kind, x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY, cx: b.cx, lmy: b.lmY, rmy: b.rmY, pc: penColor, hex: colorHex, eff: penColorMarker ? 10 : penType });
        if (kind === 'underline') underlines.push(b);
        else if (kind === 'highlight') highlights.push(b);
        else if (kind === 'drawing') drawings.push(b);   // highlighter doodle → ink-only render below
        else if (kind === 'bracket') brackets.push(b);    // pen-colour marker margin bracket → text lift below
        // circle/box = "lift this section into the note". Pull the enclosed SECTION as text
        // (reading order); keep a bare crop as fallback for non-text content (diagrams). The
        // lasso shape itself is never reproduced.
        else if (kind === 'enclosure') {
          if (isEpub) {   // EPUB: no text layer / no bare-PDF render → crop the enclosed region as an image
            items.push({ page: p, y: b.minY, x: b.minX, kind, image: await cropColor(p, b, cW, cH, 10, 10), region: { ...b } });
          } else {
            const eb = (await pageData(p, cW, cH)).bands;
            const { oy, cy } = insideSpanY(eb, b.minY, b.maxY);   // skip the line the loop only arcs over
            items.push({ page: p, y: b.minY, x: b.minX, kind,
              image: await cropBare(p, b, cW, cH),
              spanIdx: addSpan(p, cW, cH, b.minX, oy, b.maxX, cy) });
          }
        }
        else ambig.push(b);   // paren-or-handwriting
      }
      // EPUB: detect this page's reflow shift from how the text-marks line up with the rendered text
      // rows, BEFORE any cropping, so every crop on the page is corrected. (Digests refine it later.)
      if (isEpub) {
        const eb = (await pageData(p, cW, cH)).bands;
        pageShift[p] = bestShift(highlights, eb);   // highlights sit squarely on text → cleanest shift signal
        dbg.push({ pg: p, pt: -92, k: `pageShift dy=${pageShift[p]} (bands=${eb.length})`, x0: 0, y0: 0, x1: 0, y1: 0 });
      }
      // Resolve ambiguous pen strokes: cluster them. A TALL-THIN, isolated cluster is a
      // paren/brace SIDE; a dense / wide cluster is handwriting. (Handwriting verticals
      // were previously mis-read as parens — clustering separates them by neighborhood.)
      const sides: any[] = [];
      for (const g of clusterGroups(ambig, 35)) {
        const u = unionBox(g);
        const cw = u.maxX - u.minX, ch = u.maxY - u.minY;
        if (cw < 25 && ch < 25) continue;   // stray dot/speck (e.g. a 5px pen blip) → skip, not a real mark
        if (cw <= 60 && ch >= 38) {                                               // paren/brace side(s)
          const brk = g.filter((s: any) => (s.maxX - s.minX) <= 30 && (s.maxY - s.minY) >= 38);
          if (brk.length >= 2) {   // a TIGHT (…) whose two brackets merged into one cluster — resolve it directly
            brk.sort((a: any, b: any) => a.minX - b.minX);
            const o = brk[0], c = brk[brk.length - 1];
            const box = spanRegionBox(Math.min(o.minY, c.minY), Math.max(o.maxY, c.maxY), o.maxX, c.minX, cW);
            items.push({ page: p, y: u.minY, x: u.minX, kind: 'paren',
              ...(await liftText(p, cW, cH, o.maxX, (o.minY + o.maxY) / 2, c.minX, (c.minY + c.maxY) / 2, box)) });
            continue;
          }
          const tall = g.reduce((a: any, b: any) => (b.maxY - b.minY) > (a.maxY - a.minY) ? b : a);  // shape from tallest member
          u.dir = parenDir(tall);
          sides.push(u);
        } else if (g.length <= 2 && cw >= 200 && ch >= 90) {
          // ONE big loop spanning a wide band = a LASSO around printed text (too wide for the
          // asp≤2.5 enclosure test). Lift the enclosed text; never reproduce the loop. (A real
          // handwritten note is many strokes → g.length>2 → stays a crop, not mistaken for this.)
          if (isEpub) {   // EPUB: crop the lassoed region as an image (no text layer / no bare-PDF render)
            items.push({ page: p, y: u.minY, x: u.minX, kind: 'enclosure', image: await cropColor(p, u, cW, cH, 10, 10), region: { ...u } });
          } else {
            const { oy, cy } = insideSpanY((await pageData(p, cW, cH)).bands, u.minY, u.maxY);   // skip arc-over lines
            items.push({ page: p, y: u.minY, x: u.minX, kind: 'enclosure',
              image: await cropBare(p, u, cW, cH),
              spanIdx: addSpan(p, cW, cH, u.minX, oy, u.maxX, cy) });
          }
        } else {   // handwriting → ink ONLY (no printed-text background), in the pen's colour; crop fallback if no contours
          const polys = g.flatMap((s: any) => s.polys || []);
          const hex = g.find((s: any) => s.colorHex)?.colorHex || null;
          const ink = await renderInk(u, polys, hex, false);
          items.push({ page: p, y: u.minY, x: u.minX, kind: 'handwriting', image: ink || await cropColor(p, u, cW, cH) });
        }
      }
      // Match sides by SHAPE: classify each as `(` or `)`, then walk them in READING ORDER
      // with a stack — each `)` closes the most recent open `(`. This pairs the correct sides
      // (incl. multi-line parens whose brackets sit on different lines) and uses each side
      // exactly ONCE (so no duplicate extractions), unlike the old geometric guess which both
      // missed wrapping parens and duplicated others. Text is lifted in reading order from the
      // `(` to its `)`. Unmatched sides → crop (never silently dropped).
      // (validated on real strokes: 3 clean parens incl. "…avoidance. It's when you go…")
      // Reading order, but LINE-AWARE: group sides whose centers are within ~half a line, then
      // order by x within the line. (A raw minY sort lets a 1px jitter put a same-line `)` before
      // its `(`, breaking the match — these are tight parens that "look like one squiggle".)
      {
        const byY = [...sides].sort((a, b) => (a.minY + a.maxY) - (b.minY + b.maxY));
        let ln = 0, prev = -1e9;
        for (const s of byY) { const cy = (s.minY + s.maxY) / 2; if (cy - prev > 22) ln++; s._line = ln; prev = cy; }
      }
      sides.sort((a, b) => a._line - b._line || a.minX - b.minX);   // reading order
      const stack: any[] = [];
      // A real parenthetical spans a few lines (measured: legit ≤140px tall). A much taller
      // pairing means a `(`/`)` got matched across the page — usually because handwriting was
      // split into stray bracket-shaped strokes. Cap the vertical span so those don't pair into
      // a giant bogus paren (one such monster = 1655 chars → bloated the note + hung insertion).
      const PAREN_MAX_VSPAN = 300;
      for (const s of sides) {
        if (s.dir === '(') { stack.push(s); continue; }
        const o = stack.pop();                                    // `)` closes the latest open `(`
        if (!o) continue;                                         // unmatched close → cropped below
        if (s.minY - o.minY > PAREN_MAX_VSPAN) { stack.push(o); continue; }  // too tall → keep `(` for a nearer `)`
        const Oc = (o.minY + o.maxY) / 2, Cc = (s.minY + s.maxY) / 2;
        o._used = s._used = true;
        const box = spanRegionBox(Math.min(o.minY, s.minY), Math.max(o.maxY, s.maxY), o.maxX, s.minX, cW);
        items.push({ page: p, y: o.minY, x: Math.min(o.minX, s.minX), kind: 'paren',
          ...(await liftText(p, cW, cH, o.maxX, Oc, s.minX, Cc, box)) });
      }
      for (const s of sides) if (!s._used) {   // unmatched PEN bracket → DROP (a stray lone `(`/`)`).
        // (Pen-colour MARKER brackets are handled separately as margin-bracket text lifts.)
        dbg.push({ pg: p, pt: -95, k: `loneside-dropped dir=${s.dir}`, x0: s.minX, y0: s.minY, x1: s.maxX, y1: s.maxY });
      }
      // One-sided MARGIN BRACKETS (a pen-colour marker drawn as a tall bracket): LIFT the text on the
      // lines they span — a `(` wraps text to its RIGHT, a `)` to its LEFT. Kept out of the pen-paren
      // clustering above so they can't disturb adjacent pen parens. Empty lifts vanish downstream.
      if (brackets.length) {
        const bb = (await pageData(p, cW, cH)).bands;
        for (const bk of brackets) {
          const dir = parenDir(bk);
          const { oy, cy } = insideSpanY(bb, bk.minY, bk.maxY);
          const x0 = dir === ')' ? 90 : bk.maxX;
          const x1 = dir === ')' ? bk.minX : (cW - 90);
          const box = spanRegionBox(bk.minY, bk.maxY, Math.min(x0, x1), Math.max(x0, x1), cW);
          items.push({ page: p, y: bk.minY, x: bk.minX, kind: 'paren', ...(await liftText(p, cW, cH, x0, oy, x1, cy, box)) });
          dbg.push({ pg: p, pt: -94, k: `marker-bracket-lift dir=${dir}`, x0: bk.minX, y0: bk.minY, x1: bk.maxX, y1: bk.maxY });
        }
      }
      // UNDERLINES → cluster contiguous (multi-line) runs, then extract the underlined text
      // in READING ORDER from the start of the run (top line) to its end (bottom line). The
      // text sits just ABOVE the underline; rather than a fixed up-shift (which over/undershoots
      // depending on line spacing), we anchor AT the stroke and pass ul:true so the native snaps
      // to the line just ABOVE the stroke — gap-independent (fixes "self-discipline" line drift).
      // One box per underlined LINE (merge same-line segments), then STITCH consecutive lines
      // that WRAP — upper reaches toward the right margin, lower starts near the left — into a
      // single multi-line underline so the whole underlined sentence is ONE entry.
      const lineRuns = clusterGroups(underlines, 45).map((g: any) => unionBox(g)).sort((a: any, b: any) => a.minY - b.minY);
      const stitched: any[][] = [];
      for (const r of lineRuns) {
        const grp = stitched[stitched.length - 1];
        const prev = grp && grp[grp.length - 1];
        if (prev && r.minY - prev.maxY <= 25 && prev.maxX >= cW * 0.5 && r.minX <= cW * 0.4) grp.push(r);
        else stitched.push([r]);
      }
      for (const grp of stitched) {
        const top = grp[0], bot = grp[grp.length - 1];
        const u = unionBox(grp);
        // EPUB: underlined text sits just ABOVE the stroke → crop a band above it (full-width if the
        // run wraps across lines, else hug the single underlined line).
        const multi = (bot.minY - top.minY) > 30;
        const box = { minX: multi ? 92 : top.minX, minY: top.minY - 62, maxX: multi ? cW - 80 : bot.maxX, maxY: bot.minY + 6 };
        items.push({ page: p, y: u.minY, x: u.minX, kind: 'underline',
          ...(await liftText(p, cW, cH, top.minX, top.minY, bot.maxX, bot.minY, box, true)) });
      }
      // HIGHLIGHTS → cluster ONLY same-line segments (margin 18 < line pitch, so separate lines
      // become separate crops, not one tall block), then SNAP each crop to the white-space gaps:
      // top/bottom between lines, left/right between words. Clean edges, no slivers, no partial
      // words, no neighbour text. Colour preserved (still cut from the coloured render).
      const hlData = await pageData(p, cW, cH);
      for (const g of clusterGroups(highlights, 18)) {
        const u = unionBox(g);
        // STRAY-MARK filter (user: "stray highlights don't have text under them"): a NARROW highlight
        // with no word beneath it is a stray dot/box → drop it. Wide marks (e.g. the SHORTFORM logo,
        // which has no text layer) are kept by the width gate.
        const uw = u.maxX - u.minX, uh = u.maxY - u.minY;
        if (isEpub) {
          // EPUB: no word layer to test "text underneath", so drop a stray box by SHAPE — small and
          // near-square (a real highlight is a wide swipe). Then crop the swipe (snapBox is a no-op).
          if (uw <= 70 && uh <= 70) continue;
        } else {
          const hasText = hlData.words.some((wd: any) => (wd.x0 + wd.x1) / 2 >= u.minX && (wd.x0 + wd.x1) / 2 <= u.maxX && (wd.top + wd.bot) / 2 >= u.minY && (wd.top + wd.bot) / 2 <= u.maxY);
          if (!hasText && uw < 140) continue;
        }
        const us = isEpub ? { ...u, minY: u.minY + (pageShift[p] || 0), maxY: u.maxY + (pageShift[p] || 0) } : u;   // reflow correction
        let cropBox: any;
        if (isEpub) {
          const sn = snapYToBands(hlData.bands, us.minY, us.maxY);   // overlapping OR nearest line; null only if page is textless
          cropBox = sn ? { ...epubX(sn, us.minX, us.maxX), minY: sn.minY, maxY: sn.maxY } : us;
        } else cropBox = snapBox(hlData, us);
        items.push({ page: p, y: u.minY, x: u.minX, kind: 'highlight', image: await cropColor(p, cropBox, cW, cH, 0, 0) });
      }
      // Highlighter DOODLES (big loopy marks, not flat swipes) → ink ONLY, no printed background.
      // Cluster loosely (80px) so a multi-stroke drawing stays one image; crop fallback if no contours.
      for (const g of clusterGroups(drawings, 80)) {
        const u = unionBox(g);
        const polys = g.flatMap((s: any) => s.polys || []);
        const hex = g.find((s: any) => s.colorHex)?.colorHex || null;   // doodle's highlighter colour
        items.push({ page: p, y: u.minY, x: u.minX, kind: 'handwriting', image: await renderInk(u, polys, hex, true) || await cropColor(p, u, cW, cH) });
      }
    }

    // Crops are made → delete the internal colored page-render folder so it doesn't litter
    // EXPORT as a stray PNG "export" when the user only wanted the note (+ later a PDF).
    if (coloredDir) await settle(RN.deletePath(coloredDir));   // crops are made → remove the internal page-render folder

    // DIGESTS: highlighter-tool highlights become Supernote digests (not reachable ink), so
    // getElements never sees them. Read them from the .mark HIGHLIGHTINFO. The device records a
    // highlight as MANY tiny rects (one per pen segment, each its own `time`), so do NOT group by
    // time — cluster the rects SPATIALLY into PASSAGES (same + consecutive lines merge; a skipped
    // line breaks the passage), then pull each passage's text in READING ORDER (same span
    // extractor as parens/underlines). This avoids the fragment/repeat/jumble mess.
    const dr = await settle(RN.extractDigestRects(`${pdfPath}.mark`));
    if (dr.ok && dr.val && dr.val !== '{}') {
      let dmap: any = {};
      try { dmap = JSON.parse(dr.val); } catch {}
      let dcount = 0;
      for (const pgStr of Object.keys(dmap)) {
        const pg = Number(pgStr);
        if (!pages.includes(pg)) continue;                 // respect the chosen scope
        const sz = pageSizes[pg]; if (!sz) continue;
        const entries = Array.isArray(dmap[pgStr]) ? dmap[pgStr] : [];
        const rects: any[] = [];
        for (const e of entries) for (const rn of (e.rnRectList || [])) {
          if (rn.right > rn.left && rn.bottom > rn.top) rects.push({ minX: rn.left, minY: rn.top, maxX: rn.right, maxY: rn.bottom });
        }
        const passages = clusterGroups(rects, 40);          // 40px merges same + consecutive lines
        if (isEpub && !pageShift[pg]) {                      // digest-only pages (e.g. the title) → get the shift from the digests
          const eb = (await pageData(pg, sz.width, sz.height)).bands;
          pageShift[pg] = bestShift(passages.map((g: any) => unionBox(g)), eb);
          dbg.push({ pg, pt: -92, k: `pageShift(digest) dy=${pageShift[pg]}`, x0: 0, y0: 0, x1: 0, y1: 0 });
        }
        for (const g of passages) {
          const topY = Math.min(...g.map((r: any) => r.minY)), botY = Math.max(...g.map((r: any) => r.minY));
          const LT = 16;
          const tops = g.filter((r: any) => r.minY <= topY + LT), bots = g.filter((r: any) => r.minY >= botY - LT);
          const ox = Math.min(...tops.map((r: any) => r.minX)), cx = Math.max(...bots.map((r: any) => r.maxX));
          const oy = tops.reduce((s: number, r: any) => s + (r.minY + r.maxY) / 2, 0) / tops.length;
          const cy = bots.reduce((s: number, r: any) => s + (r.minY + r.maxY) / 2, 0) / bots.length;
          const u = unionBox(g);
          const dsig = `${pg}:D:${u.minX},${u.minY},${u.maxX},${u.maxY}`;   // digests now respect 'new' too
          if (scope.kind === 'new' && seen.has(dsig)) continue;
          seenNow.add(dsig);
          // EPUB: crop the highlighted region as an image (the digest wash is already drawn on the render)
          items.push({ page: pg, y: u.minY, x: u.minX, kind: 'digest', ...(await liftText(pg, sz.width, sz.height, ox, oy, cx, cy, { ...u })) });
          dbg.push({ pg, pt: -1, k: 'digest', x0: u.minX, y0: u.minY, x1: u.maxX, y1: u.maxY });
          dcount++;
        }
      }
      log(`digests (highlighter highlights): +${dcount} passage(s)`);
    }

    if (spanReqs.length) {
      const sr = await settle(RN.extractSpanBatch(pdfPath, JSON.stringify(spanReqs)));
      if (!sr.ok) log(`extractSpanBatch ERR: ${sr.err}`);
      const spans = Array.isArray(sr.val) ? sr.val : [];
      for (const it of items) if (it.spanIdx != null) {
        const sp = spans[it.spanIdx];
        it.text = (sp && typeof sp === 'object' ? sp.text : sp) ?? '';   // span result is {text,bold}
        // Bold ONLY for real HEADERS: Shortform also bolds its key-takeaway SENTENCES, so a bold
        // run only counts as a header if it's short and has no sentence punctuation.
        it.bold = !!(sp && typeof sp === 'object' && sp.bold) && it.text.length <= 50 && !/[.,;]/.test(it.text);
        delete it.spanIdx;
      }
    }
    // drop any digest/paren passage that yielded no text (incl. a lone bracket that wrapped nothing).
    // EPUB items carry an IMAGE (not text), so an image is enough to keep them.
    for (let i = items.length - 1; i >= 0; i--) if ((items[i].kind === 'digest' || items[i].kind === 'paren') && !(items[i].text || '').trim() && !items[i].image) items.splice(i, 1);
    // safety: drop any item that ended up with neither an image nor text (nothing to show).
    for (let i = items.length - 1; i >= 0; i--) if (!items[i].image && !(items[i].text || '').trim()) items.splice(i, 1);
    // enclosure: prefer the lifted TEXT; if the lift came back empty AND there's no image, DROP the
    // item — the lasso-loop crop is just an artifact. (EPUB enclosures keep their region image.)
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'enclosure') { if ((items[i].text || '').trim()) { if (!isEpub) delete items[i].image; } else if (!isEpub || !items[i].image) items.splice(i, 1); }

    // DE-DUPE paren ↔ digest: when the user both highlighted (digest) AND bracketed (paren) the
    // same passage. If one is FULLY contained in the other → keep the longer. If they only
    // PARTIALLY overlap (each has unique words) → STITCH them at the overlap into ONE passage in
    // reading order (no duplication, nothing lost), and drop the digest.
    {
      const sig = (t: string) => (t || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const stitch = (a: string, b: string) => {   // a+b sharing a suffix/prefix run → merged (or null)
        const j = (x: string, y: string) => { for (let k = Math.min(x.length, y.length); k >= 18; k--) if (x.slice(-k).toLowerCase() === y.slice(0, k).toLowerCase()) return x + y.slice(k); return null; };
        return j(a, b) || j(b, a);
      };
      const drop = new Set<number>();
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'paren' || drop.has(i)) continue;
        for (let j = 0; j < items.length; j++) {
          if (items[j].kind !== 'digest' || drop.has(j)) continue;
          const sa = sig(items[i].text), sb = sig(items[j].text);
          if (sa.length < 6 || sb.length < 6) continue;
          if (sb.includes(sa)) { drop.add(i); break; }        // paren ⊂ digest → drop paren (any len ≥6, e.g. "is a fallacy)")
          else if (sa.includes(sb)) { drop.add(j); }          // digest ⊂ paren → drop digest
          else if (sa.length >= 18 && sb.length >= 18) {      // partial overlap → stitch (needs length to avoid false stitches)
            const merged = stitch(items[i].text, items[j].text);
            if (merged) { items[i].text = merged; items[i].y = Math.min(items[i].y, items[j].y); drop.add(j); }
          }
        }
      }
      // paren ⊂ paren: a margin-bracket lift can wrap a passage that's ALSO captured as its own
      // paren → drop the fully-contained (shorter) one, keep the longer lift.
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'paren' || drop.has(i)) continue;
        for (let j = 0; j < items.length; j++) {
          if (j === i || items[j].kind !== 'paren' || drop.has(j)) continue;
          const sa = sig(items[i].text), sb = sig(items[j].text);
          if (sb.length >= 12 && sa.length > sb.length && sa.includes(sb)) drop.add(j);   // j ⊂ i → drop shorter j
        }
      }
      // EPUB region de-dupe: items carry no text (just image crops), so the text rules above can't
      // fire. Instead, when a paren/digest/enclosure crop REGION mostly covers another's (same
      // passage highlighted AND bracketed, or a bracket-lift over a paren), drop the smaller one.
      if (isEpub) {
        const REG = new Set(['paren', 'digest', 'enclosure']);
        const frac = (a: any, b: any) => {   // fraction of b's area covered by a
          const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
          const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
          const areaB = Math.max(1, (b.maxX - b.minX) * (b.maxY - b.minY));
          return (ix * iy) / areaB;
        };
        const area = (r: any) => (r.maxX - r.minX) * (r.maxY - r.minY);
        for (let i = 0; i < items.length; i++) {
          if (!REG.has(items[i].kind) || !items[i].region || drop.has(i)) continue;
          for (let j = 0; j < items.length; j++) {
            if (j === i || !REG.has(items[j].kind) || !items[j].region || drop.has(j)) continue;
            if (items[i].page !== items[j].page) continue;
            if (area(items[i].region) >= area(items[j].region) && frac(items[i].region, items[j].region) >= 0.6) drop.add(j);  // j mostly inside i → drop j
          }
        }
      }
      if (drop.size) { const kept = items.filter((_, idx) => !drop.has(idx)); items.length = 0; items.push(...kept); }
    }

    items.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    // ACCUMULATE the seen-marks (union of prior + this run) so a later "New annotations" run
    // compares against everything ever extracted — not just this run (which would lose history).
    try { await settle(RN.writeFile(manifestPath, JSON.stringify([...new Set([...seen, ...seenNow])]))); } catch {}

    if (scope.kind === 'new' && items.length === 0) {   // 'new' scope found nothing → say so, don't silently produce an empty extract
      log('\nNo NEW annotations since your last run on this doc.');
      log('(Use "All annotations" or "Full document" to re-extract everything.)');
    }
    const payload = { sourceName: baseName(pdfPath), when: new Date().toISOString(), items };
    await settle(RN.writeFile(pendingPath(exportDir), JSON.stringify(payload)));
    await settle(RN.writeFile(`${exportDir}/docnote_debug_${Date.now()}.json`, JSON.stringify(dbg)));   // diagnostic
    log(`\nExtracted ${items.length} items (saved).`);
    log(`NOW: open your "— Extracts" note and tap Doc → Note again to paste.`);
  }

  // ── PHASE 2: in a NOTE → paste the pending extract (builds the note only) ──
  // Color PDF/PNG output is handled separately by ExportColorPDF run on the finished note.
  async function phase2(notePath: string, exportDir: string) {
    log('PHASE 2 — pasting into note…');
    const raw = (await settle(RN.readFile(pendingPath(exportDir)))).val;
    if (!raw) { log('No pending extract found. Run from the annotated PDF first.'); return; }
    let payload: any;
    try { payload = JSON.parse(raw); } catch { log('Pending file unreadable.'); return; }
    const items: any[] = payload.items || [];
    if (!items.length) { log('Pending extract is empty.'); return; }

    // Positioned, paginated layout via insertElements (path+page addressed): each extract
    // is its OWN text box with a gap between (room to hand-add notes later); images are
    // placed in the flow (not auto-stacked); new note pages are added as it fills.
    const sz = unpack(await settle(PluginFileAPI.getPageSize(notePath, 0)).then((x) => x.val)).val;
    const PW = sz?.width || 1404, PH = sz?.height || 1872;
    const LEFT = 130, RIGHT = PW - 90, WIDTH = RIGHT - LEFT;     // bigger left margin (portrait clipping)
    const FONT = 32, LINE = 46, GAP = 70, TOP = 120, BOTTOM = PH - 90;
    const cpl = Math.max(20, Math.floor(WIDTH / (FONT * 0.52)));

    // blank/white template NAME (insertNotePage wants template: string, the name)
    let template = 'style_white';
    const tmpls = unpack(await settle(PluginCommAPI.getNoteSystemTemplates()).then((x) => x.val)).val;
    if (Array.isArray(tmpls) && tmpls.length) {
      const names = tmpls.map((t: any) => t?.name).filter(Boolean);
      template = names.find((n: string) => n === 'style_white') || names.find((n: string) => n === 'style_blank') || names[0] || 'style_white';
    }

    // 1. build the sequence (header + ordered items) and measure image sizes
    const header = `Extracts from "${payload.sourceName}.pdf" · ${(payload.when || '').slice(0, 10)}`;
    const seq: any[] = [{ t: 'text', s: header }];
    for (const it of items) {
      if (it.image) seq.push({ t: 'img', s: it.image });          // highlight / handwriting / circle
      else if (it.text) seq.push({ t: 'text', s: it.kind === 'digest' ? `[D] ${it.text}` : it.text, bold: it.bold });  // [D] tags a digest; bold = header
    }
    for (const item of seq) {
      if (item.t !== 'img') continue;
      const pi = (await settle(RN.pngInfo(item.s))).val || {};
      const iw = pi.width || 600, ih = pi.height || 400;
      const sc = Math.min(1, WIDTH / iw);
      item.iw = Math.round(iw * sc); item.ih = Math.round(ih * sc);
    }

    // 2. layout simulation (pure JS) → assign each item a page + top
    let pg = 0, y = TOP;
    for (const item of seq) {
      const h = item.t === 'text' ? Math.max(1, Math.ceil(item.s.length / cpl)) * LINE + 12 : item.ih;
      if (y + h > BOTTOM && y > TOP) { pg++; y = TOP; }
      item.page = pg; item.top = y; item.h = h;
      y += h + GAP;
    }
    const totalPages = pg + 1;

    // 3. pre-create pages (append after the current last)
    const curPages = unpack(await settle(PluginFileAPI.getNoteTotalPageNum(notePath)).then((x) => x.val)).val || 1;
    for (let p = curPages; p < totalPages; p++) await settle(PluginFileAPI.insertNotePage({ notePath, page: p, template }));

    // 4. build elements, ONE batched insertElements per page (fast)
    let placed = 0, err = 0;
    for (let p = 0; p < totalPages; p++) {
      setProgress({ done: p + 1, total: totalPages, label: 'Building note' });
      const els: any[] = [];
      for (const item of seq.filter((s: any) => s.page === p)) {
        const el = unpack((await settle(PluginCommAPI.createElement(item.t === 'text' ? 500 : 200))).val).val;
        if (!el) { err++; continue; }
        if (item.t === 'text') el.textBox = { textContentFull: item.s, textRect: { left: LEFT, top: item.top, right: RIGHT, bottom: item.top + item.h }, fontSize: FONT, textAlign: 0, textBold: item.bold ? 1 : 0, textFakeBold: item.bold ? 1 : 0 };
        else el.picture = { picturePath: item.s, rect: { left: LEFT, top: item.top, right: LEFT + item.iw, bottom: item.top + item.ih } };
        el.pageNum = p;
        els.push(el);
      }
      if (!els.length) continue;
      const r = await settle(PluginFileAPI.insertElements(notePath, p, els));
      if (r.ok) placed += els.length; else { err++; if (err <= 3) log(`insertElements p${p} ERR: ${r.err}`); }
    }
    log(`placed ${placed} elements into note across ${totalPages} page(s); ${err} errors`);

    // PICTURE MANIFEST: the note bakes pictures to a grayscale raster and DROPS picturePath,
    // so ExportColorPDF can't recover the crops from getElements. Hand it the crop paths +
    // positions directly → it redraws the COLOUR crops over the note export.
    const pics = seq.filter((s: any) => s.t === 'img').map((s: any) => ({ page: s.page, left: LEFT, top: s.top, right: LEFT + s.iw, bottom: s.top + s.ih, path: s.s }));
    await settle(RN.writeFile(`${exportDir}/.ccp/docnote_pictures.json`, JSON.stringify({ notePath, pictures: pics })));

    // Hand-off to ExportColorPDF: write a pass file naming this plugin + the built note, so
    // when ExportColorPDF opens it skips its scope screen and goes straight to PDF/PNG. The
    // `source` lets ExportColorPDF know the request is ours and not misapply it elsewhere.
    const req = { source: 'DocAnnotationsToNote', notePath, noteName: baseName(notePath), scope: 'full', createdAt: new Date().toISOString() };
    await settle(RN.writeFile(`${exportDir}/.ccp/colorpdf_request.json`, JSON.stringify(req)));
    log('Note built. Open ExportColorPDF — it will export THIS note (just choose PDF/PNG → GO).');
    log('(cleanup disabled — pending.json + crops kept for ExportColorPDF)');
  }

  // start: detect context — DOC → ask scope ("what to move to the note") then Phase 1;
  // NOTE → paste the extract (Phase 2).
  async function start() {
    if (busy.current) return;
    busy.current = true;
    setLines(['Doc → Note — working…']);
    try {
      const cur = unpack(await PluginCommAPI.getCurrentFilePath()).val;
      const exportDir = (await FileUtils.getExportPath() || '/storage/emulated/0/EXPORT').replace(/\/+$/, '');
      ctx.current = { filePath: cur, exportDir };
      if (!cur) { log('ERROR: open a PDF (to extract) or your note (to paste).'); busy.current = false; return; }
      if (cur.toLowerCase().endsWith('.note')) { setProgress({ done: 0, total: 0, label: '' }); setMode('busy'); await phase2(cur, exportDir); setMode('done'); busy.current = false; }
      else { setIsEpubDoc(!/\.pdf$/i.test(cur)); busy.current = false; setMode('scope'); }   // DOC → show the scope chooser
    } catch (e: any) { log(`ERROR: ${e?.message ?? String(e)}`); busy.current = false; }
  }

  // run Phase 1 with the chosen scope
  async function runScope() {
    if (busy.current) return;
    busy.current = true; setProgress({ done: 0, total: 0, label: '' }); setMode('busy'); setLines(['Doc → Note — extracting…']);
    try { await phase1(ctx.current.filePath, ctx.current.exportDir, { kind: scopeSel, range: rangeText }); }
    catch (e: any) { log(`ERROR: ${e?.message ?? String(e)}`); }
    setMode('done'); busy.current = false;
  }

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('docAnnotRun', () => { setMode('init'); start(); });
    start();
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const radioRow = (value: string, label: string, desc?: string) => (
    <TouchableOpacity key={value} style={styles.row} activeOpacity={0.7} onPress={() => setScopeSel(value)}>
      <View style={styles.radio}>{scopeSel === value ? <View style={styles.radioDot} /> : null}</View>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {desc ? <Text style={styles.rowDesc}>{desc}</Text> : null}
      </View>
    </TouchableOpacity>
  );

  // Progress splash — same look & feel as ExportColorPDF's "Exporting…" screen.
  if (mode === 'busy') {
    return (
      <View style={styles.splash}>
        <Text style={styles.splashTitle}>Doc Annotations to Note</Text>
        <Text style={styles.splashSub}>
          {progress.total ? `${progress.label} — page ${progress.done} of ${progress.total}` : 'Preparing…'}
        </Text>
        <Text style={styles.splashNote}>Please keep this open until it finishes.</Text>
      </View>
    );
  }

  // Scope chooser — same grouped-radio look & feel as ExportColorPDF's "what to export".
  if (mode === 'scope') {
    const validRange = /^[\d]+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(rangeText.trim());
    const canGo = scopeSel !== 'range' || validRange;
    return (
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.scrollBody} keyboardShouldPersistTaps="handled">
          <Text style={styles.chooserTitle}>What do you want to move to the note?</Text>

          {isEpubDoc ? (
            <View style={styles.betaBanner}>
              <Text style={styles.betaText}>⚠ EPUB extraction is experimental (Beta). PDF works well; on EPUB the marked text may land a line off or come through as an image. Feedback welcome.</Text>
            </View>
          ) : null}

          <Text style={styles.group}>Pages</Text>
          {radioRow('current', 'Current page', "Just the page you're viewing now.")}
          <View style={styles.row}>
            <TouchableOpacity style={styles.radio} activeOpacity={0.7} onPress={() => setScopeSel('range')}>
              {scopeSel === 'range' ? <View style={styles.radioDot} /> : null}
            </TouchableOpacity>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel} onPress={() => setScopeSel('range')}>Specific pages</Text>
              <TextInput
                style={[styles.specInput, scopeSel === 'range' && styles.specInputActive]}
                value={rangeText}
                onChangeText={(t) => { setRangeText(t); setScopeSel('range'); }}
                onFocus={() => setScopeSel('range')}
                placeholder="e.g. 5 or 3-10"
                placeholderTextColor="#999999"
                autoCorrect={false}
              />
            </View>
          </View>

          <Text style={styles.group}>Annotated</Text>
          {radioRow('all', 'All annotations', "Every page you've marked up.")}
          {radioRow('new', 'New annotations', 'Marks added since your last run on this doc.')}

          <Text style={styles.group}>Whole document</Text>
          {radioRow('full', 'All pages', 'Scan every page, marked or not.')}

          <TouchableOpacity
            style={[styles.exportBtn, !canGo && styles.exportBtnOff]}
            activeOpacity={0.6}
            disabled={!canGo}
            onPress={() => runScope()}>
            <Text style={styles.exportT}>Extract → Note</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancel} activeOpacity={0.6} onPress={() => PluginManager.closePluginView()}>
            <Text style={styles.cancelT}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Doc Annotations to Note</Text>
      <ScrollView style={styles.log}>
        {lines.map((l, i) => <Text key={i} style={styles.line}>{l}</Text>)}
      </ScrollView>
      <TouchableOpacity style={styles.btn} onPress={() => { setMode('init'); start(); }}><Text style={styles.btnText}>Run again</Text></TouchableOpacity>
      <TouchableOpacity style={styles.btn} onPress={() => PluginManager.closePluginView()}><Text style={styles.btnText}>Close</Text></TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // log / result view
  root: { flex: 1, padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: 'bold', marginBottom: 12 },
  log: { flex: 1, borderWidth: 1, borderColor: '#000', padding: 12, marginBottom: 12 },
  line: { fontSize: 17, marginBottom: 4, fontFamily: 'monospace' },
  btn: { borderWidth: 2, borderColor: '#000', paddingVertical: 12, alignItems: 'center', marginBottom: 8 },
  btnText: { fontSize: 22, fontWeight: 'bold' },

  // progress splash — matches ExportColorPDF's running screen
  splash:      { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', padding: 40 },
  splashTitle: { fontSize: 30, fontWeight: '700', color: '#000000', marginBottom: 12, textAlign: 'center' },
  splashSub:   { fontSize: 18, color: '#222222', marginBottom: 28, textAlign: 'center' },
  splashNote:  { fontSize: 15, color: '#666666', marginTop: 16, textAlign: 'center' },

  // scope chooser — matches ExportColorPDF's grouped-radio chooser
  screen:       { flex: 1, backgroundColor: '#FFFFFF' },
  scrollBody:   { paddingHorizontal: 70, paddingTop: 56, paddingBottom: 90 },
  chooserTitle: { fontSize: 30, fontWeight: '700', color: '#000000', marginBottom: 12, textAlign: 'center' },
  betaBanner:   { borderWidth: 2, borderColor: '#000000', borderRadius: 8, padding: 12, marginBottom: 8 },
  betaText:     { fontSize: 17, color: '#000000', lineHeight: 23 },
  group:        { fontSize: 21, fontWeight: '700', color: '#000000', marginTop: 26, marginBottom: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#000000' },
  row:          { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 13 },
  radio:        { width: 34, height: 34, borderRadius: 17, borderWidth: 3, borderColor: '#000000', marginRight: 16, marginTop: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot:     { width: 16, height: 16, borderRadius: 8, backgroundColor: '#000000' },
  rowText:      { flex: 1 },
  rowLabel:     { fontSize: 22, fontWeight: '600', color: '#000000' },
  rowDesc:      { fontSize: 14, color: '#555555', marginTop: 3 },
  specInput:    { borderWidth: 2, borderColor: '#AAAAAA', borderRadius: 8, paddingVertical: 9, paddingHorizontal: 16, fontSize: 22, color: '#000000', marginTop: 8, alignSelf: 'flex-start', minWidth: 300 },
  specInputActive: { borderColor: '#000000' },
  exportBtn:    { marginTop: 36, alignSelf: 'center', backgroundColor: '#000000', borderRadius: 10, paddingVertical: 16, paddingHorizontal: 48, minWidth: 320, alignItems: 'center' },
  exportBtnOff: { backgroundColor: '#BBBBBB' },
  exportT:      { fontSize: 24, fontWeight: '700', color: '#FFFFFF' },
  cancel:       { marginTop: 22, paddingVertical: 10, paddingHorizontal: 20, alignSelf: 'center' },
  cancelT:      { fontSize: 16, color: '#777777' },
});

import { NativeModules } from 'react-native';
import {
  FileUtils,
  PluginCommAPI,
  PluginDocAPI,
  PluginFileAPI,
  PluginManager,
  PluginNoteAPI,
  PointUtils,
} from 'sn-plugin-lib';

// ─── Tunables ─────────────────────────────────────────────────────────────────
const MAX_PAGES = 0;                 // 'full' mode: 0 = every page

// The six highlighter colours (CustomColorPalette "Highlighter …" entries).
// Wash-vs-opaque is colour-driven: a highlighter colour on a wash-capable pen →
// translucent wash; any other colour → opaque.
const HIGHLIGHTER_HEXES = new Set(
  // All 8 highlighters in the same order as CCP App.tsx HIGHLIGHT_COLORS: Lt/Dk
  // Grey (which reuse the grey ink hexes — listed so RESIZED grey markers wash
  // too) then the 6 colours. This is a Set, so only the VALUES matter for
  // matching; the order is purely for readability against App.tsx.
  ['#C9C9C9', '#9D9D9D', '#FF6FB8', '#FF9A3D', '#FFD400', '#5FD0A0', '#5BB0EE', '#A77DEA'],
);
export function isHighlightColor(hex) { return !!hex && HIGHLIGHTER_HEXES.has(hex.toUpperCase()); }

// DIGEST highlights: highlighter-tool highlights become Supernote digests (not ink), stored in the
// `.mark` HIGHLIGHTINFO block — invisible to getElements. We read those rects and draw a colour wash
// over each on the page render (so DocAnnotationsToNote can crop the COLOURED highlight on EPUB).
const DIGEST_COLORS = { 0: '#FFE600', 1: '#FF6FB8', 2: '#5FD0A0', 3: '#5BB0EE', 4: '#FF9A3D', 5: '#A77DEA' };
async function readDigestRects(renderer, markPath) {
  try {
    const raw = await settle(renderer.extractDigestRects(markPath));
    if (!raw.ok || !raw.val || raw.val === '{}') return {};
    const obj = JSON.parse(raw.val);
    const out = {};   // page index → [{left,top,right,bottom,color}]
    for (const k of Object.keys(obj)) {
      const arr = [];
      for (const e of (obj[k] || [])) {
        const color = DIGEST_COLORS[e.colorType] || '#FFD400';
        for (const rn of (e.rnRectList || [])) {
          if (rn.right > rn.left && rn.bottom > rn.top) arr.push({ left: rn.left, top: rn.top, right: rn.right, bottom: rn.bottom, color });
        }
      }
      if (arr.length) out[Number(k)] = arr;
    }
    return out;
  } catch { return {}; }
}

// Wash-capable pens: the marker (penType 11). Pen(10)/calligraphy(15)/ink(16)
// always render opaque. See [[exportcolorpdf-plugin]].
const WASH_PEN_TYPES = new Set([11 /* marker */]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveBaseName(notePath) {
  const last  = notePath.split('/').pop() || 'doc';
  const noExt = last.replace(/\.[^.]+$/, '');
  return noExt.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'doc';
}
function isArgbColor(penColor) { return penColor > 255 || penColor < 0; }
// Native (non-plugin) greyscale pens store penColor as a 0-255 grayscale level.
// On DOCS the base render has no ink, so an uncoloured native stroke must be
// drawn in its own grey — otherwise light/dark grey come out solid black. Map the
// level straight to an RGB grey; out-of-range (shouldn't happen here) → black.
function greyFromPenColor(pc) {
  if (typeof pc === 'number' && pc >= 0 && pc <= 255) {
    const h = (pc & 0xFF).toString(16).padStart(2, '0');
    return `#${h}${h}${h}`;
  }
  return '#000000';
}
function argbToHex(argb) {
  const u = argb >>> 0;
  const r = (u >> 16) & 0xFF, g = (u >> 8) & 0xFF, b = u & 0xFF;
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
async function settle(promise) {
  try { return { ok: true, val: await promise, err: null }; }
  catch (e) { return { ok: false, val: null, err: e instanceof Error ? e.message : String(e) }; }
}
function unpack(resp) {
  if (resp && typeof resp === 'object' && 'success' in resp) {
    if (resp.success) return { ok: true, val: resp.result, err: null };
    return { ok: false, val: null, err: (resp.error && resp.error.message) || 'success=false' };
  }
  return { ok: true, val: resp, err: null };
}

// Geometry fingerprint of a stroke — a DURABLE colour key that survives note
// editing (reorder/insert of OTHER strokes) where numInPage drifts and the uuid
// is re-minted. MUST be computed byte-identically to CustomColorPalette's
// _strokeGeomKey (index.js) — keep the two in sync. Read async (only a few reads).
export async function strokeGeomKey(el) {
  // Durable per-stroke key. The old 5-point version COLLIDED for short strokes
  // (single letters) → colours bled between strokes. Strengthened: native pen
  // identity (penColor+penType) + point count + up to 9 evenly-spaced sample
  // points + the real bbox of those points. Two distinct strokes (different pen,
  // length, position OR size) can no longer share a key. We deliberately do NOT
  // use el.maxX/maxY — for document annotations those are the PAGE bounds
  // (15819,11864 EMR), constant. MUST match CCP _strokeGeomKey byte-for-byte.
  const st = el.stroke || {};
  const pc = st.penColor ?? 0, pt = st.penType ?? 0;
  const pts = st.points;
  let n = 0;
  try { n = (pts && pts.size) ? await pts.size() : 0; } catch {}
  if (n <= 0) return `${pc}_${pt}|0`;
  const STEPS = Math.min(9, n);
  const idxs = [];
  for (let k = 0; k < STEPS; k++) idxs.push(Math.round(k * (n - 1) / (STEPS - 1 || 1)));
  const coords = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let last = -1;
  for (const i of idxs) {
    if (i === last) continue; last = i;
    try {
      const p = await pts.get(i);
      if (p) {
        const x = Math.round(p.x), y = Math.round(p.y);
        coords.push(`${x},${y}`);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    } catch {}
  }
  return `${pc}_${pt}|${n}|${coords.join(';')}|${minX},${minY},${maxX},${maxY}`;
}

// CustomColorPalette sidecar: {export}/.ccp/{base}_colors.json → {byGeom,byUuid,byIndex,penPrefs}.
export async function readSidecar(renderer, exportDir, baseName) {
  const out = { byIndex: {}, byUuid: {}, byGeom: {}, penPrefs: { pen: null, high: null } };
  try {
    const raw = await renderer.readFile(`${exportDir.replace(/\/+$/,'')}/.ccp/${baseName}_colors.json`);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.byUuid)  out.byUuid  = d.byUuid;
      if (d.byIndex) out.byIndex = d.byIndex;
      if (d.byGeom)  out.byGeom  = d.byGeom;
      if (d.penPrefs?.pen)  out.penPrefs.pen  = d.penPrefs.pen;
      if (d.penPrefs?.high) out.penPrefs.high = d.penPrefs.high;
    }
  } catch {}
  // Geom-era sidecar? If so, byIndex resolution is gated (see resolveColor).
  out.hasGeom = Object.keys(out.byGeom).length > 0;
  return out;
}

// Per-book export-state snapshot for the "new annotations" mode.
// Export state is per-FORMAT: "new annotations" since the last PDF export and
// since the last PNG export are tracked independently, so exporting one format
// never consumes the other's "new" pages.
function exportStatePath(exportDir, baseName, format) {
  return `${exportDir.replace(/\/+$/,'')}/.ccp/${baseName}_exportstate_${format}.json`;
}
async function readExportState(renderer, exportDir, baseName, format) {
  const out = { lastExport: 0, pages: {} };
  try {
    const raw = await renderer.readFile(exportStatePath(exportDir, baseName, format));
    if (raw) {
      const d = JSON.parse(raw);
      if (typeof d.lastExport === 'number') out.lastExport = d.lastExport;
      if (d.pages && typeof d.pages === 'object') out.pages = d.pages;
    }
  } catch {}
  return out;
}
async function writeExportState(renderer, exportDir, baseName, format, state) {
  try { await renderer.writeFile(exportStatePath(exportDir, baseName, format), JSON.stringify(state)); } catch {}
}
async function pageElementCount(notePath, page) {
  const r = unpack(await settle(PluginFileAPI.getElementCounts(notePath, page)).then(x => x.val)).val;
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object') { let s = 0; for (const v of Object.values(r)) if (typeof v === 'number') s += v; return s; }
  return 0;
}

// ─── Per-stroke colour resolution (shared by all document types) ──────────────
// geomKey is the durable geometry fingerprint — tried FIRST so colours survive note
// editing (it's unique per stroke and immune to stale sidecar entries). It CANNOT
// match across an orientation change, though: the device re-projects stroke geometry
// non-rigidly when the screen is rotated, so the coordinates (and even the normalised
// shape) differ between record-time and export-time. numInPage ordering DOES survive
// that, so byIndex is the orientation fallback.
//
// allowIndex re-opens the byIndex fallback on a geom-era sidecar. It's normally gated
// because byIndex maps by position and would bleed a colour onto an uncoloured stroke
// when a NOTE reflows its indices on a structural edit. buildDocShapes enables it for
// (a) a whole-page geom shift, or (b) any DOCUMENT page — doc annotation indices are
// stable (erased strokes leave gaps, indices aren't reused), so byIndex reliably
// recovers rotated strokes even on a page that mixes portrait + rotated annotations.
export function resolveColor(el, page, sidecar, geomKey, allowIndex = false) {
  const stroke = el.stroke || {};
  const penColor = stroke.penColor ?? 0;
  const penType  = stroke.penType  ?? 1;
  const uuid     = el.uuid ?? '';
  const idxKey   = `${page}_${el.numInPage}`;
  // Resolution order: geometry (durable + unique) → uuid (usually dead) → byIndex
  // (gated) → ARGB.
  const gC = (geomKey && sidecar.byGeom[geomKey]) || null;   // colour by geometry key
  const uC = (uuid && sidecar.byUuid[uuid]) || null;          // colour by uuid (usually dead)
  const iC = sidecar.byIndex[idxKey] || null;                 // colour by position/index
  let colorHex = null;
  if (gC) colorHex = gC;
  else if (uC) colorHex = uC;
  else if ((!sidecar.hasGeom || allowIndex) && iC) colorHex = iC;
  // geom + uuid BOTH missed for this stroke → recover its colour from the index entry rather than
  // falling to the grey default. (Was gated off whenever any stroke matched by geom, which left a
  // geom-missing highlight colourless — the "missing pink" / faint-grey highlights.) Only accept a
  // HIGHLIGHTER colour here so a misaligned index can't paint a highlight with a pen colour.
  else if (iC && isHighlightColor(iC)) colorHex = iC;
  else if (isArgbColor(penColor)) colorHex = argbToHex(penColor);
  // DIAGNOSTIC: a marker stroke that ended up with NO colour (→ grey default). Shows whether the
  // sidecar has ANY colour for it (byGeom/byIndex/byUuid) so we know if the colour is recoverable.
  if (!colorHex && WASH_PEN_TYPES.has(penType)) console.log(`[HLGRAY] idx=${idxKey} g=${(geomKey || '').slice(0, 22)} gC=${gC} iC=${iC} uC=${uC}`);
  return { colorHex, penType };
}

// ─── MarkerSize plugin: per-stroke marker WIDTH (Path B) ──────────────────────
// MarkerSize records each marker's chosen size in {export}/.msz/{base}_sizes.json
// = {byGeom, byIndex} (thickness per stroke), keyed identically to the colour
// sidecar. We resolve a marker's size with the SAME geom→numInPage fallback used
// for colour, then draw the marker at that width from its centreline — instead of
// filling its native (fat) outline. MarkerSize never touches the strokes, so this
// is purely additive: a note with no .msz sidecar renders exactly as before.

// Native marker thickness ≈ 3800 (logcat). NATIVE_MARKER_PX = the export pixel
// WIDTH a native marker occupies. TUNABLE — calibrate against the first export.
const NATIVE_MARKER_THICKNESS = 3800;
const NATIVE_MARKER_PX = 28;
function sizeThicknessToPx(thickness) {
  return Math.max(2, (thickness / NATIVE_MARKER_THICKNESS) * NATIVE_MARKER_PX);
}

async function readSizeSidecar(renderer, exportDir, baseName) {
  const out = { byIndex: {}, byGeom: {} };
  try {
    const raw = await renderer.readFile(`${exportDir.replace(/\/+$/,'')}/.msz/${baseName}_sizes.json`);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.byGeom)  out.byGeom  = d.byGeom;
      if (d.byIndex) out.byIndex = d.byIndex;
    }
  } catch {}
  out.hasGeom = Object.keys(out.byGeom).length > 0;
  return out;
}

// Returns the recorded thickness for this marker stroke, or null. Same resolution
// order as resolveColor (geom first, numInPage fallback gated the same way).
function resolveSize(el, page, sizeSidecar, geomKey, allowIndex) {
  if (!sizeSidecar) return null;
  if (geomKey && sizeSidecar.byGeom[geomKey] != null) return sizeSidecar.byGeom[geomKey];
  const idxKey = `${page}_${el.numInPage}`;
  if ((!sizeSidecar.hasGeom || allowIndex) && sizeSidecar.byIndex[idxKey] != null) return sizeSidecar.byIndex[idxKey];
  return null;
}

// Convert a marker's centreline (stroke.points, EMR) into pixel points in the
// base PNG frame: emrPoint2Android(pageSize) → xform (page→base) — the SAME frames
// the contours use. The native drawColoredStrokeLines strokes this polyline at the
// target width with round caps/joins (clean, no self-intersection). Returns a
// {x,y}[] polyline, or null to fall back to the native contour.
// COORD NOTE: if sized markers land in the wrong place, this conversion is the
// suspect (verified correct on the first portrait-doc export 2026-06-12).
async function buildMarkerCenterline(el, pageSize, xform) {
  const pts = el.stroke && el.stroke.points;
  let n = 0;
  try { n = (pts && pts.size) ? await pts.size() : 0; } catch {}
  if (!pts || n < 1 || !pageSize || !pageSize.width || !pageSize.height) return null;

  // PERF: a thin rendered line needs only a coarse polyline — subsample to ≤MAX_PTS so
  // we make ~48 emrPoint2Android calls instead of hundreds per marker (was ~1.5s/marker).
  const MAX_PTS = 48;
  let arr = null;
  try { if (pts.getRange) arr = await pts.getRange(0, n); } catch {}
  if (Array.isArray(arr) && arr.length) {
    if (arr.length > MAX_PTS) {
      const step = Math.ceil(arr.length / MAX_PTS);
      const sub = []; for (let i = 0; i < arr.length; i += step) sub.push(arr[i]);
      sub.push(arr[arr.length - 1]);   // keep the endpoint
      arr = sub;
    }
  } else {
    // getRange unavailable → read only a subsample (avoids n slow per-point get() calls)
    arr = [];
    const step = n > MAX_PTS ? Math.ceil(n / MAX_PTS) : 1;
    for (let i = 0; i < n; i += step) { try { const p = await pts.get(i); if (p) arr.push(p); } catch {} }
    try { const last = await pts.get(n - 1); if (last) arr.push(last); } catch {}
  }
  const center = [];
  for (const p of arr) {
    let q;
    try { q = PointUtils.emrPoint2Android(p, pageSize); } catch { return null; }   // unknown pageSize → bail to contour
    if (!q) continue;
    if (xform) q = xform(q);
    center.push({ x: Math.round(q.x), y: Math.round(q.y) });
  }
  return center.length ? center : null;
}

// ─── Landscape detection & render (DOC path, iteration 1) ─────────────────────
// A page authored in LANDSCAPE stores strokes whose EMR points — converted with the
// PORTRAIT pageSize — fall PAST the page bottom (y > pageH). That's geometrically
// impossible for a genuinely portrait stroke (you can't draw below the page), so it
// is a clean per-stroke orientation flag. Verified against on-device sidecars
// (2026-06-12): known-portrait pages had ZERO such strokes; known-landscape pages
// had many. The per-page rule: if ≥LAND_PAGE_FRAC of strokes overflow, the whole
// page is landscape → render the base rotated 90° and place strokes in that frame.
const LAND_SAMPLE   = 9;    // points sampled per stroke for classification
const LAND_EMR_PAD  = 250;  // EMR units past the portrait EMR bound before a stroke
                            // counts as landscape. Verified 2026-06-13: a landscape
                            // page read EMR Y≈14980 vs the 11864 portrait ceiling, a
                            // portrait page read ≈11345 — so 250 cleanly separates.
const PEN_PX        = 4;    // centreline width for non-marker strokes (iter-1)

// ─── Build overlay data per page ──────────────────────────────────────────────

// DOCUMENTS (PDF/EPUB): coloured contour polygons drawn on top of the rendered
// page. Contours are pixel coords, so printed text is never recoloured.
async function buildDocShapes(elements, page, sidecar, drawUncolored, xform = null, sizeSidecar = null, pageSize = null, strokeWidthScale = 1) {
  const docShapes = []; const strokeLines = []; let coloredCount = 0; let sizedCount = 0;
  // Note white-out (Path B): a sized marker's native fat footprint to erase, and
  // every other stroke's footprint to preserve so overlapping pen ink survives.
  const eraseContours = []; const keepContours = [];
  // Raw contour extent (pre-transform) — logged once per page so a landscape
  // export reveals exactly what coordinate space contoursSrc are in.
  let rawMinX = Infinity, rawMinY = Infinity, rawMaxX = -Infinity, rawMaxY = -Infinity, rawPts = 0;
  // Compute geom keys if EITHER the colour sidecar or the MarkerSize sidecar has
  // geom entries (a note may have sizes but no colours, or vice-versa).
  const hasGeom = (sidecar.byGeom && Object.keys(sidecar.byGeom).length > 0) ||
                  (sizeSidecar && sizeSidecar.hasGeom);

  // Pass 1: keep only stroke elements, compute each durable geom key once (skipping
  // the point reads when the sidecar is pre-geom), and count how many match.
  // Non-stroke elements are recycled immediately.
  const strokes = [];
  let geomMatchCount = 0;
  for (const el of elements) {
    if (el.type !== 0 || !el.stroke) { el.recycle?.(); continue; }
    const geomKey = hasGeom ? await strokeGeomKey(el) : '';
    if (geomKey && sidecar.byGeom[geomKey]) geomMatchCount++;
    strokes.push({ el, geomKey });
  }
  const totalStrokes = strokes.length;

  // byIndex (page_numInPage) is the ONLY matcher that survives an orientation change:
  // the device re-projects stroke geometry non-rigidly across rotation, so geom can't
  // match, while numInPage ordering is untouched. It's normally gated because on an
  // EDITED NOTE the indices reflow and byIndex would bleed a colour onto an uncoloured
  // drifted stroke. Enable it when:
  //   (a) the whole page is geom-shifted (geomMatchCount === 0 = pure orientation), OR
  //   (b) this is a DOCUMENT (drawUncolored === true) — doc annotation indices are
  //       STABLE (erased strokes leave numInPage GAPS, indices are never reused), so
  //       byIndex reliably recovers rotated strokes even on a page that MIXES portrait
  //       (geom-matched) and rotated annotations. Notes keep the strict gate.
  const allowIndex = hasGeom && totalStrokes > 0 && (geomMatchCount === 0 || drawUncolored);

  // A note (drawUncolored=false) with size data needs the white-out: erase each
  // sized marker's native footprint and preserve every other stroke's footprint.
  const noteWhiteout = !!sizeSidecar && !drawUncolored;

  // Read a stroke's contour polygons (pixel, xform'd into the base frame).
  const readContourPolys = async (el) => {
    const out = [];
    try {
      const cs = el.contoursSrc;
      const nC = (cs && cs.size) ? await cs.size() : 0;
      for (let ci = 0; ci < nC; ci++) {
        const poly = await cs.get(ci);
        if (Array.isArray(poly) && poly.length >= 3) {
          out.push(poly.map(p => {
            if (p.x < rawMinX) rawMinX = p.x; if (p.x > rawMaxX) rawMaxX = p.x;
            if (p.y < rawMinY) rawMinY = p.y; if (p.y > rawMaxY) rawMaxY = p.y; rawPts++;
            const q = xform ? xform(p) : p;       // rotate into the base's space if needed
            return { x: Math.round(q.x), y: Math.round(q.y) };
          }));
        }
      }
    } catch {}
    return out;
  };

  // Pass 2: resolve colour + size, build contours / stroke-lines / white-out masks.
  for (const { el, geomKey } of strokes) {
    const { colorHex, penType } = resolveColor(el, page, sidecar, geomKey, allowIndex);
    if (colorHex) coloredCount++;
    const isMarker = WASH_PEN_TYPES.has(penType);
    const drawColor = colorHex || (isMarker ? '#C9C9C9' : greyFromPenColor(el.stroke.penColor));
    const wash = isMarker;

    // SIZED marker → clean thin stroke (strokeLines, drawn by the native renderer,
    // regular colour OPAQUE / highlighter shade translucent). On a NOTE we also
    // erase its native fat footprint so the baked-in marker disappears.
    // Highlighter COLOURS render at FULL native width (a translucent wash via the
    // contour path below) — only WRITING-markers (pen colours) use the thin sized
    // stroke. Otherwise a highlight swipe comes out as a thin line.
    if (isMarker && sizeSidecar && !isHighlightColor(drawColor)) {
      const thickness = resolveSize(el, page, sizeSidecar, geomKey, allowIndex);
      let centerline = null;
      if (thickness != null) {
        try { centerline = await buildMarkerCenterline(el, pageSize, xform); } catch {}
      }
      if (thickness != null && centerline) {
        strokeLines.push({ color: drawColor, wash: false, width: sizeThicknessToPx(thickness) * strokeWidthScale, points: centerline });
        sizedCount++;
        if (noteWhiteout) { for (const poly of await readContourPolys(el)) eraseContours.push(poly); }
        el.recycle?.();
        continue;
      }
      // not sized (thick null) or centerline failed → fall through to the contour path
    }

    // Non-sized stroke (or a sized marker whose centreline failed). On a note
    // white-out we read EVERY stroke's contour (even un-coloured) so it can be
    // preserved under the white-out; otherwise un-coloured note strokes are skipped.
    const wantsDocShape = colorHex || drawUncolored;
    if (!wantsDocShape && !noteWhiteout) { el.recycle?.(); continue; }

    const polys = await readContourPolys(el);
    if (noteWhiteout) {
      // A COLOURED marker (even un-sized) gets its native footprint ERASED so its
      // wash/colour lands on the clean background instead of over the dark native
      // ink (which came out black). Everything else (pens, un-coloured markers) is
      // PRESERVED so it isn't wiped.
      const target = (isMarker && colorHex) ? eraseContours : keepContours;
      for (const poly of polys) target.push(poly);
    }
    if (wantsDocShape && polys.length) docShapes.push({ color: drawColor, wash, polys });
    el.recycle?.();
  }
  // Annotation pixel extent — used by the (currently DISABLED) off-page→landscape
  // path in colorDocPage. Kept for future improvement.
  const annMaxX = rawPts > 0 && xform == null ? Math.round(rawMaxX) : 0;
  const annMaxY = rawPts > 0 && xform == null ? Math.round(rawMaxY) : 0;
  return { docShapes, strokeLines, eraseContours, keepContours, totalStrokes, coloredCount, annMaxX, annMaxY };
}

// Render the page. Sized markers (strokeLines) are drawn FIRST, then the coloured
// contour overlays (docShapes) on top — so a coloured pen that overlaps a marker
// lands ON the marker (the user's "pens over markers"). With no sized markers,
// it's a single drawColoredShapes call → identical to before (regression-safe).
async function renderShapesAndStrokes(renderer, contentPng, docShapes, strokeLines, outPng) {
  if (strokeLines && strokeLines.length && renderer.drawColoredStrokeLines) {
    const tmp = `${outPng}.strokes.png`;
    await renderer.drawColoredStrokeLines(contentPng, strokeLines, tmp);   // sized markers first
    await renderer.drawColoredShapes(tmp, docShapes, outPng);              // coloured pens/markers on top
    await settle(FileUtils.deleteFile(tmp));
  } else {
    await renderer.drawColoredShapes(contentPng, docShapes, outPng);
  }
}

// ─── Colour one page (per document type) ──────────────────────────────────────

// Notes render like docs: start from a TEMPLATE-ONLY base (dots/lines, NO ink) and
// draw EVERY annotation ourselves — markers as see-through strokes/washes, pens as
// opaque fills on top. So every marker is transparent underneath at ANY size, with
// no baked-in native ink to fight (the old generateNotePng base baked the marker in
// dark, which is why markers came out black/opaque). If the template can't be
// rendered we fall back to the full note render + colour overlays only.
async function colorNotePage(renderer, notePath, page, size, sidecar, sizeSidecar, contentPng, outPng) {
  const tpl = unpack(await settle(PluginFileAPI.generateNoteTemplatePng(notePath, page, contentPng)).then(x => x.val));
  let drawUncolored = true;   // template base has no ink → we draw every stroke
  if (!tpl.ok) {
    const r = unpack(await settle(PluginFileAPI.generateNotePng({ notePath, page, times: 1, pngPath: contentPng, type: 1 })).then(x => x.val));
    if (!r.ok) return { ok: false, totalStrokes: 0, coloredCount: 0, err: r.err };
    drawUncolored = false;    // fallback: full ink base → overlay coloured strokes only
  }

  // Base-scale: map stroke contours into the base PNG's pixel frame (handles
  // `times`-scaling / same-orientation size differences).
  const info = unpack(await settle(renderer.pngInfo(contentPng)).then(x => x.val)).val;
  const baseW = info?.width ?? 0, baseH = info?.height ?? 0;
  const pageW = size?.width ?? 0, pageH = size?.height ?? 0;
  let sx = 1, sy = 1;
  if (baseW > 0 && baseH > 0 && pageW > 0 && pageH > 0 &&
      (baseW >= baseH) === (pageW >= pageH) && (baseW !== pageW || baseH !== pageH)) {
    sx = baseW / pageW; sy = baseH / pageH;
  }

  const elems = unpack(await settle(PluginFileAPI.getElements(page, notePath)).then(x => x.val));
  const elements = Array.isArray(elems.val) ? elems.val : [];

  // Landscape-held note: shrink the writing onto the portrait page (same reflow factor
  // as docs), composed with the base-scale. Held portrait → s=1 → base-scale only.
  const { s, ext } = await landscapeShrinkFactor(elements, size);
  let xform = (sx !== 1 || sy !== 1) ? (p) => ({ x: p.x * sx, y: p.y * sy }) : null;
  let widthScale = Math.sqrt(sx * sy);
  if (s < 1 && ext) {
    // Scale to FIT + CENTRE the content (fixes LEFT-overflow clipping), then compose with
    // the base-scale (page→png frame). Sized markers stay ON, width scaled to match.
    const PAD = 30;
    const cw = Math.max(1, ext.maxX - ext.minX), ch = Math.max(1, ext.maxY - ext.minY);
    const scale = Math.min(s, (size.width - 2 * PAD) / cw, (size.height - 2 * PAD) / ch);
    const offX = (size.width  - cw * scale) / 2 - ext.minX * scale;
    const offY = (size.height - ch * scale) / 2 - ext.minY * scale;
    xform = (p) => ({ x: (p.x * scale + offX) * sx, y: (p.y * scale + offY) * sy });
    widthScale = scale * Math.sqrt(sx * sy);
  }

  const { docShapes, strokeLines, totalStrokes, coloredCount } =
    await buildDocShapes(elements, page, sidecar, drawUncolored, xform, sizeSidecar, size, widthScale);

  // Sized markers (strokeLines) drawn first, then everything else (docShapes: pens
  // opaque + un-sized markers as wash) on top — pens land over markers.
  await renderShapesAndStrokes(renderer, contentPng, docShapes, strokeLines, outPng);
  await settle(FileUtils.deleteFile(contentPng));
  return { ok: true, totalStrokes, coloredCount };
}

// Full pixel extent of every stroke's contours (the TRUE on/off-page positions, incl.
// ink drawn past the page edge). Reads contours but does NOT recycle (caller re-reads).
async function annotationExtent(elements, pageSize) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  const acc = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; any = true; };
  for (const el of elements) {
    if (el.type !== 0 || !el.stroke) continue;
    try {
      const cs = el.contoursSrc;
      const nC = (cs && cs.size) ? await cs.size() : 0;
      for (let ci = 0; ci < nC; ci++) {
        const poly = await cs.get(ci);
        if (Array.isArray(poly)) for (const p of poly) acc(p.x, p.y);
      }
    } catch {}
    // Markers render from a CENTRELINE (emrPoint2Android), which on a shrunk page can land
    // in a different pixel frame than the contour. Include it so the centring box covers
    // where the marker actually draws — otherwise markers clip off the edge.
    if (pageSize && WASH_PEN_TYPES.has(el.stroke.penType)) {
      try { const cl = await buildMarkerCenterline(el, pageSize, null); if (cl) for (const p of cl) acc(p.x, p.y); } catch {}
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

// LANDSCAPE SHRINK: when a page is exported held in landscape, the device hands the
// writing back in the page's LANDSCAPE frame (width = the long side), so the contours
// overflow the portrait page. The device's own portrait "reflow" is a UNIFORM scale by
// pageW/pageH (short/long, ≈0.75 on A5X) — verified against held-portrait vs held-
// landscape exports (both axes scaled 0.75). So we detect the overflow and return that
// scale; applying it maps the landscape writing back onto the portrait page exactly
// where the device would. Held portrait → writing already fits → s=1 (no change).
// Reads contours, does NOT recycle (caller re-reads). Only shrinks portrait pages.
async function landscapeShrinkFactor(elements, size) {
  const ext = await annotationExtent(elements, size);   // include marker centrelines
  if (!ext || !size?.width || !size?.height) return { s: 1, ext };
  const OFF = 20;
  const overflow = ext.minX < -OFF || ext.minY < -OFF ||
                   ext.maxX > size.width + OFF || ext.maxY > size.height + OFF;
  if (!overflow || size.height <= size.width) return { s: 1, ext };
  return { s: size.width / size.height, ext };
}

// PDF + EPUB pages. Renders a normal portrait page. If the export was held in landscape
// (writing overflows the page), the writing is SHRUNK by the page's short/long ratio so
// it lands on the page exactly where the device's own portrait reflow would put it.
// Held portrait → s=1 → unchanged. Every page therefore comes out portrait.
async function colorDocPage(renderer, notePath, page, size, sidecar, sizeSidecar, contentPng, outPng, renderBase, digestRects) {
  const base = await renderBase(contentPng, size);
  if (!base.ok) return { ok: false, totalStrokes: 0, coloredCount: 0, err: base.err };
  const elems = unpack(await settle(PluginFileAPI.getElements(page, notePath)).then(x => x.val));
  const elements = Array.isArray(elems.val) ? elems.val : [];

  const { s, ext } = await landscapeShrinkFactor(elements, size);
  let xform = null, widthScale = 1;
  if (s < 1 && ext) {
    // Scale to FIT the page (no more than the 0.75 reflow) and CENTRE the content.
    // A plain ×0.75 about the origin left LEFT-overflowing writing clipped — so map the
    // content's bounding box to the page centre instead.
    const PAD = 30;
    const cw = Math.max(1, ext.maxX - ext.minX), ch = Math.max(1, ext.maxY - ext.minY);
    const scale = Math.min(s, (size.width - 2 * PAD) / cw, (size.height - 2 * PAD) / ch);
    const offX = (size.width  - cw * scale) / 2 - ext.minX * scale;
    const offY = (size.height - ch * scale) / 2 - ext.minY * scale;
    xform = (q) => ({ x: q.x * scale + offX, y: q.y * scale + offY });
    widthScale = scale;
  }

  const { docShapes, strokeLines, totalStrokes, coloredCount } = await buildDocShapes(elements, page, sidecar, true, xform, sizeSidecar, size, widthScale);
  // DIGEST highlights (highlighter-tool marks, not in getElements) → colour wash over each rect, so a
  // crop of the highlighted passage keeps its colour (EPUB has no text layer to recover otherwise).
  for (const r of (digestRects || [])) {
    const c = [{ x: r.left, y: r.top }, { x: r.right, y: r.top }, { x: r.right, y: r.bottom }, { x: r.left, y: r.bottom }];
    docShapes.push({ color: r.color, wash: true, polys: [xform ? c.map(xform) : c] });
  }
  await renderShapesAndStrokes(renderer, contentPng, docShapes, strokeLines, outPng);
  await settle(FileUtils.deleteFile(contentPng));
  return { ok: true, totalStrokes, coloredCount };
}

// ─── Document-type detection + page bookkeeping ───────────────────────────────

function detectKind(notePath) {
  if (/\.note$/i.test(notePath)) return 'note';
  if (/\.pdf$/i.test(notePath))  return 'pdf';
  return 'doc';   // EPUB and other DOC-app formats → generateDocImage
}

async function resolveTotal(kind, notePath) {
  let total;
  if (kind === 'note') {
    total = unpack(await settle(PluginFileAPI.getNoteTotalPageNum(notePath)).then(r => r.val)).val;
  } else {
    total = unpack(await settle(PluginDocAPI.getCurrentTotalPages()).then(r => r.val)).val;
    if (typeof total !== 'number' || total < 1) {
      total = unpack(await settle(PluginFileAPI.getNoteTotalPageNum(notePath)).then(r => r.val)).val;
    }
  }
  return (typeof total === 'number' && total > 0) ? total : null;
}

// Annotated pages = pages that actually have ≥1 annotation element right now.
// Documents expose a mark layer (getMarkPages) to narrow the candidates; notes
// don't, so we scan every page. IMPORTANT: getMarkPages still lists a page after
// its annotations were ERASED (the empty mark layer lingers), so we must confirm
// each candidate truly has elements — otherwise erased pages get exported blank.
async function resolveAnnotatedPages(kind, notePath, total) {
  let candidates = null;
  if (kind !== 'note') {
    const marks = unpack(await settle(PluginFileAPI.getMarkPages(notePath)).then(r => r.val)).val;
    if (Array.isArray(marks) && marks.length) candidates = [...new Set(marks)].sort((a, b) => a - b);
  }
  if (!candidates) candidates = Array.from({ length: total }, (_, i) => i);

  const pages = [];
  for (const p of candidates) { if (await pageElementCount(notePath, p) > 0) pages.push(p); }
  return pages;
}

// ─── Public: export a colour PDF (one PDF page per document page) ─────────────

/**
 * @param {object}   opts
 * @param {'full'|'annotated'|'new'} opts.mode  page scope.
 * @param {function} [opts.onProgress]   (done, total) callback.
 */
// Parse a user page spec — "5", "3-10", or a comma list like "3-10, 15" — into
// 0-based page indices. User-facing page numbers are 1-based (matches the rest
// of the UI), so we subtract 1. Out-of-range numbers are dropped.
function parsePageSpec(spec, total) {
  const want = new Set();
  for (const partRaw of String(spec || '').split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = parseInt(range[1], 10), b = parseInt(range[2], 10);
      if (a > b) { const t = a; a = b; b = t; }
      for (let p = a; p <= b; p++) want.add(p);
    } else if (/^\d+$/.test(part)) {
      want.add(parseInt(part, 10));
    } else {
      throw new Error(`Couldn't read "${part}". Use a page like 5 or a range like 3-10.`);
    }
  }
  const pages = [...want].filter(p => p >= 1 && p <= total).sort((a, b) => a - b).map(p => p - 1);
  if (pages.length === 0) throw new Error(`No valid pages in "${spec}". This document has ${total} page(s).`);
  return pages;
}

export async function runExport({ mode = 'full', format = 'pdf', pngMode = 'perPage', pageSpec = '', onProgress } = {}) {
  console.log('ECP_BUILD v2.5.0');
  const renderer = NativeModules.CombinedColorPdfRenderer;
  if (!renderer || !renderer.drawColoredShapes || !renderer.overlayColoredStrokes || !renderer.assemblePdf) {
    throw new Error('CombinedColorPdfRenderer native module not found. Is the plugin installed correctly?');
  }
  if (format === 'png' && pngMode === 'combined' && !renderer.stitchPngVertical) {
    throw new Error('This plugin build does not support combined PNG — reinstall the latest version.');
  }

  const exportDir = await FileUtils.getExportPath();
  if (!exportDir) throw new Error('Cannot resolve EXPORT directory');
  await FileUtils.makeDir(exportDir);
  const EXPORT = exportDir.replace(/\/+$/, '');

  const notePath = unpack(await PluginCommAPI.getCurrentFilePath()).val;
  if (!notePath) throw new Error('getCurrentFilePath failed — open a document first');
  const baseName = deriveBaseName(notePath);
  const kind = detectKind(notePath);

  const total = await resolveTotal(kind, notePath);
  if (total == null) throw new Error('Could not determine page count');

  // Resolve the page list for the chosen mode.
  let pages;
  if (mode === 'full') {
    let t = total;
    if (MAX_PAGES > 0 && t > MAX_PAGES) t = MAX_PAGES;
    pages = Array.from({ length: t }, (_, i) => i);
  } else if (mode === 'current') {
    const cur = unpack(await settle(PluginCommAPI.getCurrentPageNum()).then(x => x.val)).val;
    if (typeof cur !== 'number' || cur < 0 || cur >= total) throw new Error('Could not determine the current page.');
    pages = [cur];
  } else if (mode === 'pages') {
    pages = parsePageSpec(pageSpec, total);   // user-specified pages/ranges (1-based)
  } else {
    const annotated = await resolveAnnotatedPages(kind, notePath, total);
    if (mode === 'new') {
      const state = await readExportState(renderer, EXPORT, baseName, format);
      pages = [];
      for (const p of annotated) {
        const count = await pageElementCount(notePath, p);
        const prev = state.pages[String(p)];
        if (prev == null || count > prev) pages.push(p);
      }
      if (pages.length === 0) throw new Error('No pages with new annotations since your last export of this book.');
    } else {
      pages = annotated;
      if (pages.length === 0) throw new Error('No annotated pages found on this document.');
    }
  }

  // Combined PNG is one tall image — capped so it can't OOM the device.
  const COMBINED_PNG_MAX = 25;
  if (format === 'png' && pngMode === 'combined' && pages.length > COMBINED_PNG_MAX) {
    throw new Error(`Combined PNG is limited to ${COMBINED_PNG_MAX} pages — you selected ${pages.length}. Pick a narrower scope, or choose “one PNG per page” or PDF.`);
  }

  const sidecar = await readSidecar(renderer, EXPORT, baseName);
  // MarkerSize sizes (Path B). Empty when the note has no .msz sidecar → every
  // marker takes the unchanged contour path, so existing exports never regress.
  const sizeSidecar = await readSizeSidecar(renderer, EXPORT, baseName);
  // EPUB/DOC: read the digest highlight rects so colorDocPage can wash them onto the render (PDF
  // crops pen highlights / text-lifts digests, so it doesn't need this — keep that path unchanged).
  const digestMap = (kind === 'doc') ? await readDigestRects(renderer, `${notePath}.mark`) : {};

  // Notes must be flushed to disk before generateNotePng/getElements.
  if (kind === 'note') { try { await PluginNoteAPI.saveCurrentNote(); } catch {} }

  const stamp = Date.now();
  const pluginDir = await PluginManager.getPluginDirPath();
  const tmpDir = `${(pluginDir || EXPORT).replace(/\/+$/, '')}/cpdf-${stamp}`;
  await FileUtils.makeDir(tmpDir);

  // PNG "one per page" writes its page images straight into a kept EXPORT
  // subfolder so they survive tmp cleanup; PDF and combined-PNG render to tmp
  // and are assembled/stitched, then cleaned up.
  const keepPages = format === 'png' && pngMode === 'perPage';
  const pngOutDir = `${EXPORT}/color_${baseName}_${mode}_${stamp}`;
  if (keepPages) await FileUtils.makeDir(pngOutDir);

  const pagePngPaths = [];
  let totalStrokes = 0, coloredCount = 0, skipped = 0, done = 0;

  try {
    for (const page of pages) {
      const sz = unpack(await settle(PluginFileAPI.getPageSize(notePath, page)).then(r => r.val));
      // size: resolved-with-fallback (docs need concrete dims to render the base).
      // pageSizeExact: the TRUE page frame, or null if getPageSize failed — notes
      // use this to map contours into the base frame without trusting a fallback.
      const pageSizeExact = (sz.ok && sz.val?.width) ? sz.val : null;
      const size = pageSizeExact || { width: 1404, height: 1872 };

      const contentPng = `${tmpDir}/base-${String(page).padStart(4, '0')}.png`;
      const outPng      = keepPages
        ? `${pngOutDir}/p${String(page + 1).padStart(4, '0')}.png`   // 1-based page numbering
        : `${tmpDir}/page-${String(page).padStart(4, '0')}.png`;

      let r;
      if (kind === 'note') {
        r = await colorNotePage(renderer, notePath, page, pageSizeExact, sidecar, sizeSidecar, contentPng, outPng);
      } else if (kind === 'pdf') {
        r = await colorDocPage(renderer, notePath, page, size, sidecar, sizeSidecar, contentPng, outPng,
          async (png, s) => { const x = await settle(renderer.renderDocPage(notePath, page, s.width, s.height, png)); return { ok: x.ok, err: x.err }; });
      } else {
        r = await colorDocPage(renderer, notePath, page, size, sidecar, sizeSidecar, contentPng, outPng,
          async (png, s) => { const x = unpack(await settle(PluginDocAPI.generateDocImage(notePath, page, png, s)).then(y => y.val)); return { ok: x.ok && x.val !== false, err: x.err }; }, digestMap[page]);
      }

      done++;
      onProgress?.(done, pages.length);
      if (!r.ok) { skipped++; await settle(FileUtils.deleteFile(contentPng)); continue; }
      totalStrokes += r.totalStrokes;
      coloredCount += r.coloredCount;
      pagePngPaths.push(outPng);
    }

    if (pagePngPaths.length === 0) throw new Error('No pages rendered.');

    let outPath;
    if (format === 'png' && pngMode === 'combined') {
      outPath = `${EXPORT}/color_${baseName}_${mode}_${stamp}.png`;
      await renderer.stitchPngVertical(pagePngPaths, outPath);
    } else if (keepPages) {
      outPath = pngOutDir;   // a folder containing one PNG per page
    } else {
      outPath = `${EXPORT}/color_${baseName}_${mode}_${stamp}.pdf`;
      await renderer.assemblePdf(pagePngPaths, outPath);
    }

    // Refresh the "new annotations" baseline for every currently-annotated page.
    // Skipped for ad-hoc specific-page exports so they don't consume the
    // "pages with new annotations" tracking.
    if (mode !== 'pages' && mode !== 'current') {
      try {
        const annotatedNow = await resolveAnnotatedPages(kind, notePath, total);
        const snapshot = { lastExport: stamp, pages: {} };
        for (const p of annotatedNow) snapshot.pages[String(p)] = await pageElementCount(notePath, p);
        await writeExportState(renderer, EXPORT, baseName, format, snapshot);
      } catch {}
    }

    return { path: outPath, pages: pagePngPaths.length, totalStrokes, coloredCount, skipped, mode, kind, format, pngMode };

  } finally {
    // Keep the per-page PNGs (they're the deliverable); always clear the temp dir.
    if (!keepPages) { for (const p of pagePngPaths) { try { await FileUtils.deleteFile(p); } catch {} } }
    try { await FileUtils.deleteDir(tmpDir); } catch {}
  }
}

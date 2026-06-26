# DocAnnotationsToNote — Architecture

**Goal:** After a user annotates a PDF (later EPUB — Part B), extract the marked
material into a Supernote **note**, in document reading order, each non-contiguous
piece separated by **3 blank lines**. Same page-scope options as ExportColorPDF
(current / specific pages / annotated / new / entire).

Status: architecture (2026-06-18). All extraction methods validated offline against
`How to do things you hate.pdf` via the AnnotationProbe diagnostic. See
`[[pdf-digest-storage]]` memory for the full validation record.

---

## 1. Annotation types → output (all validated)

| Mark | Detect (from `getElements`, type-0 strokes) | Output in note |
|------|----------------------------------------------|----------------|
| **Highlighter** | `penType==11` (marker), tall-ish (h≈44–56px) | **text** under the stroke rect |
| **Underline** | `penType==10` (pen), wide & short (h≲20px, asp≳10) | **text** in a band just above the baseline |
| **Enclosure** (circle/box/loop) | pen, asp≈0.4–2.5, both dims ≥~90px, closed | **PNG crop** of the bbox region (keeps diagrams/graphs intact) |
| **Paren/Brace** `(` `)` `{` `}` | pen, tall-thin (h>40px, w<0.7h), in **L/R pairs** at same y | **text** between the inner edges |
| **Handwriting** | pen, small, clustered (not matching above) | copied **stroke** elements (optionally OCR via `recognizeElements`) |

**Bracket `[ ]` is unsupportable** — the firmware converts it to a digest and removes
the ink, leaving nothing reachable (no element, no stroke, not in `.mark`, not in
`getCurrentDocText`; digest.db is app-private). **User convention: wrap in `([ … ])`** —
`[]` feeds the native Supernote digest panel, `()` stays as ink we read.

Reading order: sort every captured piece by **(page, y, x)** of its anchor mark.

---

## 2. Coordinate transform (pixel → PDF points)

Strokes from `getElements` (`contoursSrc`) and `getPageSize` are in **device page
pixels** (e.g. 1404×1872). PDF text/render is in **PDF points**. Derive a per-page
affine:

- `scaleX = pdfW / pxW`, `scaleY = pdfH / pxH` (pdfW/H from the native PDF page size;
  pxW/H from `getPageSize`).
- Empirically (page-5 HIGHLIGHTINFO ground truth) this is ≈ `x·0.436`, `y·0.4375 − 14`
  — i.e. there is a small **y offset/letterbox**, so do NOT assume pure scale.
- **Self-check at runtime:** if the doc has any HIGHLIGHTINFO highlight, it carries BOTH
  `rnRectList` (px) and `mupdfRectList` (pts) for the same mark → solve the exact affine
  from it. Else fall back to size-ratio. Validate by confirming extracted highlight text
  is non-empty.

---

## 3. Native module (Kotlin) — additions to `CombinedColorPdfRenderer`

Current: `renderDocPage` (Android `PdfRenderer`, render-only, **no text API**),
`writeFile`. Two additions needed:

1. **`extractTextInRect(pdfPath, pageIndex, x0,y0,x1,y1) → String`**
   Android `PdfRenderer` cannot extract text. Add **PdfBox-Android**
   (`com.tom-roush:pdfbox-android`) and use `PDFTextStripperByArea` with the rect
   (PDF points). Returns the text whose glyphs fall in the region (reading order).
   *Risk: new gradle dependency — the one integration risk in this build.*

2. **`cropRegionToPng(pdfPath, pageIndex, x0,y0,x1,y1, outPath) → path`**
   Render the page with `PdfRenderer` at target DPI, crop the rect (in px) from the
   bitmap, write PNG. Used for **enclosures**. (Reuses existing render path + a Bitmap
   crop — low risk.)

> **Decision point (flagged):** real text needs PdfBox-Android. Fallback if we want to
> avoid the dependency for v1 = render EVERYTHING (incl. highlight/underline/paren) as
> **PNG crops** via `cropRegionToPng` (no text lib). Recommended: do the PdfBox text
> path — text is the validated, desired result; image-clip is the safety net.

---

## 4. JS pipeline (`src/exporter` → reuse structure; `App.tsx` chooser)

1. **User creates the target note**, opens it, runs the plugin (button shows chooser:
   file-pick source PDF + scope). `createNote` is host-blocked (102) — user-made note only.
2. `notePath` (the open note) via `PluginCommAPI.getCurrentFilePath()`; source PDF via
   `RattaFileSelector.selectFile({selectType:1, suffixList:['pdf','epub']})`.
3. Resolve scope → page list (`getMarkPages` for annotated; or range/all).
4. **Per source page** (cross-context read by path — confirm `getElements(page,pdfPath)`
   works while a NOTE is current; HANDOFF open item):
   - `getElements` → classify each stroke (table §1) using bbox + penType.
   - Pair paren/brace marks (tall-thin pens, y-overlap, L/R).
   - For each captured item compute its **PDF rect** (via §2 transform) and **anchor**
     (page, y, x); call native `extractTextInRect` (text types) or `cropRegionToPng`
     (enclosure); handwriting → keep stroke elements.
5. **Order** all items across pages by (page, y, x).
6. **Lay into the note** via `insertElements(notePath, page, [el])` (works for text +
   picture + stroke elements; path+page addressed, no page-flip needed):
   - text → `TYPE_TEXT` textBox element; picture → `TYPE_PICTURE` (`{picturePath, rect}`,
     EMR coords, page bounds ≈ 15819×11864); handwriting → stroke elements.
   - **3 blank lines between entries.** Append pages with `insertNotePage(style_white)`
     when the current note page fills.

---

## 5. Plugin identity & build

- Clone of the ExportColorPDF native base (reuses its module + build). New identity:
  `app.json`/PluginConfig `pluginKey="DocAnnotationsToNote"`, unique `pluginID`,
  `buildPlugin.sh` `OUT_NAME=DocAnnotationsToNote`. Android package may stay
  `com.exportcolorpdfcombined` (reused native) — bump versionCode only on name change.
- Build: `./buildPlugin.sh` (JDK17 + ANDROID_HOME) → `build/outputs/DocAnnotationsToNote.snplg`;
  push to MyStyle; reinstall via Settings (every build).

---

## 6. Open items / future

- **Cross-context read** (`getElements`/render by PDF path while a note is current) —
  confirm on-device (HANDOFF item).
- **PdfBox-Android integration** — the one build risk; validate it bundles + extracts.
- **Enclosure intent** — PNG crop of bbox (decided). Loose loops capture the bbox block.
- **Part B — EPUB.** EPUB is reflowable (no fixed PDF coords). Open: does Supernote
  anchor EPUB annotations to rendered-page pixels (→ this approach mostly carries) or to
  text-flow/CFI offsets (→ different extraction)? Investigate when reached.
- **Bracket `[ ]`** — only via a future Ratta digest API; `([ ])` convention until then.

## 7. Validation status (2026-06-18)
Highlight ✅, underline ✅ (band above), enclosure ✅ (point-in-poly proved; output=PNG),
paren/brace ✅ (pair + text-between: "Work With Your Body", "learn to work with your
body's natural cycles…"), transform ✅ (generalizes across pages). Handwriting = strokes
(existing exporter copies strokes). Native text-by-rect = PdfBox-Android (to integrate).

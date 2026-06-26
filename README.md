# DocAnnotationsToNote

A Supernote plugin that **extracts the annotations from a marked-up document into a note** — in
document reading order — so your highlights, underlines, brackets, circles, and handwriting become a
clean, reusable summary you can keep, edit, and search alongside the rest of your notes.

> **Status:** PDF extraction is stable. **EPUB support is Beta** (see [EPUB](#epub-support-beta)).

## What it does

You read a PDF on your Supernote and mark it up as you go. This plugin walks the document's
annotation layer and pulls each mark into your note as the right kind of entry:

| You drew… | You get… |
|---|---|
| **Highlighter** over text | the highlighted passage (image crop, in its color) |
| **Underline** | the underlined text |
| **( ) / { } bracket** around a passage | the bracketed text, lifted in reading order |
| **Circle / lasso** around a region | the enclosed text (or a crop for diagrams) |
| **A margin bracket** (one-sided) | the text it wraps |
| **Handwriting / doodles** | your ink only, on a clean background, in its color |
| **Digests** (text-selection highlights) | the highlighted text, tagged `[D]` |

Everything lands in the note **in reading order**, with overlapping marks de-duplicated, headings
detected, and stray dots/marks filtered out.

## How to use it

1. **Mark up a PDF** in the Supernote document reader.
2. Open the plugin → choose a **scope** (current page · specific pages · all annotations · new
   annotations since last run · whole document).
3. It extracts to a hand-off file. Open (or create) the **note** you want it in, run the plugin again
   on that note, and it **pastes** the extract in.

## EPUB support (Beta)

EPUB is **experimental**. PDFs carry a text layer with exact word coordinates; EPUB is reflowable and
the Supernote re-renders it at a different layout than where the marks were drawn, so on EPUB the
plugin works from the **rendered page image** instead:

- It detects each page's text lines from the render and **auto-corrects the per-page reflow shift** so
  marks land on the right lines.
- Annotations come through as **image crops** (no selectable text), recovered onto the nearest text
  line so a note is never silently lost.

It works well on prose-style books, but **image-heavy / decorative books can paginate differently**
between the reader and the render, which no offset can fully fix. Feedback on real EPUBs is welcome.

## Build & deploy

```bash
bash buildPlugin.sh   # → build/outputs/DocAnnotationsToNote.snplg   (needs ANDROID_HOME)
# install: copy the .snplg to /storage/emulated/0/MyStyle/ on the device,
# then Settings → Apps → Plugins → install.
```

A prebuilt `.snplg` is in [`releases/`](./releases). Colors come from the **Custom Color Palette**
plugin's sidecar; the document render reuses the **ExportColorPDF** renderer.

## Source layout

- `index.js` — registers the toolbar button; emits `docAnnotRun` so the plugin re-arms each press.
- `src/App.tsx` — the scope chooser UI, the **extraction pipeline** (classify marks → lift text /
  crop regions → de-dupe → order), and note insertion.
- `src/exporter.js` — the per-page color renderer (shared with ExportColorPDF).
- `android/.../ColorPdfRendererModule.kt` — native module: PDF text extraction (PdfBox), page render,
  region crop, stroke (ink-only) render, and text-row detection for EPUB.
- `ARCHITECTURE.md` — design notes.

## License

[MIT](./LICENSE).

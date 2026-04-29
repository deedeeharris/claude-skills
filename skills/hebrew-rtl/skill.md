---
name: hebrew-rtl
description: >
  Apply RTL Hebrew rules when generating ANY document containing Hebrew text.
  Use alongside pptx-generator, minimax-docx, minimax-xlsx, minimax-pdf, or any
  HTML/web output. Fixes BiDi confusion, wrong punctuation, reversed parentheses,
  layout mirroring, and comma placement errors.
  Triggers: Hebrew, עברית, RTL, right-to-left, rtl document, Hebrew presentation,
  Hebrew Word doc, Hebrew Excel, Hebrew PDF, Hebrew slides, ישראל, עברי.
license: MIT
metadata:
  version: "1.0.0"
  category: localization
---

# Hebrew RTL — Document Generation Rules

**ALWAYS use this skill alongside the relevant document skill (pptx-generator, minimax-docx, etc.).**

## The 8 Rules (All Formats)

**Rule 1 — Set RTL at document level**
Every format has a top-level RTL switch. Set it first, before any content.

**Rule 2 — RTL on EVERY text element**
Do NOT assume inheritance. Explicitly set `rtlMode`, `lang: "he-IL"`, `align: "right"` on each element individually.

**Rule 3 — Use a helper function**
Wrap all RTL settings in a reusable function. Never set them manually per element — you will miss some.

**Rule 4 — Rich text arrays — RTL per item**
When building arrays of text runs, each item needs its own RTL flag, not just the container.

**Rule 5 — Mirror layout elements**
Page numbers → LEFT side. Accent borders → LEFT side. Badges → LEFT side. Everything flips horizontally.

**Rule 6 — Hebrew punctuation**
- Use `׳` (U+05F3 geresh) not apostrophe `'`
- Use `״` (U+05F4 gershayim) not double-quote `"`
- Use `—` (U+2014 em-dash) not hyphen `-`

**Rule 7 — Natural comma placement**
- Correct: `לגעת, ללמוד וליצור`
- Wrong: `לגעת ,ללמוד`
Comma goes AFTER the word, not before the next one.

**Rule 8 — Test with real mixed content**
Always verify with: Hebrew + numbers + English words + punctuation together.

---

## Format-Specific Implementation

### PptxGenJS (pptx-generator skill)

```js
// Step 1: Document level
pres.rtlMode = true;

// Step 2: Helper function — use for EVERY addText call
function rtl(opts) {
  return {
    ...opts,
    fontFace: "Arial",
    rtlMode: true,
    lang: "he-IL"
  };
}

// Step 3: All text elements via helper
slide.addText("טקסט בעברית", rtl({
  x: 0, y: 0, w: 9, h: 1,
  fontSize: 14,
  align: "right"
}));

// Step 4: Page number badge → LEFT side (mirrored from default right)
slide.addShape(pres.shapes.OVAL, {
  x: 0.3, y: 5.1, w: 0.4, h: 0.4,   // LEFT not right (x: 9.3)
  fill: { color: theme.accent }
});
```

### python-docx (minimax-docx skill)

```python
from docx.oxml.ns import nsdecls
from docx.oxml import parse_xml
from docx.enum.text import WD_ALIGN_PARAGRAPH

def set_rtl(paragraph):
    """Apply RTL to a paragraph — call on EVERY paragraph."""
    pPr = paragraph._p.get_or_add_pPr()
    bidi = parse_xml(f'<w:bidi {nsdecls("w")} val="1"/>')
    pPr.append(bidi)
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT

# Usage — every paragraph
p = doc.add_paragraph()
set_rtl(p)
run = p.add_run("טקסט בעברית")
run.font.name = "David"   # or "Arial", "Calibri"
```

### HTML/CSS

```html
<!-- Document level -->
<html lang="he" dir="rtl">
<body>

<style>
  body {
    direction: rtl;
    text-align: right;
    font-family: 'Heebo', 'Arial', sans-serif;
  }

  /* Code blocks stay LTR */
  pre, code {
    direction: ltr;
    text-align: left;
  }
</style>
```

### ReportLab / minimax-pdf

```python
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()
hebrew_style = styles['Normal'].clone('Hebrew')
hebrew_style.alignment = TA_RIGHT
hebrew_style.fontName = 'Helvetica'   # or register a Hebrew font

# Use for every paragraph with Hebrew text
from reportlab.platypus import Paragraph
p = Paragraph("טקסט בעברית", hebrew_style)
```

---

## Punctuation Cheat Sheet

| Instead of | Use | Unicode | Example |
|---|---|---|---|
| `'` apostrophe | `׳` geresh | U+05F3 | מ׳כ, פל׳ג |
| `"` double-quote | `״` gershayim | U+05F4 | צה״ל, רמ״ד |
| `-` hyphen | `—` em-dash | U+2014 | מ״כ א — לחום |
| `,` wrong side | `,` after word | — | לגעת, ללמוד |

---

## Common Failure Modes to Watch For

| Symptom | Cause | Fix |
|---|---|---|
| Numbers appear on wrong side | BiDi not set at document level | Rule 1 |
| Parentheses reversed | No per-element RTL | Rule 2 |
| Page number on right | Layout not mirrored | Rule 5 |
| צה"ל looks broken | ASCII quotes instead of gershayim | Rule 6 |
| ` ,מילה` (space before comma) | Wrong comma placement | Rule 7 |
| English inside Hebrew flips | Wrap in `<span dir="ltr">` in HTML, or use BiDi marks in other formats | Rule 8 |

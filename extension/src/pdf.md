---
name: pdf
description: Read, search, pull tables from, OCR, fill in, split, merge, rotate or make PDFs with the tools in your sandbox, all on this machine.
---

# PDFs

Everything here runs in your sandbox: none of it needs the network or a model other than your own. Work on the file where it is, write each result as a new file beside it or in your thread folder (`report-pages-1-3.pdf`, `form-filled.pdf`), and never change or delete the person's original unless they ask. Before handing a result over, turn a page of it into a picture and look at it.

## A first look

- `pdfinfo in.pdf`: pages, page size, `Encrypted`, and `Form: AcroForm` when it has fields to fill.
- `pdffonts in.pdf`: no fonts at all means scanned pages, with no text to read until you OCR them.
- `pdftotext -l 2 in.pdf - | head -80`: the first pages' text. `pdftotext in.pdf - | wc -w` before reading a long one, then read it in page ranges (`-f 5 -l 9`).

## Reading and searching

- `pdftotext -layout` keeps columns and tables lined up; without it, prose flows better. `pdftotext in.pdf - | rg -n -i 'invoice'` finds a word (form feeds mark the pages).
- To see a page: `pdftoppm -png -r 110 -f 3 -l 3 -singlefile in.pdf page-3`, then open `page-3.png` (with `look` if your model can't see). Use `-r 200` for small print.
- Pictures in it: `pdfimages -list in.pdf`, then `pdfimages -png -f 2 -l 2 in.pdf pics/p2`.
- Words with their positions, in Python: `pdfplumber.open(path).pages[0].extract_words()` gives each word's `x0`, `x1`, `top` and `bottom` in points from the page's top left.

## Tables

```python
import pdfplumber, pandas as pd
with pdfplumber.open("in.pdf") as pdf:
    for i, page in enumerate(pdf.pages, 1):
        for j, t in enumerate(page.extract_tables(), 1):
            pd.DataFrame(t[1:], columns=t[0]).to_csv(f"in-p{i}-t{j}.csv", index=False)
```

A table without ruled lines needs `page.extract_tables({"vertical_strategy": "text", "horizontal_strategy": "text"})`. Compare the result with a picture of the page: merged cells and wrapped lines come out wrong, and the numbers must match. pandas then sums, sorts or joins them. Without pdfplumber (`python3 -c 'import pdfplumber'` fails), use `pdftotext -layout` and the picture.

## Scanned pages (OCR)

- `ocrmypdf -l eng --rotate-pages --deskew --sidecar out.txt in.pdf out.pdf` adds a text layer under the page images and writes the text to `out.txt`. `--skip-text` when some pages already have text, `--force-ocr` to redo bad text. It takes a few seconds a page, so run a long one as a background command.
- Languages: `eng`, `chi_sim` (Simplified Chinese), `chi_tra` (Traditional); `tesseract --list-langs` shows what this machine has. Name the document's own script first (`-l chi_tra+eng`): with the other first, it reads Traditional characters as Simplified. Tesseract puts spaces between Chinese characters; take them out when you quote it.
- One image: `tesseract page.png - -l eng`.
- Tesseract is reliable on clear typed pages and poor at handwriting, stamps, photos of paper and complicated tables. Read those pages by turning them into pictures and looking yourself. Say which pages you read that way, and check every figure against the picture: a model can misread a number and sound sure.

## Forms

```python
from pypdf import PdfReader, PdfWriter
for name, f in (PdfReader("form.pdf").get_fields() or {}).items():
    print(name, f.get("/FT"), f.get("/V"), f.get("/_States_", ""))
```

`/Tx` is text, `/Btn` a checkbox or radio (its value is one of its `/_States_`, such as `/Yes`), `/Ch` a choice. Fill it:

```python
w = PdfWriter(clone_from="form.pdf")
for page in w.pages:
    w.update_page_form_field_values(page, {"Name": "Ada Sample", "Agree": "/Yes"}, auto_regenerate=False)
w.set_need_appearances_writer(True)
w.write("form-filled.pdf")
```

Field names are often cryptic: match them to the labels on a picture of the page. A form with no fields gets the text written over the page: measure where with pdfplumber's words, draw it with reportlab on a canvas of the page's size (`y` counts from the bottom: `page.height - word["bottom"]`), and lay it over with pypdf's `page.merge_page(overlay.pages[0])`. Ask the person for any value you don't know, and never sign for them.

## Pages

- Merge: `qpdf --empty --pages a.pdf b.pdf -- both.pdf`
- Some pages: `qpdf in.pdf --pages . 1-3,7 -- part.pdf`; every page alone: `qpdf --split-pages in.pdf page-%d.pdf`
- Rotate pages 2 and 4: `qpdf in.pdf --rotate=+90:2,4 out.pdf`
- Repair a damaged file: `qpdf in.pdf repaired.pdf`; `qpdf --check in.pdf` says what is wrong.
- A file that opens but won't print or copy: `qpdf --decrypt in.pdf open.pdf`. One that needs a password to open: ask the person, and say that the password stays in the conversation; then pass it on standard input, not as an argument: `printf '%s' '…' | qpdf --password-file=- --decrypt in.pdf open.pdf`.

## Making a PDF

Write HTML with the page set in CSS (`@page { size: A4; margin: 20mm }`), then print it: `"$CHROME_PATH" --headless --no-sandbox --no-pdf-header-footer --print-to-pdf=out.pdf "file://$PWD/out.html"`. From Markdown: `pandoc in.md -s -o in.html` first. reportlab draws a page exactly, for overlays and labels. Chinese text needs a Chinese font, and `fc-list :lang=zh` shows none on most machines: say so rather than hand over boxes. Look at a picture of each new page before handing it over.

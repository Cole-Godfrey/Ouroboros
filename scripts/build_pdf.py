# /// script
# requires-python = ">=3.11"
# dependencies = ["reportlab>=4,<6", "svglib>=1.5,<3", "markdown-it-py>=3,<5"]
# ///
"""rebuild the system description PDF from its markdown and illustrations."""

from html import escape
from pathlib import Path
from urllib.parse import urljoin

from markdown_it import MarkdownIt
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from svglib.svglib import svg2rlg

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
WIDTH = A4[0] - 96
LINK_BASE = "https://github.com/Cole-Godfrey/Ouroboros/blob/main/docs/"
BODY = ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=14.5, spaceAfter=9, allowWidows=0, allowOrphans=0)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=8, leading=11, spaceAfter=0, splitLongWords=True)
HEADING = ParagraphStyle("heading", parent=BODY, fontName="Helvetica-Bold", fontSize=14, leading=18, spaceBefore=15, spaceAfter=8, keepWithNext=True)
TITLE = ParagraphStyle("title", parent=HEADING, fontSize=28, leading=34, alignment=1, spaceAfter=12)


def inline(tokens):
    """translate only markdown's inline markup into reportlab's paragraph markup."""
    out = []
    for token in tokens or []:
        kind = token.type
        if kind == "text":
            out.append(escape(token.content))
        elif kind == "code_inline":
            out.append(f'<font name="Courier" size="8">{escape(token.content)}</font>')
        elif kind in ("softbreak", "hardbreak"):
            out.append(" " if kind == "softbreak" else "<br/>")
        elif kind in ("strong_open", "strong_close", "em_open", "em_close"):
            tag = "b" if kind.startswith("strong") else "i"
            out.append(f'<{"/" if kind.endswith("close") else ""}{tag}>')
        elif kind == "link_open":
            href = escape(urljoin(LINK_BASE, token.attrGet("href")), quote=True)
            out.append(f'<link href="{href}" color="#12665b">')
        elif kind == "link_close":
            out.append("</link>")
    return "".join(out)


def illustration(src):
    """keep the diagrams as vectors and the snake artwork as a transparent bitmap."""
    file = DOCS / src
    if file.suffix == ".svg":
        drawing = svg2rlg(str(file))
        scale = min(WIDTH / drawing.width, 410 / drawing.height)
        drawing.scale(scale, scale)
        drawing.width *= scale
        drawing.height *= scale
        return drawing
    return Image(str(file), width=120, height=120, mask="auto")


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#d9e4df"))
    canvas.line(48, 40, A4[0] - 48, 40)
    canvas.setFillColor(colors.HexColor("#53645d"))
    canvas.setFont("Helvetica", 8)
    canvas.drawString(48, 27, "Ouroboros | System description")
    canvas.drawRightString(A4[0] - 48, 27, str(doc.page))
    canvas.restoreState()


def main():
    tokens = MarkdownIt("commonmark").enable("table").parse((DOCS / "SYSTEM.md").read_text())
    story = [illustration("img/ouroboros.png"), Spacer(1, 12), Paragraph("Ouroboros", TITLE), Paragraph("System description", ParagraphStyle("subtitle", parent=BODY, alignment=1, fontSize=13, spaceAfter=24))]
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.type == "heading_open":
            if token.tag != "h1":
                story.append(Paragraph(inline(tokens[index + 1].children), HEADING))
            index += 3
            continue
        if token.type == "paragraph_open":
            children = tokens[index + 1].children or []
            images = [child for child in children if child.type == "image"]
            if images:
                for child in images:
                    if "ouroboros.png" not in child.attrGet("src"):
                        story.extend([Spacer(1, 5), illustration(child.attrGet("src")), Spacer(1, 12)])
            else:
                story.append(Paragraph(inline(children), BODY))
            index += 3
            continue
        if token.type == "table_open":
            rows, row = [], []
            index += 1
            while tokens[index].type != "table_close":
                current = tokens[index]
                if current.type == "tr_open":
                    row = []
                elif current.type == "inline":
                    row.append(Paragraph(inline(current.children), CELL))
                elif current.type == "tr_close":
                    rows.append(row)
                index += 1
            # repeating headers keep long tables readable when they cross a page.
            table = Table(rows, colWidths=[WIDTH / len(rows[0])] * len(rows[0]), repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e5efea")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f9f8")]),
                ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#d9e4df")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]))
            story.extend([table, Spacer(1, 12)])
        index += 1
    output = DOCS / "Ouroboros-System-Description.pdf"
    doc = SimpleDocTemplate(str(output), pagesize=A4, rightMargin=48, leftMargin=48, topMargin=44, bottomMargin=54, title="Ouroboros: system description", author="Cole Godfrey")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(output)


if __name__ == "__main__":
    main()

"""Optional document utility: pip install reportlab, then pass --live after deployment."""
from argparse import ArgumentParser
from pathlib import Path
from urllib.parse import urlparse
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


parser = ArgumentParser(description="Create a one-page MailSignal submission PDF.")
parser.add_argument("--live", default="", help="Public HTTPS Vercel URL")
parser.add_argument("--repo", default="https://github.com/RenzyyyCursors/Emailer")
args = parser.parse_args()
for value in [args.live, args.repo]:
    if value:
        url = urlparse(value)
        if url.scheme != "https" or not url.netloc or url.username or url.password:
            parser.error("Links must be public HTTPS URLs without credentials.")

root = Path(__file__).resolve().parents[1]
out = root / "output" / "pdf"
out.mkdir(parents=True, exist_ok=True)
path = out / ("mailsignal-submission.pdf" if args.live else "mailsignal-submission-template.pdf")
c = canvas.Canvas(str(path), pagesize=A4)
c.setTitle("MailSignal - Internship Project" + ("" if args.live else " - Submission Template"))
c.setAuthor("MailSignal")
width, height = A4
green = colors.HexColor("#285b42")
muted = colors.HexColor("#718365")
line = colors.HexColor("#dfe7d8")
light = colors.HexColor("#f3f7ef")


def text(x, y, value, size=11, color=green, font="Helvetica"):
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, y, value)


def paragraph(value, x, top, max_width, size=10.5, leading=16, color=muted):
    style = ParagraphStyle("body", fontName="Helvetica", fontSize=size, leading=leading,
                           textColor=color, alignment=TA_LEFT)
    content = Paragraph(value, style)
    _, block_height = content.wrap(max_width, height)
    content.drawOn(c, x, top - block_height)
    return block_height


def box(x, y, w, h, fill=colors.white, stroke=line, radius=9):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.8)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


c.setFillColor(green)
c.rect(0, height - 12, width, 12, fill=1, stroke=0)
text(50, height - 58, "SHIELDNIX  /  SOFTWARE DEVELOPMENT INTERNSHIP", 9, muted, "Helvetica-Bold")
text(48, height - 121, "MailSignal.", 49, green, "Helvetica-Bold")
paragraph("Evidence-based email verification.<br/>Clear results. Honest uncertainty. No messages sent.", 50, height - 143, 470, 12, 19)
box(50, 625, 285, 28, light, light, 7)
text(63, 635, "NODE.JS   /   DNS OVER HTTPS   /   VERCEL", 9, green, "Helvetica-Bold")

banner_color = colors.HexColor("#f9f3e5") if not args.live else light
box(50, 560, width - 100, 48, banner_color, banner_color, 7)
text(64, 588, "LINKS READY" if args.live else "TEMPLATE - DEPLOYMENT PENDING", 9,
     green if args.live else colors.HexColor("#96732f"), "Helvetica-Bold")
text(64, 573, "Check both links before submitting." if args.live else "Add the live Vercel URL after deploying. Do not submit this template.", 9,
     green if args.live else colors.HexColor("#96732f"))

box(50, 460, width - 100, 82)
text(66, 520, "LIVE APPLICATION", 9, muted, "Helvetica-Bold")
if args.live:
    paragraph(escape(args.live), 66, 503, width - 132, 11, 15, green)
    c.linkURL(args.live, (65, 476, width - 65, 507), relative=0, thickness=0)
else:
    c.acroForm.textfield(name="live_url", tooltip="Paste your public Vercel URL after deployment",
                        x=65, y=480, width=width - 130, height=26, borderWidth=0.6,
                        borderColor=line, fillColor=light, textColor=green,
                        fontName="Helvetica", fontSize=10, value="", fieldFlags="")
    text(66, 468, "Editable field - or regenerate the PDF with --live after publishing.", 8, muted)

box(50, 363, width - 100, 78)
text(66, 419, "GITHUB REPOSITORY", 9, muted, "Helvetica-Bold")
paragraph(escape(args.repo), 66, 403, width - 132, 11, 15, green)
c.linkURL(args.repo, (65, 380, width - 65, 406), relative=0, thickness=0)

text(50, 329, "A small tool with considered engineering.", 15, green, "Helvetica-Bold")
paragraph("Paste up to 50 addresses, inspect the evidence for every result, search or filter the list, and export a spreadsheet-safe CSV. Includes a clearly labelled simulated demo.", 50, 311, width - 100, 10.5, 17)

chip_width = (width - 124) / 3
for index, (label, detail, color) in enumerate([
    ("LIKELY DELIVERED", "Recipient accepted locally", "#63884f"),
    ("LIKELY BOUNCE", "Specific negative evidence", "#ad625b"),
    ("UNKNOWN", "Not enough evidence", "#a18435"),
]):
    x = 50 + index * (chip_width + 12)
    box(x, 218, chip_width, 43, light, light, 7)
    text(x + 11, 244, label, 8, colors.HexColor(color), "Helvetica-Bold")
    text(x + 11, 229, detail, 8, muted)

text(50, 185, "HOSTING LIMITATION", 9, muted, "Helvetica-Bold")
paragraph("The Vercel version checks syntax and DNS mail routing. Outbound SMTP port 25 is blocked, so healthy routing stays <b>unknown</b>; DNS cannot prove a mailbox exists. Optional local SMTP checks are restricted to owned addresses and stop before DATA. Acceptance never guarantees delivery.", 50, 171, width - 100, 10, 16)

c.setStrokeColor(line)
c.line(50, 77, width - 50, 77)
paragraph("The README includes local setup, Vercel deployment steps, tests, privacy details, and verification limits.", 50, 64, width - 100, 8.5, 12)
c.showPage()
c.save()
print(path)

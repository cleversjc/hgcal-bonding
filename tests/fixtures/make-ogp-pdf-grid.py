"""Generate synthetic browser regression fixtures (pip install reportlab pillow)."""
from pathlib import Path
import sys

from PIL import Image, ImageDraw
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


def draw_text(pdf, x, y, size, text, emphasis=None, tail=""):
    pdf.setFont("Helvetica", size)
    pdf.drawString(x, y, text)
    if emphasis is not None:
        x += stringWidth(text, "Helvetica", size)
        pdf.setFont("Helvetica-Bold", size)
        pdf.drawString(x, y, emphasis)
        x += stringWidth(emphasis, "Helvetica-Bold", size)
        pdf.setFont("Helvetica", size)
        pdf.drawString(x, y, tail)


def make(path, labels, split=False, bad=False):
    pdf = canvas.Canvas(str(path), pagesize=(650, 620))
    heading, module = "HGCal YOLO Leakage Report - ", "320TEST00000001"
    if split:
        draw_text(pdf, 25, 596, 14, heading, module)
    else:
        draw_text(pdf, 25, 596, 14, heading + module)
    for index, label in enumerate(labels):
        x, y = 25 + index * 152, 480
        if not bad or index == 0:
            image = Image.new("RGB", (80, 60), (140 + 8 * index, 150, 200))
            ImageDraw.Draw(image).rectangle((20, 20, 40, 40), outline=(255, 0, 0), width=3)
            pdf.drawImage(ImageReader(image), x, y, width=120, height=90)
        if split:
            draw_text(pdf, x, y - 12, 10, "cell ", label, " conf 0.52")
        else:
            draw_text(pdf, x, y - 12, 10, f"cell {label} conf 0.52")
    pdf.showPage()
    pdf.save()


out = Path(sys.argv[1])
make(out / "old.pdf", ["3", "28", "13"])
make(out / "new.pdf", ["M", "N", "C3", "C28"], split=True)
make(out / "c143.pdf", ["143"])
make(out / "c142-c143.pdf", ["142", "143"])
make(out / "bad.pdf", ["M", "N"], bad=True)

# Match the reported failure: the first letter caption is on page 2 of 6.
pdf = canvas.Canvas(str(out / "letter-on-page-2.pdf"), pagesize=(650, 620))
tile = Image.new("RGB", (80, 60), (140, 150, 200))
ImageDraw.Draw(tile).rectangle((20, 20, 40, 40), outline=(255, 0, 0), width=3)
for page, label in enumerate(["20", "M", "21", "22", "23", "24"], 1):
    draw_text(pdf, 25, 596, 14, f"HGCal YOLO Leakage Report - 320TEST0000000{page}")
    pdf.drawImage(ImageReader(tile), 25, 480, width=120, height=90)
    draw_text(pdf, 25, 468, 10, f"cell {label} conf 0.49")
    pdf.showPage()
pdf.save()

if '--large' in sys.argv:
    from io import BytesIO
    from random import Random

    def with_large_images(path, page_count):
        rng = Random(791)
        pdf = canvas.Canvas(str(path), pagesize=(650, 620))
        for page in range(page_count):
            draw_text(pdf, 25, 596, 14, f"HGCal YOLO Leakage Report - 320TEST{page + 1:08d}")
            for index, label in enumerate(('M', 'N', '3', '21', '22')):
                x, y = 25 + index % 3 * 197, 430 - index // 3 * 152
                image = Image.frombytes('RGB', (1024, 768), rng.randbytes(1024 * 768 * 3))
                ImageDraw.Draw(image).rectangle((75, 75, 300, 300), outline=(255, 0, 0), width=6)
                jpeg = BytesIO()
                image.save(jpeg, 'JPEG', quality=72)
                jpeg.seek(0)
                pdf.drawImage(ImageReader(jpeg), x, y, width=128, height=96)
                draw_text(pdf, x, y - 12, 10, f'cell {label} conf 0.49')
            pdf.showPage()
        pdf.save()

    with_large_images(out / 'above-old-limit.pdf', 6)
    with_large_images(out / 'above-new-limit.pdf', 10)

import io

import pytest
from PIL import Image, ImageDraw, ImageFont

from kitty_ai.receipts.ocr import RapidOcr, order_lines


def test_order_lines_reads_top_to_bottom_then_left_to_right():
    # (box corners, text): "TOTAL" sits on the same line as "120,00", lower than "Burger".
    boxes = [
        ([[200, 52], [260, 52], [260, 68], [200, 68]], "120,00"),
        ([[10, 10], [80, 10], [80, 26], [10, 26]], "Burger"),
        ([[10, 50], [70, 50], [70, 70], [10, 70]], "TOTAL"),
        ([[200, 12], [260, 12], [260, 24], [200, 24]], "120,00"),
    ]
    assert order_lines(boxes) == "Burger 120,00\nTOTAL 120,00"


def render(text: str) -> bytes:
    image = Image.new("RGB", (640, 220), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=36)
    draw.multiline_text((30, 30), text, fill="black", font=font, spacing=24)
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=95)
    return out.getvalue()


@pytest.mark.slow
def test_rapidocr_reads_rendered_receipt():
    text = RapidOcr().read(render("Burger      120,00\nTOTAL       120,00"))
    assert "Burger" in text
    assert "120" in text
    assert "TOTAL" in text.upper()


@pytest.mark.slow
def test_blank_image_reads_as_empty():
    image = Image.new("RGB", (320, 200), "white")
    out = io.BytesIO()
    image.save(out, format="PNG")
    assert RapidOcr().read(out.getvalue()) == ""

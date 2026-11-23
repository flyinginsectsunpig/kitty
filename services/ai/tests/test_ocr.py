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


def png_header(width: int, height: int) -> bytes:
    """Just a PNG signature and IHDR: enough for PIL to report a size without any pixels."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b"")


def test_decompression_bombs_are_refused_from_the_header():
    from kitty_ai.receipts.ocr import ImageTooLarge, prepare_image

    with pytest.raises(ImageTooLarge):
        prepare_image(png_header(30_000, 20_000))  # 600 megapixels in a few bytes


def test_big_photos_are_scaled_down_before_ocr():
    from kitty_ai.receipts.ocr import MAX_SIDE, prepare_image

    big = Image.new("RGB", (5000, 3000), "white")
    out = io.BytesIO()
    big.save(out, format="JPEG")
    prepared = Image.open(io.BytesIO(prepare_image(out.getvalue())))
    assert max(prepared.size) == MAX_SIDE


def test_ordinary_photos_pass_through_untouched():
    from kitty_ai.receipts.ocr import prepare_image

    data = render("Burger 120,00")
    assert prepare_image(data) == data

"""Reads text from a receipt photo on this machine (the image never leaves it). RapidOCR runs PaddleOCR's own
models through ONNX Runtime, which has ARM builds (the production VM is ARM) and needs far less memory."""

import io
from typing import Protocol

from PIL import Image

Box = list[list[float]]

# Receipts are read fine at 4000 px on the long side (a 12 MP phone photo); bigger ones are scaled down first.
MAX_SIDE = 4000
# A small file can claim a huge image (a decompression bomb); anything this big is refused unread.
MAX_PIXELS = 100_000_000


class ImageTooLarge(Exception):
    """The image claims more pixels than any receipt photo has."""


def prepare_image(image: bytes) -> bytes:
    """Checks the size from the header (no pixels decoded), then scales big photos down. Small ones pass as-is."""
    try:
        probe = Image.open(io.BytesIO(image))
    except Image.DecompressionBombError as e:  # Pillow's own, stricter-than-ours ceiling
        raise ImageTooLarge(str(e)) from e
    with probe:
        width, height = probe.size
        if width * height > MAX_PIXELS:
            raise ImageTooLarge(f"{width}x{height}")
        if max(width, height) <= MAX_SIDE:
            return image
        probe.thumbnail((MAX_SIDE, MAX_SIDE))
        out = io.BytesIO()
        probe.convert("RGB").save(out, format="JPEG", quality=90)
        return out.getvalue()


class Ocr(Protocol):
    def read(self, image: bytes) -> str: ...


def order_lines(boxes: list[tuple[Box, str]]) -> str:
    """Joins recognised text boxes into lines: top to bottom, and left to right within a line. Two boxes share
    a line when their vertical centres are closer than half the taller box's height (receipt columns)."""
    placed = sorted(
        (
            (sum(p[1] for p in box) / 4, min(p[0] for p in box), max(p[1] for p in box) - min(p[1] for p in box), text)
            for box, text in boxes
            if text.strip()
        ),
    )
    lines: list[list[tuple[float, str]]] = []
    centres: list[float] = []
    for centre, left, height, text in placed:
        if lines and abs(centre - centres[-1]) < max(height, 1) / 2:
            lines[-1].append((left, text))
        else:
            lines.append([(left, text)])
            centres.append(centre)
    return "\n".join(" ".join(t for _, t in sorted(line)) for line in lines)


class RapidOcr:
    def __init__(self):
        from rapidocr import RapidOCR  # loads the models: keep it out of import time

        self._engine = RapidOCR()

    def read(self, image: bytes) -> str:
        result = self._engine(prepare_image(image))
        if result is None or result.boxes is None or result.txts is None:
            return ""
        return order_lines([(box.tolist(), text) for box, text in zip(result.boxes, result.txts, strict=True)])

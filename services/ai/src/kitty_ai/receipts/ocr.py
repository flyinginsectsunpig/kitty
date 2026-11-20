"""Reads text from a receipt photo on this machine (the image never leaves it). RapidOCR runs PaddleOCR's own
models through ONNX Runtime, which has ARM builds (the production VM is ARM) and needs far less memory."""

from typing import Protocol

Box = list[list[float]]


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
        result = self._engine(image)
        if result is None or result.boxes is None or result.txts is None:
            return ""
        return order_lines([(box.tolist(), text) for box, text in zip(result.boxes, result.txts, strict=True)])

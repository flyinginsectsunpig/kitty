"""The ai service process: a small HTTP app (health now; natural-language entry and Ask Kitty in phase 4) that
runs the receipt worker in the background when Kafka is configured.
Run with: uvicorn kitty_ai.main:create_app --factory"""

import logging
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from kitty_ai.receipts.extract import extractor_from
from kitty_ai.receipts.worker import Worker
from kitty_ai.settings import Settings


def _real_worker(settings: Settings) -> Worker:
    from kitty_ai.receipts.ocr import RapidOcr  # loads the OCR models

    return Worker(settings, RapidOcr(), extractor_from(settings))


def create_app(settings: Settings | None = None, make_worker: Callable[[Settings], Worker] = _real_worker) -> FastAPI:
    settings = settings or Settings()
    state: dict[str, Worker | None] = {"worker": None}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if settings.kafka_bootstrap:
            worker = make_worker(settings)
            worker.start()
            state["worker"] = worker
        try:
            yield
        finally:
            if state["worker"]:
                state["worker"].stop()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = FastAPI(title="Kitty AI", lifespan=lifespan)

    @app.get("/health")
    def health() -> JSONResponse:
        worker = state["worker"]
        if worker is not None and not worker.running:
            return JSONResponse({"status": "degraded", "worker": "stopped"}, status_code=503)
        return JSONResponse({"status": "ok", "worker": "off" if worker is None else "running"})

    return app

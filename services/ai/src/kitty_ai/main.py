"""The ai service process: a small HTTP app (health; plain-language entry when a Keycloak issuer is configured) that
runs the receipt worker in the background when Kafka is configured.
Run with: uvicorn kitty_ai.main:create_app --factory"""

import logging
from collections.abc import Callable
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from kitty_ai.ask.models import chat_from
from kitty_ai.ask.routes import make_ask_router
from kitty_ai.auth import TokenVerifier, jwks_fetcher
from kitty_ai.entry.parse import parser_from
from kitty_ai.entry.routes import make_router
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
    # httpx logs every request URL at INFO (and httpcore at DEBUG); /ask lookups carry the question's search text
    # in the query string, which must never reach the logs.
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    app = FastAPI(title="Kitty AI", lifespan=lifespan)

    @app.get("/health")
    def health() -> JSONResponse:
        worker = state["worker"]
        if worker is not None and not worker.running:
            return JSONResponse({"status": "degraded", "worker": "stopped"}, status_code=503)
        return JSONResponse({"status": "ok", "worker": "off" if worker is None else "running"})

    if settings.auth_issuer:
        # Plain-language entry (/parse, /resolve) and Ask Kitty (/ask): Caddy serves these under /ai/.
        # Keys are fetched on first use.
        http = httpx.Client(timeout=15)
        verifier = TokenVerifier(settings.auth_issuer, settings.auth_audience, jwks_fetcher(settings.auth_issuer, http))
        app.include_router(make_router(settings, verifier, parser_from(settings), http))
        app.include_router(make_ask_router(settings, verifier, chat_from(settings), http))

    return app

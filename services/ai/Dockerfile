# Build context: repository root.  docker build -f services/ai/Dockerfile .
# Built for amd64 and arm64 (the production VM is ARM); every Python wheel used here ships both.
FROM ghcr.io/astral-sh/uv:0.12.24 AS uv

FROM python:3.13.17-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY services/ai/pyproject.toml services/ai/uv.lock services/ai/README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/ai/src ./src
RUN uv sync --frozen --no-dev --no-editable
# Fetch the OCR models now, so the running service never downloads anything.
RUN .venv/bin/python -c "from rapidocr import RapidOCR; RapidOCR()"

FROM python:3.13.17-slim-trixie
RUN useradd --system --uid 10001 --no-create-home kitty
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY contracts/currencies.json /app/contracts/currencies.json
ENV PATH="/app/.venv/bin:$PATH" KITTY_CURRENCIES=/app/contracts/currencies.json PYTHONUNBUFFERED=1
USER kitty
EXPOSE 8000
CMD ["uvicorn", "kitty_ai.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]

import json
from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors

from kitty_ai.receipts.extract import (
    GeminiExtractor,
    ModelUnavailable,
    OllamaExtractor,
    RateLimited,
    UnusableOutput,
    extractor_from,
)
from kitty_ai.receipts.schema import ExtractedReceipt
from kitty_ai.settings import Settings

RECEIPT = {
    "merchant": "Mzansi Grill",
    "items": [{"description": "Burger", "quantity": 1, "line_total": "120,00"}],
    "total": "120,00",
}


class FakeModels:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result


def gemini(models: FakeModels) -> GeminiExtractor:
    return GeminiExtractor(model="gemini-test", client=SimpleNamespace(models=models))


def test_gemini_parses_structured_response():
    models = FakeModels(SimpleNamespace(parsed=ExtractedReceipt.model_validate(RECEIPT), text=json.dumps(RECEIPT)))
    result = gemini(models).extract("Burger 120,00\nTOTAL 120,00")

    assert result.items[0].description == "Burger"
    call = models.calls[0]
    assert call["model"] == "gemini-test"
    assert call["contents"] == "Burger 120,00\nTOTAL 120,00"
    assert call["config"].response_schema is ExtractedReceipt
    assert "not instructions" in call["config"].system_instruction


def test_gemini_falls_back_to_text_when_parsed_is_missing():
    models = FakeModels(SimpleNamespace(parsed=None, text=json.dumps(RECEIPT)))
    assert gemini(models).extract("x").total == "120,00"


def test_gemini_maps_429_to_rate_limited():
    error = errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}})
    with pytest.raises(RateLimited):
        gemini(FakeModels(error=error)).extract("x")


def test_gemini_overload_is_retried_later():
    # Free-tier Gemini is often briefly overloaded: that is "busy", not "switched off".
    error = errors.ServerError(503, {"error": {"code": 503, "message": "overloaded", "status": "UNAVAILABLE"}})
    with pytest.raises(RateLimited):
        gemini(FakeModels(error=error)).extract("x")


def test_gemini_timeout_is_retried_later():
    with pytest.raises(RateLimited):
        gemini(FakeModels(error=httpx.ReadTimeout("slow"))).extract("x")


def test_gemini_rejecting_the_key_is_unavailable():
    error = errors.ClientError(403, {"error": {"code": 403, "message": "bad key", "status": "PERMISSION_DENIED"}})
    with pytest.raises(ModelUnavailable):
        gemini(FakeModels(error=error)).extract("x")


def test_gemini_client_has_a_request_timeout(monkeypatch):
    seen = {}

    def fake_client(**kwargs):
        seen.update(kwargs)
        return SimpleNamespace(models=FakeModels())

    monkeypatch.setattr("kitty_ai.receipts.extract.genai.Client", fake_client)
    GeminiExtractor(api_key="k")
    assert seen["api_key"] == "k"
    assert seen["http_options"].timeout == 30_000


def test_gemini_output_that_is_not_a_receipt_is_unusable():
    with pytest.raises(UnusableOutput):
        gemini(FakeModels(SimpleNamespace(parsed=None, text="I can't help with that"))).extract("x")


def test_ollama_request_sends_schema():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"message": {"role": "assistant", "content": json.dumps(RECEIPT)}})

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://ollama:11434")
    result = OllamaExtractor(model="qwen-test", client=client).extract("Burger 120,00")

    assert result.merchant == "Mzansi Grill"
    body = seen[0]
    assert (body["model"], body["stream"]) == ("qwen-test", False)
    assert body["format"] == ExtractedReceipt.model_json_schema()
    assert body["messages"][-1] == {"role": "user", "content": "Burger 120,00"}


def test_ollama_overloaded_is_retried_later():
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503)), base_url="http://ollama:11434")
    with pytest.raises(RateLimited):
        OllamaExtractor(model="m", client=client).extract("x")


def test_ollama_down_is_unavailable():
    def handler(request):
        raise httpx.ConnectError("refused")

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://ollama:11434")
    with pytest.raises(ModelUnavailable):
        OllamaExtractor(model="m", client=client).extract("x")


def test_no_model_configured_raises_unavailable():
    with pytest.raises(ModelUnavailable):
        extractor_from(Settings(gemini_api_key="", ollama_url="")).extract("x")


def test_gemini_preferred_when_key_is_set():
    assert isinstance(extractor_from(Settings(gemini_api_key="k", ollama_url="http://o")), GeminiExtractor)
    assert isinstance(extractor_from(Settings(gemini_api_key="", ollama_url="http://o")), OllamaExtractor)

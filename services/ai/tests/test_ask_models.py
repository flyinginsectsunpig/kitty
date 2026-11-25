import json
from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors, types

from kitty_ai.ask.agent import Called, Message, ModelTurn, Result, ToolCall
from kitty_ai.ask.models import GeminiChat, NoChat, OllamaChat, chat_from
from kitty_ai.ask.tools import TOOLS
from kitty_ai.receipts.extract import ModelUnavailable, RateLimited
from kitty_ai.settings import Settings

OWING = {"iOwe": [{"currency": "ZAR", "minor": 12000, "text": "R 120,00"}]}
OWE_CALL = ToolCall("what_i_owe", {}, "call-1", b"sig")
STEPS = [
    Message("person", "How much do I owe Joe?"),
    Message("kitty", "You owe Joe R 25,00."),
    Message("person", "And in total?"),
    Called(OWE_CALL),
    Result(OWE_CALL, OWING),
]


class FakeModels:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result


def gemini(models):
    return GeminiChat(model="gemini-test", client=SimpleNamespace(models=models))


def response(*parts: types.Part) -> types.GenerateContentResponse:
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=list(parts)))]
    )


def test_gemini_sends_tools_with_auto_calling_off():
    models = FakeModels(response(types.Part(text="R 120,00")))

    gemini(models).turn("SYSTEM", STEPS, TOOLS)

    [sent] = models.calls
    config = sent["config"]
    assert config.system_instruction == "SYSTEM"
    assert config.automatic_function_calling.disable is True
    [tool] = config.tools
    assert [d.name for d in tool.function_declarations] == [t.name for t in TOOLS]
    assert tool.function_declarations[2].parameters_json_schema == TOOLS[2].parameters
    roles = [c.role for c in sent["contents"]]
    assert roles == ["user", "model", "user", "model", "user"]
    call_part = sent["contents"][3].parts[0]
    assert (call_part.function_call.name, call_part.function_call.id, call_part.thought_signature) == (
        "what_i_owe",
        "call-1",
        b"sig",
    )
    result_part = sent["contents"][4].parts[0]
    assert (result_part.function_response.name, result_part.function_response.response) == ("what_i_owe", OWING)


def test_gemini_without_tools_sends_none():
    models = FakeModels(response(types.Part(text="Answer")))
    gemini(models).turn("SYSTEM", STEPS[:1], None)
    assert models.calls[0]["config"].tools is None


def test_gemini_maps_function_calls_and_text():
    models = FakeModels(
        response(
            types.Part(text="Let me look.", thought=True),
            types.Part(
                function_call=types.FunctionCall(name="group_spending", args={"group_id": "g1"}, id="c9"),
                thought_signature=b"s9",
            ),
        )
    )
    assert gemini(models).turn("SYSTEM", STEPS[:1], TOOLS) == ModelTurn(
        None, [ToolCall("group_spending", {"group_id": "g1"}, "c9", b"s9")]
    )

    models = FakeModels(response(types.Part(text="You owe "), types.Part(text="R 120,00.")))
    assert gemini(models).turn("SYSTEM", STEPS[:1], TOOLS) == ModelTurn("You owe R 120,00.", [])


def test_gemini_429_is_rate_limited():
    models = FakeModels(error=errors.APIError(429, {"error": {"message": "slow down"}}))
    with pytest.raises(RateLimited):
        gemini(models).turn("SYSTEM", STEPS[:1], TOOLS)


def test_gemini_bad_key_is_unavailable():
    models = FakeModels(error=errors.APIError(403, {"error": {"message": "no"}}))
    with pytest.raises(ModelUnavailable):
        gemini(models).turn("SYSTEM", STEPS[:1], TOOLS)


def test_ollama_maps_tool_calls():
    sent: list[dict] = []

    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"function": {"name": "group_spending", "arguments": {"group_id": "g1"}}}],
                }
            },
        )

    chat = OllamaChat(
        model="qwen-test", client=httpx.Client(base_url="http://ollama", transport=httpx.MockTransport(handle))
    )

    assert chat.turn("SYSTEM", STEPS, TOOLS) == ModelTurn(None, [ToolCall("group_spending", {"group_id": "g1"}, None)])

    [body] = sent
    assert [m["role"] for m in body["messages"]] == ["system", "user", "assistant", "user", "assistant", "tool"]
    assert body["messages"][4]["tool_calls"] == [{"function": {"name": "what_i_owe", "arguments": {}}}]
    assert json.loads(body["messages"][5]["content"]) == OWING
    assert [t["function"]["name"] for t in body["tools"]] == [t.name for t in TOOLS]


def test_ollama_text_answer_and_no_tools():
    sent: list[dict] = []

    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"message": {"role": "assistant", "content": "R 120,00"}})

    chat = OllamaChat(
        model="qwen-test", client=httpx.Client(base_url="http://ollama", transport=httpx.MockTransport(handle))
    )

    assert chat.turn("SYSTEM", STEPS[:1], None) == ModelTurn("R 120,00", [])
    assert "tools" not in sent[0]


def test_no_chat_is_unavailable():
    with pytest.raises(ModelUnavailable):
        NoChat().turn("SYSTEM", STEPS[:1], TOOLS)
    assert isinstance(chat_from(Settings(gemini_api_key="", ollama_url="")), NoChat)

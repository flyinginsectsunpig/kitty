"""The question loop's models: Gemini (function declarations, its automatic calling off: the loop is ours) or a local
Ollama (/api/chat with tools). Failures map as in 4a: throttled or down is RateLimited, misconfigured is
ModelUnavailable."""

import json

import httpx
from google import genai
from google.genai import errors, types

from kitty_ai.ask.agent import Called, ChatModel, Message, ModelTurn, Result, Step, ToolCall
from kitty_ai.ask.tools import ToolSpec
from kitty_ai.receipts.extract import ModelUnavailable, RateLimited
from kitty_ai.settings import DEFAULT_GEMINI_MODEL, Settings


def _gemini_contents(steps: list[Step]) -> list[types.Content]:
    contents: list[types.Content] = []

    def add(role: str, part: types.Part, merge: bool) -> None:
        if merge and contents and contents[-1].role == role:
            contents[-1].parts.append(part)
        else:
            contents.append(types.Content(role=role, parts=[part]))

    previous: type | None = None
    for step in steps:
        match step:
            case Message(role=role, text=text):
                add("user" if role == "person" else "model", types.Part(text=text), merge=False)
            case Called(call=c):
                part = types.Part(
                    function_call=types.FunctionCall(name=c.name, args=c.args, id=c.id), thought_signature=c.signature
                )
                add("model", part, merge=previous is Called)
            case Result(call=c, result=result):
                part = types.Part(function_response=types.FunctionResponse(name=c.name, id=c.id, response=result))
                add("user", part, merge=previous is Result)
        previous = type(step)
    return contents


class GeminiChat:
    # A stalled request must not hold the person waiting forever (the client's own default is no timeout).
    TIMEOUT_MS = 30_000

    def __init__(self, api_key: str = "", model: str = DEFAULT_GEMINI_MODEL, client=None):
        self._client = client or genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=self.TIMEOUT_MS))
        self._model = model

    def turn(self, system: str, steps: list[Step], tools: list[ToolSpec] | None) -> ModelTurn:
        declared = (
            [
                types.Tool(
                    function_declarations=[
                        types.FunctionDeclaration(
                            name=t.name, description=t.description, parameters_json_schema=t.parameters
                        )
                        for t in tools
                    ]
                )
            ]
            if tools
            else None
        )
        try:
            response = self._client.models.generate_content(
                model=self._model,
                contents=_gemini_contents(steps),
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    tools=declared,
                    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                    temperature=0,
                ),
            )
        except errors.APIError as e:
            if e.code == 429 or e.code >= 500:  # throttled or overloaded: busy, not switched off
                raise RateLimited(str(e)) from e
            raise ModelUnavailable(str(e)) from e
        except httpx.TimeoutException as e:
            raise RateLimited(str(e)) from e

        parts = (
            (response.candidates[0].content.parts or [])
            if response.candidates and response.candidates[0].content
            else []
        )
        calls = [
            ToolCall(
                p.function_call.name or "", dict(p.function_call.args or {}), p.function_call.id, p.thought_signature
            )
            for p in parts
            if p.function_call
        ]
        text = "".join(p.text for p in parts if p.text and not p.thought and not p.function_call)
        return ModelTurn(text or None, calls)


def _ollama_messages(system: str, steps: list[Step]) -> list[dict]:
    messages: list[dict] = [{"role": "system", "content": system}]
    previous: type | None = None
    for step in steps:
        match step:
            case Message(role=role, text=text):
                messages.append({"role": "user" if role == "person" else "assistant", "content": text})
            case Called(call=c):
                call = {"function": {"name": c.name, "arguments": c.args}}
                if previous is Called:
                    messages[-1]["tool_calls"].append(call)
                else:
                    messages.append({"role": "assistant", "content": "", "tool_calls": [call]})
            case Result(call=c, result=result):
                messages.append({"role": "tool", "tool_name": c.name, "content": json.dumps(result)})
        previous = type(step)
    return messages


class OllamaChat:
    def __init__(self, base_url: str = "", model: str = "qwen2.5:3b", client: httpx.Client | None = None):
        self._client = client or httpx.Client(base_url=base_url, timeout=120)
        self._model = model

    def turn(self, system: str, steps: list[Step], tools: list[ToolSpec] | None) -> ModelTurn:
        body: dict = {
            "model": self._model,
            "stream": False,
            "options": {"temperature": 0},
            "messages": _ollama_messages(system, steps),
        }
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {"name": t.name, "description": t.description, "parameters": t.parameters},
                }
                for t in tools
            ]
        try:
            response = self._client.post("/api/chat", json=body)
        except httpx.TimeoutException as e:
            raise RateLimited(str(e)) from e
        except httpx.HTTPError as e:
            raise ModelUnavailable(str(e)) from e
        if response.status_code == 429 or response.status_code >= 500:
            raise RateLimited(response.text[:200])
        if response.is_error:
            raise ModelUnavailable(f"{response.status_code}: {response.text[:200]}")

        message = response.json().get("message", {})
        calls = []
        for c in message.get("tool_calls") or []:
            fn = c.get("function", {})
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {"_unreadable": args}  # the tool rejects it as bad_arguments
            calls.append(ToolCall(fn.get("name", ""), args if isinstance(args, dict) else {}, None))
        return ModelTurn(message.get("content") or None, calls)


class NoChat:
    def turn(self, system: str, steps: list[Step], tools: list[ToolSpec] | None) -> ModelTurn:
        raise ModelUnavailable("No model configured (set AI_GEMINI_API_KEY or AI_OLLAMA_URL).")


def chat_from(settings: Settings) -> ChatModel:
    if settings.gemini_api_key:
        return GeminiChat(settings.gemini_api_key, settings.gemini_model)
    if settings.ollama_url:
        return OllamaChat(settings.ollama_url, settings.ollama_model)
    return NoChat()

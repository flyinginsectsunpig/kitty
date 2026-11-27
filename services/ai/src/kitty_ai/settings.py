import psycopg.conninfo
from pydantic_settings import BaseSettings, SettingsConfigDict

_DOTNET_KEYS = {
    "host": "host",
    "server": "host",
    "port": "port",
    "username": "user",
    "user id": "user",
    "password": "password",
    "database": "dbname",
}


def postgres_conninfo(dsn: str) -> str:
    """Accepts a libpq string (URI or key=value) or the .NET style Aspire hands out (Host=..;Username=..)."""
    if ";" not in dsn:
        return dsn
    pairs = (part.split("=", 1) for part in dsn.split(";") if "=" in part)
    known = {_DOTNET_KEYS[k.strip().lower()]: v for k, v in pairs if k.strip().lower() in _DOTNET_KEYS}
    return psycopg.conninfo.make_conninfo(**known)


DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"


class Settings(BaseSettings):
    """Configuration from AI_* environment variables."""

    model_config = SettingsConfigDict(env_prefix="AI_")

    kafka_bootstrap: str = ""
    # Plain-language entry: the ledger's internal address, and the Keycloak realm whose tokens (for audience kitty-ai)
    # the /parse and /resolve endpoints accept. Without an issuer those endpoints are off.
    ledger_url: str = ""
    auth_issuer: str = ""
    auth_audience: str = "kitty-ai"
    schema_registry_url: str = ""
    blob_connection_string: str = ""
    postgres_dsn: str = ""
    # Gemini (free tier) when a key is set; otherwise a local Ollama if configured; otherwise scans fail fast.
    gemini_api_key: str = ""
    # A pinned model (the Gemini API has no "-latest" Flash alias): Flash Lite is the free tier's only model with room
    # for real use (15 requests a minute, 500 a day; full Flash models get 20 a day). The receipt evals list the models
    # the key can use, which shows when this one is retired. Override with AI_GEMINI_MODEL.
    gemini_model: str = DEFAULT_GEMINI_MODEL
    ollama_url: str = ""
    ollama_model: str = "qwen2.5:3b"
    consumer_group: str = "ai-receipts"
    # MCP (phase 4d): off without a public URL. Locally http://localhost:5085/mcp; deployed https://{host}/ai/mcp.
    # Tokens for it carry audience mcp_audience; the ai service swaps them at Keycloak for a ledger token, as the
    # confidential client of the same name (mcp_client_secret). web_url is the start of the draft links.
    mcp_public_url: str = ""
    mcp_audience: str = "kitty-mcp"
    mcp_client_secret: str = ""
    web_url: str = ""

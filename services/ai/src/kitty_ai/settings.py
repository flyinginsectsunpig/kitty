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


DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"


class Settings(BaseSettings):
    """Configuration from AI_* environment variables."""

    model_config = SettingsConfigDict(env_prefix="AI_")

    kafka_bootstrap: str = ""
    schema_registry_url: str = ""
    blob_connection_string: str = ""
    postgres_dsn: str = ""
    # Gemini (free tier) when a key is set; otherwise a local Ollama if configured; otherwise scans fail fast.
    gemini_api_key: str = ""
    # A pinned model (the Gemini API has no "-latest" Flash alias): the receipt evals list the models the key can use,
    # which shows when this one is retired. Override with AI_GEMINI_MODEL.
    gemini_model: str = DEFAULT_GEMINI_MODEL
    ollama_url: str = ""
    ollama_model: str = "qwen2.5:3b"
    consumer_group: str = "ai-receipts"

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration from AI_* environment variables."""

    model_config = SettingsConfigDict(env_prefix="AI_")

    kafka_bootstrap: str = ""
    schema_registry_url: str = ""
    blob_connection_string: str = ""
    postgres_dsn: str = ""
    # Gemini (free tier) when a key is set; otherwise a local Ollama if configured; otherwise scans fail fast.
    gemini_api_key: str = ""
    # Google's alias for its current Flash model, so a retired model name never breaks scanning.
    gemini_model: str = "gemini-flash-latest"
    ollama_url: str = ""
    ollama_model: str = "qwen2.5:3b"

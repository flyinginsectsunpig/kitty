"""OAuth Protected Resource Metadata (RFC 9728) for /mcp: tells an assistant which Keycloak realm to sign in with.
An unauthenticated call to /mcp points here (see auth.McpAuth)."""

from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from kitty_ai.settings import Settings

WELL_KNOWN = "/.well-known/oauth-protected-resource"


def protected_resource(settings: Settings) -> dict:
    return {
        "resource": settings.mcp_public_url,
        "authorization_servers": [settings.auth_issuer],
        "scopes_supported": [settings.mcp_audience],
        "bearer_methods_supported": ["header"],
        "resource_name": "Kitty",
    }


def metadata_url(settings: Settings) -> str:
    """RFC 9728 §3.1: the well-known path goes between the host and the resource's path."""
    url = urlsplit(settings.mcp_public_url)
    return f"{url.scheme}://{url.netloc}{WELL_KNOWN}{url.path.rstrip('/')}"


def make_metadata_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.get(WELL_KNOWN)
    @router.get(WELL_KNOWN + "/{rest:path}")
    def metadata(rest: str = "") -> JSONResponse:
        return JSONResponse(protected_resource(settings))

    return router

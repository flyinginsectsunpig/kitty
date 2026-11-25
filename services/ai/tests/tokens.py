"""Signs test access tokens with a throwaway RSA key, and serves its JWKS, like Keycloak does."""

import json
import time
import uuid

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

ISSUER = "http://keycloak.test/realms/kitty"


class TestIssuer:
    __test__ = False  # not a test class

    def __init__(self, kid: str = "k1"):
        self.kid = kid
        self._key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.jwks_fetches = 0

    def jwks(self) -> dict:
        self.jwks_fetches += 1
        public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self._key.public_key()))
        return {"keys": [{**public, "kid": self.kid, "use": "sig", "alg": "RS256"}]}

    def token(
        self, sub: str | None = None, aud="kitty-ai", exp_in: int = 300, iss: str = ISSUER, kid: str | None = None
    ) -> str:
        now = int(time.time())
        claims = {"sub": sub or str(uuid.uuid4()), "aud": aud, "iss": iss, "iat": now, "exp": now + exp_in}
        return jwt.encode(claims, self._key, algorithm="RS256", headers={"kid": kid or self.kid})

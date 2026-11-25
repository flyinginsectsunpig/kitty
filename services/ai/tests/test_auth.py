import pytest

from kitty_ai.auth import TokenVerifier, Unauthorized
from tests.tokens import ISSUER, TestIssuer


def test_valid_token_gives_the_caller():
    keys = TestIssuer()
    token = keys.token(sub="user-1", aud=["kitty-ledger", "kitty-ai"])
    caller = TokenVerifier(ISSUER, "kitty-ai", keys.jwks).verify(token)
    assert (caller.sub, caller.token) == ("user-1", token)


def test_wrong_audience_is_401():
    keys = TestIssuer()
    with pytest.raises(Unauthorized):
        TokenVerifier(ISSUER, "kitty-ai", keys.jwks).verify(keys.token(aud="kitty-ledger"))


def test_expired_is_401():
    keys = TestIssuer()
    with pytest.raises(Unauthorized):
        TokenVerifier(ISSUER, "kitty-ai", keys.jwks).verify(keys.token(exp_in=-120))


def test_another_issuer_is_401():
    keys = TestIssuer()
    with pytest.raises(Unauthorized):
        TokenVerifier(ISSUER, "kitty-ai", keys.jwks).verify(keys.token(iss="http://evil.test/realms/kitty"))


def test_garbage_is_401():
    with pytest.raises(Unauthorized):
        TokenVerifier(ISSUER, "kitty-ai", TestIssuer().jwks).verify("not-a-token")


def test_unknown_kid_refetches_keys_at_most_once_a_minute():
    keys = TestIssuer()
    now = [1000.0]
    verifier = TokenVerifier(ISSUER, "kitty-ai", keys.jwks, now=lambda: now[0])
    verifier.verify(keys.token())
    assert keys.jwks_fetches == 1
    verifier.verify(keys.token())  # cached
    with pytest.raises(Unauthorized):
        verifier.verify(keys.token(kid="random-1"))  # too soon after the last fetch: refused without fetching
    assert keys.jwks_fetches == 1
    now[0] += 61
    with pytest.raises(Unauthorized):
        verifier.verify(keys.token(kid="rotated-away"))
    assert keys.jwks_fetches == 2  # one refetch for an unknown key, then refused
    with pytest.raises(Unauthorized):
        verifier.verify(keys.token(kid="random-2"))
    assert keys.jwks_fetches == 2

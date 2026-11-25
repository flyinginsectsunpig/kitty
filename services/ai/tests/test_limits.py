from kitty_ai.limits import RateLimiter


def test_limiter_allows_30_then_refuses_until_the_window_moves():
    now = [1000.0]
    limiter = RateLimiter(30, 3600, now=lambda: now[0])
    assert all(limiter.allow("a") for _ in range(30))
    assert not limiter.allow("a")
    assert limiter.allow("b")  # per person
    now[0] += 3601
    assert limiter.allow("a")

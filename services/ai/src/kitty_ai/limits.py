"""A per-person request limit, in memory (the ai service runs as one process)."""

import time
from collections import defaultdict, deque
from collections.abc import Callable


class RateLimiter:
    def __init__(self, limit: int, per_seconds: int, now: Callable[[], float] = time.monotonic):
        self._limit = limit
        self._window = per_seconds
        self._now = now
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = self._now()
        hits = self._hits[key]
        while hits and hits[0] <= now - self._window:
            hits.popleft()
        if len(hits) >= self._limit:
            return False
        hits.append(now)
        return True

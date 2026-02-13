"""GhostGate Python SDK.

Drop this file into your project and import `GhostGate` to protect routes
using credit checks.
"""

from __future__ import annotations

import os
from functools import wraps
from typing import Any, Callable, Optional

import requests


class GhostGate:
    """Credit-gate helper for Python APIs."""

    VERIFY_URL = "https://ghost-rank.vercel.app/api/verify"

    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key

    def guard(self, cost: int) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Decorator that verifies credits before executing a handler."""
        if cost <= 0:
            raise ValueError("cost must be greater than 0")

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            @wraps(func)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                token = self._resolve_credit_token(*args, **kwargs)
                if not token:
                    return "Payment Required"

                if not self._verify(token=token, cost=cost):
                    return "Payment Required"

                return func(*args, **kwargs)

            return wrapper

        return decorator

    def _verify(self, token: str, cost: int) -> bool:
        payload = {
            "apiKey": self.api_key,
            "token": token,
            "cost": cost,
        }
        try:
            response = requests.post(self.VERIFY_URL, json=payload, timeout=10)
        except requests.RequestException:
            return False

        if response.status_code == 402:
            return False

        return 200 <= response.status_code < 300

    @staticmethod
    def _resolve_credit_token(*args: Any, **kwargs: Any) -> Optional[str]:
        # 1) Explicit env override for local runs/scripts.
        env_token = os.getenv("GHOST-CREDIT-TOKEN")
        if env_token:
            return env_token

        # 2) Request-like object passed into handler args/kwargs.
        request_obj = kwargs.get("request")
        if request_obj is None:
            for arg in args:
                if hasattr(arg, "headers"):
                    request_obj = arg
                    break

        if request_obj is not None:
            headers = getattr(request_obj, "headers", None)
            if headers and hasattr(headers, "get"):
                return (
                    headers.get("GHOST-CREDIT-TOKEN")
                    or headers.get("ghost-credit-token")
                    or headers.get("X-GHOST-CREDIT-TOKEN")
                    or headers.get("x-ghost-credit-token")
                )

        # 3) Flask fallback (global request context).
        try:
            from flask import request as flask_request  # type: ignore

            return (
                flask_request.headers.get("GHOST-CREDIT-TOKEN")
                or flask_request.headers.get("X-GHOST-CREDIT-TOKEN")
            )
        except Exception:
            return None

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
    PULSE_URL = "https://ghost-rank.vercel.app/api/telemetry/pulse"
    OUTCOME_URL = "https://ghost-rank.vercel.app/api/telemetry/outcome"

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

                result = func(*args, **kwargs)
                status_code = self._extract_status_code(result)
                success = status_code is None or status_code < 500
                self.report_consumer_outcome(success=success, status_code=status_code)
                return result

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

    def send_pulse(self, agent_id: Optional[str] = None) -> bool:
        """Merchant-side heartbeat stub (best effort, non-blocking)."""
        payload = {
            "apiKey": self.api_key,
            "agentId": agent_id,
        }
        return self._post_optional(self.PULSE_URL, payload)

    def report_consumer_outcome(
        self,
        *,
        success: bool,
        status_code: Optional[int] = None,
        agent_id: Optional[str] = None,
    ) -> bool:
        """Consumer-side outcome stub for Dual-Verify scoring."""
        payload = {
            "apiKey": self.api_key,
            "success": bool(success),
            "statusCode": status_code,
            "agentId": agent_id,
        }
        return self._post_optional(self.OUTCOME_URL, payload)

    @staticmethod
    def _extract_status_code(result: Any) -> Optional[int]:
        if hasattr(result, "status_code"):
            maybe_status = getattr(result, "status_code")
            if isinstance(maybe_status, int):
                return maybe_status
        if isinstance(result, tuple) and len(result) >= 2 and isinstance(result[1], int):
            return result[1]
        return None

    @staticmethod
    def _post_optional(url: str, payload: dict[str, Any]) -> bool:
        try:
            response = requests.post(url, json=payload, timeout=5)
            return 200 <= response.status_code < 300
        except requests.RequestException:
            return False

    @staticmethod
    def _resolve_credit_token(*args: Any, **kwargs: Any) -> Optional[str]:
        # 1) Explicit env override for local runs/scripts.
        env_token = os.getenv("X_GHOST_TOKEN") or os.getenv("GHOST_CREDIT_TOKEN") or os.getenv("GHOST-CREDIT-TOKEN")
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
                    headers.get("X-GHOST-TOKEN")
                    or headers.get("x-ghost-token")
                    or headers.get("GHOST-CREDIT-TOKEN")
                    or headers.get("ghost-credit-token")
                    or headers.get("X-GHOST-CREDIT-TOKEN")
                    or headers.get("x-ghost-credit-token")
                )

        # 3) Flask fallback (global request context).
        try:
            from flask import request as flask_request  # type: ignore

            return (
                flask_request.headers.get("X-GHOST-TOKEN")
                or flask_request.headers.get("x-ghost-token")
                or flask_request.headers.get("GHOST-CREDIT-TOKEN")
                or flask_request.headers.get("X-GHOST-CREDIT-TOKEN")
            )
        except Exception:
            return None

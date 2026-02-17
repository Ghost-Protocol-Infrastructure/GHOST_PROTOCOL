"""GhostGate Python SDK.

Drop this file into your project and import `GhostGate` to protect routes
using credit checks.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from functools import wraps
from typing import Any, Callable, Optional

import requests
from eth_account import Account
from eth_account.messages import encode_typed_data


class GhostGate:
    """Credit-gate helper for Python APIs."""

    BASE_URL = os.getenv("GHOST_GATE_BASE_URL", "https://ghost-rank.vercel.app").rstrip("/")
    GATE_URL = f"{BASE_URL}/api/gate"
    PULSE_URL = "https://ghost-rank.vercel.app/api/telemetry/pulse"
    OUTCOME_URL = "https://ghost-rank.vercel.app/api/telemetry/outcome"
    DOMAIN_NAME = "GhostGate"
    DOMAIN_VERSION = "1"

    def __init__(
        self,
        api_key: str,
        *,
        private_key: Optional[str] = None,
        chain_id: int = 8453,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")

        self.api_key = api_key
        self.chain_id = chain_id
        self.private_key = private_key or os.getenv("GHOST_SIGNER_PRIVATE_KEY") or os.getenv("PRIVATE_KEY")
        if not self.private_key:
            raise ValueError("A signing private key is required (private_key arg or GHOST_SIGNER_PRIVATE_KEY/PRIVATE_KEY).")

    def guard(
        self,
        cost: int,
        *,
        service: str = "weather",
        method: str = "GET",
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Decorator that verifies paid access via the GhostGate gateway."""
        if cost <= 0:
            raise ValueError("cost must be greater than 0")
        if not service:
            raise ValueError("service is required")

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            @wraps(func)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                if not self._verify_access(service=service, cost=cost, method=method):
                    return "Payment Required"

                result = func(*args, **kwargs)
                status_code = self._extract_status_code(result)
                success = status_code is None or status_code < 500
                self.report_consumer_outcome(success=success, status_code=status_code)
                return result

            return wrapper

        return decorator

    def _build_access_payload(self, service: str) -> dict[str, Any]:
        return {
            "service": service,
            "timestamp": int(time.time()),
            "nonce": uuid.uuid4().hex,
        }

    def _sign_access_payload(self, payload: dict[str, Any]) -> str:
        typed_data = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                ],
                "Access": [
                    {"name": "service", "type": "string"},
                    {"name": "timestamp", "type": "uint256"},
                    {"name": "nonce", "type": "string"},
                ],
            },
            "domain": {
                "name": self.DOMAIN_NAME,
                "version": self.DOMAIN_VERSION,
                "chainId": self.chain_id,
            },
            "primaryType": "Access",
            "message": payload,
        }
        signable = encode_typed_data(full_message=typed_data)
        signed = Account.sign_message(signable, private_key=self.private_key)
        return signed.signature.hex()

    def _verify_access(self, *, service: str, cost: int, method: str) -> bool:
        payload = self._build_access_payload(service)
        signature = self._sign_access_payload(payload)
        headers = {
            "x-ghost-sig": signature,
            "x-ghost-payload": json.dumps(payload),
            "x-ghost-credit-cost": str(cost),
            "accept": "application/json, text/plain;q=0.9, */*;q=0.8",
        }
        target = f"{self.GATE_URL}/{service}"

        try:
            response = requests.request(method=method.upper(), url=target, headers=headers, timeout=10)
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

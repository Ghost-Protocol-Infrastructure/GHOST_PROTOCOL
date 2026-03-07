"""GhostGate Python SDK.

Drop this file into your project and import `GhostGate` to protect routes
using credit checks.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import uuid
from functools import wraps
from typing import Any, Callable, Optional
from urllib.parse import quote

import requests
from eth_account import Account
from eth_account.messages import encode_typed_data


ConnectResult = dict[str, Any]
TelemetryResult = dict[str, Any]


class HeartbeatController:
    """Controls a best-effort heartbeat loop started by `start_heartbeat`."""

    def __init__(self, stop_callback: Callable[[], None]) -> None:
        self._stop_callback = stop_callback

    def stop(self) -> None:
        self._stop_callback()


class GhostGate:
    """Credit-gate helper for Python APIs."""

    DEFAULT_BASE_URL = "https://ghostprotocol.cc"
    DEFAULT_SERVICE_SLUG = "connect"
    DEFAULT_CREDIT_COST = 1
    DEFAULT_TIMEOUT_SECONDS = 10.0
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60.0
    DEFAULT_AUTH_MODE = "ghost-eip712"
    DEFAULT_X402_SCHEME = "ghost-eip712-credit-v1"
    DOMAIN_NAME = "GhostGate"
    DOMAIN_VERSION = "1"

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        private_key: Optional[str] = None,
        chain_id: int = 8453,
        base_url: str = DEFAULT_BASE_URL,
        service_slug: str = DEFAULT_SERVICE_SLUG,
        credit_cost: int = DEFAULT_CREDIT_COST,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        auth_mode: str = DEFAULT_AUTH_MODE,
        x402_scheme: str = DEFAULT_X402_SCHEME,
    ) -> None:
        self.api_key = self._normalize_optional_string(api_key) or self._normalize_optional_string(os.getenv("GHOST_API_KEY"))
        self.chain_id = chain_id
        env_base_url = os.getenv("GHOST_GATE_BASE_URL", "").strip()
        candidate_base_url = env_base_url or base_url
        self.base_url = candidate_base_url.rstrip("/")
        self.gate_url = f"{self.base_url}/api/gate"
        self.pulse_url = f"{self.base_url}/api/telemetry/pulse"
        self.outcome_url = f"{self.base_url}/api/telemetry/outcome"
        self.service_slug = self._normalize_optional_string(service_slug) or self.DEFAULT_SERVICE_SLUG
        self.credit_cost = self._normalize_credit_cost(credit_cost)
        self.timeout_seconds = self._normalize_timeout(timeout_seconds)
        normalized_auth_mode = (auth_mode or self.DEFAULT_AUTH_MODE).strip().lower()
        if normalized_auth_mode not in ("ghost-eip712", "x402"):
            raise ValueError("auth_mode must be 'ghost-eip712' or 'x402'.")
        self.auth_mode = normalized_auth_mode
        self.x402_scheme = (x402_scheme or self.DEFAULT_X402_SCHEME).strip() or self.DEFAULT_X402_SCHEME
        self.private_key = private_key or os.getenv("GHOST_SIGNER_PRIVATE_KEY") or os.getenv("PRIVATE_KEY")
        if not self.private_key:
            raise ValueError("A signing private key is required (private_key arg or GHOST_SIGNER_PRIVATE_KEY/PRIVATE_KEY).")

    @property
    def is_connected(self) -> bool:
        return self.api_key is not None

    @property
    def endpoint(self) -> str:
        return self.gate_url

    def connect(
        self,
        api_key: Optional[str] = None,
        *,
        service: Optional[str] = None,
        cost: Optional[int] = None,
        method: str = "POST",
        timeout_seconds: Optional[float] = None,
    ) -> ConnectResult:
        """Signs and sends an EIP-712 gate request to `/api/gate/<service>`."""
        resolved_api_key = self._normalize_optional_string(api_key) or self.api_key
        if not resolved_api_key:
            raise ValueError("connect(api_key?) requires a non-empty API key via argument or constructor.")

        resolved_service = self._normalize_optional_string(service) or self.service_slug
        resolved_cost = self._normalize_credit_cost(cost if cost is not None else self.credit_cost)
        resolved_method = (method or "POST").strip().upper() or "POST"
        endpoint = f"{self.gate_url}/{quote(resolved_service, safe='')}"

        try:
            response = self._request_access(
                service=resolved_service,
                cost=resolved_cost,
                method=resolved_method,
                timeout_seconds=timeout_seconds,
            )
            payload = self._parse_response_payload(response)
            payment_required = self._decode_base64_json(response.headers.get("payment-required"))
            payment_response = self._decode_base64_json(response.headers.get("payment-response"))
            if response.ok:
                self.api_key = resolved_api_key
            result: ConnectResult = {
                "connected": response.ok,
                "apiKeyPrefix": self._api_key_prefix(resolved_api_key),
                "endpoint": endpoint,
                "status": response.status_code,
                "payload": payload,
            }
            if self.auth_mode == "x402" or payment_required is not None or payment_response is not None:
                result["x402"] = {
                    "paymentRequired": payment_required,
                    "paymentResponse": payment_response,
                }
            return result
        except requests.RequestException as error:
            return {
                "connected": False,
                "apiKeyPrefix": self._api_key_prefix(resolved_api_key),
                "endpoint": endpoint,
                "status": 0,
                "payload": {"error": str(error)},
            }

    def pulse(
        self,
        *,
        api_key: Optional[str] = None,
        agent_id: Optional[str] = None,
        service_slug: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        timeout_seconds: Optional[float] = None,
    ) -> TelemetryResult:
        """Sends heartbeat telemetry to `/api/telemetry/pulse`."""
        resolved_api_key = self._normalize_optional_string(api_key) or self.api_key
        resolved_agent_id = self._normalize_optional_string(agent_id)
        resolved_service_slug = self._normalize_optional_string(service_slug) or self.service_slug

        self._assert_telemetry_identity(
            api_key=resolved_api_key,
            agent_id=resolved_agent_id,
            service_slug=resolved_service_slug,
        )

        payload: dict[str, Any] = {}
        if resolved_api_key:
            payload["apiKey"] = resolved_api_key
        if resolved_agent_id:
            payload["agentId"] = resolved_agent_id
        if resolved_service_slug:
            payload["serviceSlug"] = resolved_service_slug
        if metadata:
            payload["metadata"] = metadata

        return self._post_telemetry(
            endpoint=self.pulse_url,
            payload=payload,
            timeout_seconds=timeout_seconds,
        )

    def outcome(
        self,
        *,
        success: bool,
        status_code: Optional[int] = None,
        api_key: Optional[str] = None,
        agent_id: Optional[str] = None,
        service_slug: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        timeout_seconds: Optional[float] = None,
    ) -> TelemetryResult:
        """Sends consumer outcome telemetry to `/api/telemetry/outcome`."""
        resolved_api_key = self._normalize_optional_string(api_key) or self.api_key
        resolved_agent_id = self._normalize_optional_string(agent_id)
        resolved_service_slug = self._normalize_optional_string(service_slug) or self.service_slug

        self._assert_telemetry_identity(
            api_key=resolved_api_key,
            agent_id=resolved_agent_id,
            service_slug=resolved_service_slug,
        )

        payload: dict[str, Any] = {
            "success": bool(success),
        }
        normalized_status_code = self._normalize_status_code(status_code)
        if normalized_status_code is not None:
            payload["statusCode"] = normalized_status_code
        if resolved_api_key:
            payload["apiKey"] = resolved_api_key
        if resolved_agent_id:
            payload["agentId"] = resolved_agent_id
        if resolved_service_slug:
            payload["serviceSlug"] = resolved_service_slug
        if metadata:
            payload["metadata"] = metadata

        return self._post_telemetry(
            endpoint=self.outcome_url,
            payload=payload,
            timeout_seconds=timeout_seconds,
        )

    def start_heartbeat(
        self,
        *,
        interval_seconds: float = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        immediate: bool = True,
        api_key: Optional[str] = None,
        agent_id: Optional[str] = None,
        service_slug: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        on_result: Optional[Callable[[TelemetryResult], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        timeout_seconds: Optional[float] = None,
    ) -> HeartbeatController:
        """Starts a background heartbeat loop. Returns a controller with `stop()`."""
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be > 0.")

        stop_event = threading.Event()

        def tick() -> None:
            try:
                result = self.pulse(
                    api_key=api_key,
                    agent_id=agent_id,
                    service_slug=service_slug,
                    metadata=metadata,
                    timeout_seconds=timeout_seconds,
                )
                if on_result:
                    on_result(result)
            except Exception as error:  # noqa: BLE001 - callback boundary
                if on_error:
                    on_error(error)

        def run_loop() -> None:
            if immediate:
                tick()
            while not stop_event.wait(interval_seconds):
                tick()

        worker = threading.Thread(target=run_loop, daemon=True, name="ghostgate-heartbeat")
        worker.start()

        def stop() -> None:
            stop_event.set()
            if worker.is_alive():
                worker.join(timeout=1)

        return HeartbeatController(stop)

    def guard(
        self,
        cost: int,
        *,
        service: Optional[str] = None,
        method: str = "GET",
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Decorator that verifies paid access via the GhostGate gateway."""
        if cost <= 0:
            raise ValueError("cost must be greater than 0")
        resolved_service = self._normalize_optional_string(service) or self.service_slug

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            @wraps(func)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                if not self._verify_access(service=resolved_service, cost=cost, method=method):
                    return "Payment Required"

                result = func(*args, **kwargs)
                status_code = self._extract_status_code(result)
                success = status_code is None or status_code < 500
                self.outcome(success=success, status_code=status_code, service_slug=resolved_service)
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

    def _request_access(
        self,
        *,
        service: str,
        cost: int,
        method: str,
        timeout_seconds: Optional[float] = None,
    ) -> requests.Response:
        payload = self._build_access_payload(service)
        signature = self._sign_access_payload(payload)
        if self.auth_mode == "x402":
            envelope = {
                "x402Version": 2,
                "scheme": self.x402_scheme,
                "network": f"eip155:{self.chain_id}",
                "payload": payload,
                "signature": signature,
            }
            headers = {
                "payment-signature": self._encode_base64_json(envelope),
                "accept": "application/json, text/plain;q=0.9, */*;q=0.8",
            }
        else:
            headers = {
                "x-ghost-sig": signature,
                "x-ghost-payload": json.dumps(payload),
                "x-ghost-credit-cost": str(cost),
                "accept": "application/json, text/plain;q=0.9, */*;q=0.8",
            }
        target = f"{self.gate_url}/{quote(service, safe='')}"
        return requests.request(
            method=method.upper(),
            url=target,
            headers=headers,
            timeout=self._resolve_timeout(timeout_seconds),
        )

    def _verify_access(self, *, service: str, cost: int, method: str) -> bool:
        result = self.connect(service=service, cost=cost, method=method)
        return bool(result.get("connected"))

    def send_pulse(self, agent_id: Optional[str] = None) -> bool:
        """Legacy alias for `pulse(...).ok`."""
        return bool(self.pulse(agent_id=agent_id).get("ok"))

    def report_consumer_outcome(
        self,
        *,
        success: bool,
        status_code: Optional[int] = None,
        agent_id: Optional[str] = None,
    ) -> bool:
        """Legacy alias for `outcome(...).ok`."""
        return bool(self.outcome(success=success, status_code=status_code, agent_id=agent_id).get("ok"))

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
    def _normalize_optional_string(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed if trimmed else None

    @staticmethod
    def _normalize_credit_cost(value: int) -> int:
        if not isinstance(value, int) or value <= 0:
            raise ValueError("credit_cost must be an integer greater than 0.")
        return value

    @staticmethod
    def _normalize_timeout(value: float) -> float:
        if value <= 0:
            raise ValueError("timeout_seconds must be > 0.")
        return value

    @staticmethod
    def _normalize_status_code(value: Optional[int]) -> Optional[int]:
        if value is None:
            return None
        if not isinstance(value, int) or value < 100 or value > 599:
            raise ValueError("status_code must be an integer in the HTTP status range (100-599).")
        return value

    @staticmethod
    def _api_key_prefix(api_key: str) -> str:
        return api_key if len(api_key) <= 8 else f"{api_key[:8]}..."

    @staticmethod
    def _parse_response_payload(response: requests.Response) -> Any:
        try:
            return response.json()
        except ValueError:
            return response.text

    @staticmethod
    def _encode_base64_json(value: Any) -> str:
        return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")

    @staticmethod
    def _decode_base64_json(value: Optional[str]) -> Any:
        if not value:
            return None
        try:
            return json.loads(base64.b64decode(value).decode("utf-8"))
        except Exception:  # noqa: BLE001 - tolerant decode for interop responses
            return None

    @staticmethod
    def _assert_telemetry_identity(
        *,
        api_key: Optional[str],
        agent_id: Optional[str],
        service_slug: Optional[str],
    ) -> None:
        if api_key or agent_id or service_slug:
            return
        raise ValueError("Telemetry calls require at least one of api_key, agent_id, or service_slug.")

    def _resolve_timeout(self, timeout_seconds: Optional[float]) -> float:
        return self.timeout_seconds if timeout_seconds is None else self._normalize_timeout(timeout_seconds)

    def _post_telemetry(
        self,
        *,
        endpoint: str,
        payload: dict[str, Any],
        timeout_seconds: Optional[float],
    ) -> TelemetryResult:
        try:
            response = requests.post(
                endpoint,
                json=payload,
                timeout=self._resolve_timeout(timeout_seconds),
            )
            return {
                "ok": response.ok,
                "endpoint": endpoint,
                "status": response.status_code,
                "payload": self._parse_response_payload(response),
            }
        except requests.RequestException as error:
            return {
                "ok": False,
                "endpoint": endpoint,
                "status": 0,
                "payload": {"error": str(error)},
            }

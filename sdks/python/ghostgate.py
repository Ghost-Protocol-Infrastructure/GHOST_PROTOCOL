"""GhostGate Python SDK.

Drop this file into your project and import `GhostGate` to protect routes
using credit checks.
"""

from __future__ import annotations

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
from eth_account.messages import encode_defunct, encode_typed_data
from eth_utils import keccak as eth_keccak


ConnectResult = dict[str, Any]
TelemetryResult = dict[str, Any]
ActivateResult = dict[str, Any]
WireQuoteResult = dict[str, Any]
WireJobResult = dict[str, Any]
WireDeliverableResult = dict[str, Any]
WireArtifactResult = dict[str, Any]
GhostWireRequestPayload = dict[str, Any]


def _normalize_optional_string(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _normalize_wire_request_payload(request: Optional[dict[str, Any]]) -> Optional[GhostWireRequestPayload]:
    if request is None:
        return None
    if not isinstance(request, dict):
        raise ValueError("GhostWire request must be a JSON object.")

    prompt = _normalize_optional_string(request.get("prompt"))
    if not prompt:
        raise ValueError("GhostWire request.prompt must be a non-empty string.")

    wallet_address = _normalize_optional_string(request.get("walletAddress"))

    normalized: GhostWireRequestPayload = {
        "version": 1,
        "prompt": prompt,
    }
    if wallet_address:
        normalized["walletAddress"] = wallet_address
    if "metadata" in request:
        try:
            json.dumps(request.get("metadata"), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as error:
            raise ValueError("GhostWire request.metadata must be valid JSON data.") from error
        normalized["metadata"] = request.get("metadata")

    return normalized


def build_wire_request_spec_hash(request: dict[str, Any]) -> str:
    normalized = _normalize_wire_request_payload(request)
    if normalized is None:
        raise ValueError("GhostWire request payload is required.")
    canonical = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return f"0x{eth_keccak(text=canonical).hex()}"


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
    DEFAULT_X402_SCHEME = "exact"
    DEFAULT_X402_ASSET = "USDC"
    DEFAULT_X402_DECIMALS = 6
    DEFAULT_ACTIVATE_CANARY_PATH = "/health"
    DEFAULT_ACTIVATE_CANARY_METHOD = "GET"
    DEFAULT_ACTIVATE_SIGNER_LABEL = "sdk-auto"
    MERCHANT_GATEWAY_AUTH_SCOPE = "agent_gateway"
    MERCHANT_GATEWAY_AUTH_VERSION = "1"
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
        self.private_key = private_key or os.getenv("GHOST_SIGNER_PRIVATE_KEY") or os.getenv("PRIVATE_KEY")
        if not self.private_key:
            raise ValueError("A signing private key is required (private_key arg or GHOST_SIGNER_PRIVATE_KEY/PRIVATE_KEY).")
        self._activate_heartbeat: Optional[HeartbeatController] = None

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
            if response.ok:
                self.api_key = resolved_api_key
            return {
                "connected": response.ok,
                "apiKeyPrefix": self._api_key_prefix(resolved_api_key),
                "endpoint": endpoint,
                "status": response.status_code,
                "payload": payload,
            }
        except requests.RequestException as error:
            return {
                "connected": False,
                "apiKeyPrefix": self._api_key_prefix(resolved_api_key),
                "endpoint": endpoint,
                "status": 0,
            "payload": {"error": str(error)},
        }

    def request_x402(
        self,
        *,
        url: str,
        method: str = "GET",
        headers: Optional[dict[str, str]] = None,
        body: Optional[Any] = None,
        payment_header: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> dict[str, Any]:
        """Perform a standards-native x402 request.

        If `payment_header` is omitted, the call returns the initial response, which may be a 402
        challenge body from the merchant. If `payment_header` is provided, it is attached as
        `X-PAYMENT` for the retry.
        """

        normalized_url = self._normalize_optional_string(url)
        if not normalized_url:
            raise ValueError("request_x402(url=...) requires a non-empty url.")

        request_headers: dict[str, str] = {
            "accept": "application/json, text/plain;q=0.9, */*;q=0.8",
            **(headers or {}),
        }
        normalized_payment_header = self._normalize_optional_string(payment_header)
        if normalized_payment_header:
            request_headers["X-PAYMENT"] = normalized_payment_header

        kwargs: dict[str, Any] = {
            "method": (method or "GET").strip().upper() or "GET",
            "url": normalized_url,
            "headers": request_headers,
            "timeout": self._resolve_timeout(timeout_seconds),
        }
        if body is not None:
            request_headers.setdefault("content-type", "application/json")
            kwargs["data"] = json.dumps(body)

        response = requests.request(**kwargs)
        x_payment_response_header = response.headers.get("x-payment-response") or response.headers.get("X-PAYMENT-RESPONSE")
        return {
            "ok": response.ok,
            "endpoint": normalized_url,
            "status": response.status_code,
            "payload": self._parse_response_payload(response),
            "paymentResponseHeader": x_payment_response_header,
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

    def create_wire_quote(
        self,
        *,
        provider: str,
        evaluator: str,
        principal_amount: str,
        chain_id: Optional[int] = None,
        client: str,
        provider_agent_id: Optional[str] = None,
        provider_service_slug: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> WireQuoteResult:
        endpoint = f"{self.base_url}/api/wire/quote"
        response = requests.post(
            endpoint,
            json={
                "provider": provider,
                "evaluator": evaluator,
                "principalAmount": principal_amount,
                "settlementAsset": "USDC",
                "chainId": chain_id or self.chain_id,
                **({"client": client} if self._normalize_optional_string(client) else {}),
                **({"providerAgentId": provider_agent_id} if self._normalize_optional_string(provider_agent_id) else {}),
                **(
                    {"providerServiceSlug": provider_service_slug}
                    if self._normalize_optional_string(provider_service_slug)
                    else {}
                ),
            },
            headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
            timeout=self._resolve_timeout(timeout_seconds),
        )
        payload = self._parse_response_payload(response)
        return {
            "ok": response.ok,
            "endpoint": endpoint,
            "status": response.status_code,
            "payload": payload,
            "quoteId": payload.get("quoteId") if isinstance(payload, dict) else None,
            "expiresAt": payload.get("expiresAt") if isinstance(payload, dict) else None,
            "chainId": payload.get("chainId") if isinstance(payload, dict) else None,
            "contractAddress": payload.get("contractAddress") if isinstance(payload, dict) else None,
            "paymentTokenAddress": payload.get("paymentTokenAddress") if isinstance(payload, dict) else None,
            "pricing": payload.get("pricing") if isinstance(payload, dict) else None,
            "confirmations": payload.get("confirmations") if isinstance(payload, dict) else None,
            "directExecution": payload.get("directExecution") if isinstance(payload, dict) else None,
        }

    def prepare_wire_job(
        self,
        *,
        quote_id: str,
        client: str,
        provider: str,
        evaluator: str,
        provider_agent_id: Optional[str] = None,
        provider_service_slug: Optional[str] = None,
        spec_hash: Optional[str] = None,
        request: Optional[dict[str, Any]] = None,
        metadata_uri: Optional[str] = None,
        webhook_url: Optional[str] = None,
        webhook_secret: Optional[str] = None,
        approval_mode: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> WireJobResult:
        endpoint = f"{self.base_url}/api/wire/jobs"
        normalized_request = _normalize_wire_request_payload(request)
        normalized_spec_hash = self._normalize_optional_string(spec_hash)
        if normalized_request and normalized_spec_hash:
            derived_spec_hash = build_wire_request_spec_hash(normalized_request)
            if derived_spec_hash.lower() != normalized_spec_hash.lower():
                raise ValueError("prepare_wire_job request does not match the supplied spec_hash.")
        resolved_spec_hash = normalized_spec_hash or (
            build_wire_request_spec_hash(normalized_request) if normalized_request is not None else None
        )
        if not resolved_spec_hash:
            raise ValueError("prepare_wire_job requires either spec_hash or request.")

        response = requests.post(
            endpoint,
            json={
                "quoteId": quote_id,
                "client": client,
                "provider": provider,
                "evaluator": evaluator,
                **({"providerAgentId": provider_agent_id} if self._normalize_optional_string(provider_agent_id) else {}),
                **(
                    {"providerServiceSlug": provider_service_slug}
                    if self._normalize_optional_string(provider_service_slug)
                    else {}
                ),
                "specHash": resolved_spec_hash,
                **({"request": normalized_request} if normalized_request is not None else {}),
                **({"metadataUri": metadata_uri} if self._normalize_optional_string(metadata_uri) else {}),
                **({"webhookUrl": webhook_url} if self._normalize_optional_string(webhook_url) else {}),
                **({"webhookSecret": webhook_secret} if self._normalize_optional_string(webhook_secret) else {}),
                **({"approvalMode": approval_mode} if self._normalize_optional_string(approval_mode) else {}),
            },
            headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
            timeout=self._resolve_timeout(timeout_seconds),
        )
        payload = self._parse_response_payload(response)
        return {
            "ok": response.ok,
            "endpoint": endpoint,
            "status": response.status_code,
            "payload": payload,
            "jobId": payload.get("jobId") if isinstance(payload, dict) else None,
            "quoteId": payload.get("quoteId") if isinstance(payload, dict) else None,
            "chainId": payload.get("chainId") if isinstance(payload, dict) else None,
            "jobExpiresAt": payload.get("jobExpiresAt") if isinstance(payload, dict) else None,
            "direct": payload.get("direct") if isinstance(payload, dict) else None,
        }

    def record_wire_artifacts(
        self,
        *,
        job_id: str,
        client_address: str,
        create_tx_hash: Optional[str] = None,
        fund_tx_hash: Optional[str] = None,
        create_tx_sender: Optional[str] = None,
        fund_tx_sender: Optional[str] = None,
        approval_mode: Optional[str] = None,
        client_private_key: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> WireArtifactResult:
        normalized_job_id = self._normalize_optional_string(job_id)
        if not normalized_job_id:
            raise ValueError("record_wire_artifacts requires a non-empty job_id.")

        normalized_create_tx_hash = self._normalize_wire_hash(create_tx_hash)
        normalized_fund_tx_hash = self._normalize_wire_hash(fund_tx_hash)
        if not normalized_create_tx_hash and not normalized_fund_tx_hash:
            raise ValueError("record_wire_artifacts requires at least one of create_tx_hash or fund_tx_hash.")

        resolved_private_key = client_private_key or self.private_key
        client_account = Account.from_key(resolved_private_key)
        if client_account.address.lower() != client_address.lower():
            raise ValueError("record_wire_artifacts client_private_key does not match client_address.")

        auth_payload = self._build_wire_artifact_auth_payload(
            job_id=normalized_job_id,
            client_address=client_address,
            create_tx_hash=normalized_create_tx_hash,
            fund_tx_hash=normalized_fund_tx_hash,
        )
        auth_signature = Account.sign_message(
            encode_defunct(text=self._build_wire_artifact_auth_message(auth_payload)),
            private_key=resolved_private_key,
        ).signature.hex()

        endpoint = f"{self.base_url}/api/wire/jobs/{quote(normalized_job_id, safe='')}/artifacts"
        response = requests.post(
            endpoint,
            json={
                **({"createTxHash": normalized_create_tx_hash} if normalized_create_tx_hash else {}),
                **({"fundTxHash": normalized_fund_tx_hash} if normalized_fund_tx_hash else {}),
                **({"createTxSender": create_tx_sender} if self._normalize_optional_string(create_tx_sender) else {}),
                **({"fundTxSender": fund_tx_sender} if self._normalize_optional_string(fund_tx_sender) else {}),
                **({"approvalMode": approval_mode} if self._normalize_optional_string(approval_mode) else {}),
                "authPayload": auth_payload,
                "authSignature": auth_signature,
            },
            headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
            timeout=self._resolve_timeout(timeout_seconds),
        )
        payload = self._parse_response_payload(response)
        return {
            "ok": response.ok,
            "endpoint": endpoint,
            "status": response.status_code,
            "payload": payload,
            "job": payload.get("job") if isinstance(payload, dict) else None,
            "direct": payload.get("direct") if isinstance(payload, dict) else None,
        }

    def get_wire_job(self, job_id: str, *, timeout_seconds: Optional[float] = None) -> WireJobResult:
        normalized_job_id = self._normalize_optional_string(job_id)
        if not normalized_job_id:
            raise ValueError("get_wire_job(job_id) requires a non-empty GhostWire job id.")

        endpoint = f"{self.base_url}/api/wire/jobs/{quote(normalized_job_id, safe='')}"
        response = requests.get(
            endpoint,
            headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
            timeout=self._resolve_timeout(timeout_seconds),
        )
        payload = self._parse_response_payload(response)
        job = payload.get("job") if isinstance(payload, dict) and isinstance(payload.get("job"), dict) else None
        return {
            "ok": response.ok,
            "endpoint": endpoint,
            "status": response.status_code,
            "payload": payload,
            "job": job,
        }

    def wait_for_wire_terminal(
        self,
        job_id: str,
        *,
        interval_seconds: float = 5.0,
        timeout_seconds: float = 300.0,
    ) -> dict[str, Any]:
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be > 0.")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0.")

        started_at = time.time()
        while True:
            result = self.get_wire_job(job_id, timeout_seconds=min(self.timeout_seconds, max(interval_seconds, 1.0)))
            job = result.get("job")
            if not result.get("ok") or not isinstance(job, dict):
                raise ValueError(f"wait_for_wire_terminal failed to fetch job {job_id} (status {result.get('status')}).")

            contract_state = str(job.get("contractState", "")).upper()
            if contract_state in {"COMPLETED", "REJECTED", "EXPIRED"}:
                return job

            if time.time() - started_at >= timeout_seconds:
                raise TimeoutError(f"GhostWire job {job_id} did not reach a terminal state before timeout.")

            time.sleep(interval_seconds)

    def get_wire_deliverable(
        self,
        job_id: str,
        *,
        timeout_seconds: Optional[float] = None,
    ) -> WireDeliverableResult:
        result = self.get_wire_job(job_id, timeout_seconds=timeout_seconds)
        job = result.get("job")
        if not result.get("ok") or not isinstance(job, dict):
            raise ValueError(f"get_wire_deliverable failed to fetch job {job_id} (status {result.get('status')}).")

        if str(job.get("contractState", "")).upper() != "COMPLETED":
            raise ValueError(f"GhostWire job {job_id} is not completed yet.")

        deliverable = job.get("deliverable") if isinstance(job.get("deliverable"), dict) else {}
        locator = deliverable.get("locatorUrl") if isinstance(deliverable.get("locatorUrl"), str) else None
        if not locator:
            metadata_uri = job.get("metadataUri") if isinstance(job.get("metadataUri"), str) else None
            locator = metadata_uri.strip() if metadata_uri and metadata_uri.strip() else None
        if not locator:
            raise ValueError(f"GhostWire job {job_id} does not expose a deliverable locator.")

        response = requests.get(
            locator,
            headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
            timeout=self._resolve_timeout(timeout_seconds),
        )
        text = response.text
        try:
            body_json = response.json()
        except ValueError:
            body_json = None

        if not response.ok:
            raise ValueError(
                f"GhostWire deliverable fetch failed for {job_id} from {locator} (status {response.status_code})."
            )

        return {
            "ok": response.ok,
            "endpoint": locator,
            "status": response.status_code,
            "job": job,
            "contentType": response.headers.get("content-type"),
            "bodyJson": body_json,
            "bodyText": text,
            "sourceUrl": locator,
        }

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

    def activate(
        self,
        agent_id: str,
        service_slug: str,
        endpoint_url: str,
        canary_path: str = DEFAULT_ACTIVATE_CANARY_PATH,
        canary_method: str = DEFAULT_ACTIVATE_CANARY_METHOD,
        signer_label: str = DEFAULT_ACTIVATE_SIGNER_LABEL,
    ) -> ActivateResult:
        """Configures, verifies, registers delegated signer, and starts heartbeat."""
        normalized_agent_id = self._normalize_optional_string(agent_id)
        normalized_service_slug = self._normalize_optional_string(service_slug)
        normalized_endpoint_url = self._normalize_optional_string(endpoint_url)
        normalized_canary_path = self._normalize_optional_string(canary_path) or self.DEFAULT_ACTIVATE_CANARY_PATH
        normalized_canary_method = (self._normalize_optional_string(canary_method) or self.DEFAULT_ACTIVATE_CANARY_METHOD).upper()
        normalized_signer_label = self._normalize_optional_string(signer_label) or self.DEFAULT_ACTIVATE_SIGNER_LABEL

        if not normalized_agent_id:
            raise ValueError("[activate:validate] agent_id is required.")
        if not normalized_service_slug:
            raise ValueError("[activate:validate] service_slug is required.")
        if not normalized_endpoint_url:
            raise ValueError("[activate:validate] endpoint_url is required.")
        if not normalized_canary_path.startswith("/"):
            raise ValueError("[activate:validate] canary_path must start with '/'.")
        if normalized_canary_method != "GET":
            raise ValueError("[activate:validate] canary_method must be GET.")

        indexed_owner = self._fetch_gateway_owner_address(normalized_agent_id)
        signer_address = Account.from_key(self.private_key).address.lower()
        if signer_address != indexed_owner:
            raise ValueError(
                f"[activate:owner] private_key address {signer_address} does not match indexed owner {indexed_owner} for agent {normalized_agent_id}."
            )

        config_payload = self._post_gateway_signed_write(
            action="config",
            path="/api/agent-gateway/config",
            agent_id=normalized_agent_id,
            service_slug=normalized_service_slug,
            owner_address=indexed_owner,
            body={
                "endpointUrl": normalized_endpoint_url,
                "canaryPath": normalized_canary_path,
                "canaryMethod": "GET",
            },
        )

        verify_payload = self._post_gateway_signed_write(
            action="verify",
            path="/api/agent-gateway/verify",
            agent_id=normalized_agent_id,
            service_slug=normalized_service_slug,
            owner_address=indexed_owner,
            body={},
        )
        readiness_status = verify_payload.get("readinessStatus")
        if verify_payload.get("verified") is not True or readiness_status != "LIVE":
            details = []
            if isinstance(verify_payload.get("error"), str):
                details.append(f"error={verify_payload['error']}")
            if isinstance(verify_payload.get("canaryUrl"), str):
                details.append(f"canaryUrl={verify_payload['canaryUrl']}")
            if isinstance(verify_payload.get("statusCode"), int):
                details.append(f"statusCode={verify_payload['statusCode']}")
            if isinstance(verify_payload.get("latencyMs"), (int, float)):
                details.append(f"latencyMs={int(verify_payload['latencyMs'])}")
            suffix = f" ({', '.join(details)})" if details else ""
            raise ValueError(f"[activate:verify] canary verification did not reach LIVE readiness{suffix}.")

        signer_registration = self._post_gateway_signed_write(
            action="delegated_signer_register",
            path="/api/agent-gateway/delegated-signers/register",
            agent_id=normalized_agent_id,
            service_slug=normalized_service_slug,
            owner_address=indexed_owner,
            body={
                "signerAddress": signer_address,
                "label": normalized_signer_label,
            },
        )

        if self._activate_heartbeat:
            self._activate_heartbeat.stop()
        self._activate_heartbeat = self.start_heartbeat(
            agent_id=normalized_agent_id,
            service_slug=normalized_service_slug,
            immediate=False,
        )

        config_result = config_payload.get("config") if isinstance(config_payload.get("config"), dict) else {}
        return {
            "status": "LIVE",
            "readiness": "LIVE",
            "config": config_result,
            "verify": verify_payload,
            "signerRegistration": signer_registration,
            "heartbeat": self._activate_heartbeat,
        }

    def report_x402_settlement(
        self,
        *,
        agent_id: str,
        service_slug: str,
        request_id: str,
        payment_reference: str,
        payer_identity: str,
        amount_atomic: int | str,
        payer_address: Optional[str] = None,
        scheme: str = DEFAULT_X402_SCHEME,
        network: Optional[str] = None,
        chain_id: Optional[int] = None,
        asset: str = DEFAULT_X402_ASSET,
        decimals: int = DEFAULT_X402_DECIMALS,
        success: bool,
        status_code: Optional[int] = None,
        latency_ms: Optional[int] = None,
        occurred_at: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        timeout_seconds: Optional[float] = None,
    ) -> dict[str, Any]:
        normalized_agent_id = self._normalize_optional_string(agent_id)
        normalized_service_slug = self._normalize_optional_string(service_slug)
        normalized_request_id = self._normalize_optional_string(request_id)
        normalized_payment_reference = self._normalize_optional_string(payment_reference)
        normalized_payer_identity = self._normalize_optional_string(payer_identity)
        normalized_payer_address = self._normalize_optional_string(payer_address)
        normalized_scheme = self._normalize_optional_string(scheme) or self.DEFAULT_X402_SCHEME
        normalized_asset = self._normalize_optional_string(asset) or self.DEFAULT_X402_ASSET

        if not normalized_agent_id:
            raise ValueError("report_x402_settlement requires a non-empty agent_id.")
        if not normalized_service_slug:
            raise ValueError("report_x402_settlement requires a non-empty service_slug.")
        if not normalized_request_id:
            raise ValueError("report_x402_settlement requires a non-empty request_id.")
        if not normalized_payment_reference:
            raise ValueError("report_x402_settlement requires a non-empty payment_reference.")
        if not normalized_payer_identity:
            raise ValueError("report_x402_settlement requires a non-empty payer_identity.")

        normalized_amount_atomic = self._normalize_positive_int_string(amount_atomic, "amount_atomic")
        normalized_status_code = self._normalize_status_code(status_code)
        normalized_latency_ms = self._normalize_optional_non_negative_int(latency_ms, "latency_ms")
        normalized_occurred_at = self._normalize_optional_string(occurred_at) or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        owner_address = self._fetch_gateway_owner_address(normalized_agent_id)
        actor_address = Account.from_key(self.private_key).address.lower()
        auth_payload = self._create_merchant_gateway_auth_payload(
            action="x402_settlement_report",
            agent_id=normalized_agent_id,
            owner_address=owner_address,
            actor_address=actor_address,
            service_slug=normalized_service_slug,
        )
        auth_signature = Account.sign_message(
            encode_defunct(text=self._build_merchant_gateway_auth_message(auth_payload)),
            private_key=self.private_key,
        ).signature.hex()

        endpoint = f"{self.base_url}/api/telemetry/x402/settlements"
        request_body: dict[str, Any] = {
            "agentId": normalized_agent_id,
            "ownerAddress": owner_address,
            "actorAddress": actor_address,
            "serviceSlug": normalized_service_slug,
            "requestId": normalized_request_id,
            "paymentReference": normalized_payment_reference,
            "payerIdentity": normalized_payer_identity,
            "scheme": normalized_scheme,
            "asset": normalized_asset,
            "amountAtomic": normalized_amount_atomic,
            "decimals": int(decimals),
            "success": bool(success),
            "occurredAt": normalized_occurred_at,
            "authPayload": auth_payload,
            "authSignature": auth_signature,
        }
        if normalized_payer_address:
            request_body["payerAddress"] = normalized_payer_address.lower()
        if self._normalize_optional_string(network):
            request_body["network"] = self._normalize_optional_string(network)
        if isinstance(chain_id, int):
            request_body["chainId"] = chain_id
        if normalized_status_code is not None:
            request_body["statusCode"] = normalized_status_code
        if normalized_latency_ms is not None:
            request_body["latencyMs"] = normalized_latency_ms
        if metadata:
            request_body["metadata"] = metadata

        response = requests.post(
            endpoint,
            json=request_body,
            headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
            timeout=self._resolve_timeout(timeout_seconds),
        )
        payload = self._parse_response_payload(response)
        return {
            "ok": response.ok,
            "endpoint": endpoint,
            "status": response.status_code,
            "payload": payload,
            "countedForRank": bool(payload.get("countedForRank")) if isinstance(payload, dict) else False,
            "relatedParty": bool(payload.get("relatedParty")) if isinstance(payload, dict) else False,
            "duplicate": bool(payload.get("duplicate")) if isinstance(payload, dict) else False,
        }

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

    def _create_merchant_gateway_auth_payload(
        self,
        *,
        action: str,
        agent_id: str,
        owner_address: str,
        actor_address: str,
        service_slug: str,
    ) -> dict[str, Any]:
        return {
            "scope": self.MERCHANT_GATEWAY_AUTH_SCOPE,
            "version": self.MERCHANT_GATEWAY_AUTH_VERSION,
            "action": action,
            "agentId": agent_id,
            "ownerAddress": owner_address.lower(),
            "actorAddress": actor_address.lower(),
            "serviceSlug": service_slug,
            "nonce": uuid.uuid4().hex,
            "issuedAt": int(time.time()),
        }

    @staticmethod
    def _build_merchant_gateway_auth_message(payload: dict[str, Any]) -> str:
        return "\n".join(
            [
                "Ghost Protocol Merchant Gateway Authorization",
                f"scope:{payload['scope']}",
                f"version:{payload['version']}",
                f"action:{payload['action']}",
                f"agentId:{payload['agentId']}",
                f"serviceSlug:{payload['serviceSlug']}",
                f"ownerAddress:{payload['ownerAddress']}",
                f"actorAddress:{payload['actorAddress']}",
                f"issuedAt:{payload['issuedAt']}",
                f"nonce:{payload['nonce']}",
            ]
        )

    @staticmethod
    def _normalize_wire_hash(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        trimmed = value.strip().lower()
        return trimmed if len(trimmed) == 66 and trimmed.startswith("0x") else None

    def _build_wire_artifact_auth_payload(
        self,
        *,
        job_id: str,
        client_address: str,
        create_tx_hash: Optional[str] = None,
        fund_tx_hash: Optional[str] = None,
        issued_at: Optional[int] = None,
        nonce: Optional[str] = None,
    ) -> dict[str, Any]:
        return {
            "scope": "ghostwire_artifacts",
            "version": "1",
            "jobId": job_id,
            "clientAddress": client_address.lower(),
            "createTxHash": self._normalize_wire_hash(create_tx_hash),
            "fundTxHash": self._normalize_wire_hash(fund_tx_hash),
            "issuedAt": issued_at or int(time.time()),
            "nonce": nonce or uuid.uuid4().hex,
        }

    @staticmethod
    def _build_wire_artifact_auth_message(payload: dict[str, Any]) -> str:
        return "\n".join(
            [
                "Ghost Protocol GhostWire Artifact Authorization",
                f"scope:{payload['scope']}",
                f"version:{payload['version']}",
                f"jobId:{payload['jobId']}",
                f"clientAddress:{payload['clientAddress']}",
                f"createTxHash:{payload['createTxHash'] or ''}",
                f"fundTxHash:{payload['fundTxHash'] or ''}",
                f"issuedAt:{payload['issuedAt']}",
                f"nonce:{payload['nonce']}",
            ]
        )

    def _fetch_gateway_owner_address(self, agent_id: str) -> str:
        endpoint = f"{self.base_url}/api/agent-gateway/config"
        try:
            response = requests.get(
                endpoint,
                params={"agentId": agent_id},
                headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
                timeout=self.timeout_seconds,
            )
        except requests.RequestException as error:
            raise ValueError(f"[activate:config_lookup] failed to load gateway owner config: {error}") from error

        payload = self._parse_response_payload(response)
        if not response.ok:
            raise ValueError(
                f"[activate:config_lookup] {self._extract_payload_error(payload, 'Failed to load gateway owner config.')}"
            )

        if not isinstance(payload, dict):
            raise ValueError("[activate:config_lookup] invalid gateway config payload.")
        config = payload.get("config")
        if not isinstance(config, dict):
            raise ValueError("[activate:config_lookup] gateway config payload missing config.")
        owner = config.get("ownerAddress")
        if not isinstance(owner, str) or not owner.strip():
            raise ValueError("[activate:config_lookup] gateway config payload missing ownerAddress.")
        return owner.strip().lower()

    def _post_gateway_signed_write(
        self,
        *,
        action: str,
        path: str,
        agent_id: str,
        service_slug: str,
        owner_address: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        actor_address = owner_address.lower()
        auth_payload = self._create_merchant_gateway_auth_payload(
            action=action,
            agent_id=agent_id,
            owner_address=owner_address,
            actor_address=actor_address,
            service_slug=service_slug,
        )
        auth_message = self._build_merchant_gateway_auth_message(auth_payload)
        auth_signature = Account.sign_message(encode_defunct(text=auth_message), private_key=self.private_key).signature.hex()

        endpoint = f"{self.base_url}{path}"
        request_body = {
            "agentId": agent_id,
            "ownerAddress": owner_address.lower(),
            "actorAddress": actor_address,
            "serviceSlug": service_slug,
            "authPayload": auth_payload,
            "authSignature": auth_signature,
            **body,
        }
        try:
            response = requests.post(
                endpoint,
                json=request_body,
                headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
                timeout=self.timeout_seconds,
            )
        except requests.RequestException as error:
            raise ValueError(f"[activate:{action}] request failed: {error}") from error

        payload = self._parse_response_payload(response)
        if not response.ok:
            raise ValueError(f"[activate:{action}] {self._extract_payload_error(payload, f'Request failed for {action}.')}")
        if not isinstance(payload, dict):
            raise ValueError(f"[activate:{action}] invalid response payload.")
        return payload

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
    def _extract_payload_error(payload: Any, fallback: str) -> str:
        if isinstance(payload, dict):
            maybe_error = payload.get("error")
            if isinstance(maybe_error, str) and maybe_error.strip():
                return maybe_error.strip()
        return fallback

    @staticmethod
    def _normalize_positive_int_string(value: int | str, field_name: str) -> str:
        if isinstance(value, int):
            if value < 0:
                raise ValueError(f"{field_name} must be non-negative.")
            return str(value)
        normalized = value.strip()
        if not normalized.isdigit():
            raise ValueError(f"{field_name} must be a non-negative integer string.")
        return normalized

    @staticmethod
    def _normalize_optional_non_negative_int(value: Optional[int], field_name: str) -> Optional[int]:
        if value is None:
            return None
        if not isinstance(value, int) or value < 0:
            raise ValueError(f"{field_name} must be a non-negative integer.")
        return value

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

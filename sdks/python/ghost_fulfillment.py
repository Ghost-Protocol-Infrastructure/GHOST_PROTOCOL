"""Ghost Protocol fulfillment helpers (Python SDK parity module).

This helper module is intended for local and server integrations.
It supports:
- consumer ticket issuance + direct merchant execute
- merchant ticket verification
- merchant capture completion
- fulfillment transport header helpers
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Optional
from urllib.parse import quote

import requests
from eth_account import Account
from eth_account.messages import encode_typed_data

FULFILLMENT_API_VERSION = 1
FULFILLMENT_DOMAIN_NAME = "GhostGateFulfillment"
FULFILLMENT_DOMAIN_VERSION = "1"
FULFILLMENT_DOMAIN_VERIFYING_CONTRACT = "0x0000000000000000000000000000000000000000"
FULFILLMENT_DEFAULT_CHAIN_ID = 8453
FULFILLMENT_ZERO_HASH_32 = "0x" + ("00" * 32)

HEADER_TICKET_VERSION = "x-ghost-fulfillment-ticket-version"
HEADER_TICKET_PAYLOAD = "x-ghost-fulfillment-ticket"
HEADER_TICKET_SIGNATURE = "x-ghost-fulfillment-ticket-sig"
HEADER_TICKET_ID = "x-ghost-fulfillment-ticket-id"
HEADER_CLIENT_REQUEST_ID = "x-ghost-fulfillment-client-request-id"
DEFAULT_FULFILLMENT_PROTOCOL_SIGNER_ADDRESSES = [
    "0xf879f5e26aa52663887f97a51d3444afef8df3fc",
]


def _normalize_base_url(value: str) -> str:
    return value.rstrip("/")


def _sha256_hex_utf8(value: str) -> str:
    return "0x" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonicalize_json(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise ValueError("Non-finite numbers are not allowed in canonical JSON.")
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, str):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_canonicalize_json(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        parts = []
        for key in keys:
            if not isinstance(key, str):
                raise ValueError("Canonical JSON only supports string object keys.")
            entry_value = value[key]
            if callable(entry_value):
                raise ValueError(f"Unsupported callable at key '{key}'")
            parts.append(json.dumps(key, separators=(",", ":"), ensure_ascii=False) + ":" + _canonicalize_json(entry_value))
        return "{" + ",".join(parts) + "}"
    raise ValueError(f"Unsupported value type for canonical JSON: {type(value).__name__}")


def hash_canonical_fulfillment_body_json(payload: Any) -> str:
    return _sha256_hex_utf8(_canonicalize_json(payload))


def _decode_form_component(value: str) -> str:
    # Validate percent escapes first
    i = 0
    while i < len(value):
        if value[i] == "%":
            if i + 2 >= len(value):
                raise ValueError("Malformed percent escape in query string.")
            if not all(c in "0123456789abcdefABCDEF" for c in value[i + 1 : i + 3]):
                raise ValueError("Malformed percent escape in query string.")
            i += 3
            continue
        i += 1
    from urllib.parse import unquote

    return unquote(value.replace("+", "%20"))


def _encode_rfc3986_upper(value: str) -> str:
    encoded = quote(value, safe="-._~")
    out: list[str] = []
    i = 0
    while i < len(encoded):
        if encoded[i] == "%" and i + 2 < len(encoded):
            out.append("%" + encoded[i + 1 : i + 3].upper())
            i += 3
        else:
            out.append(encoded[i])
            i += 1
    return "".join(out)


def canonicalize_fulfillment_query(raw_query: Optional[str]) -> str:
    source = (raw_query or "").strip()
    if source.startswith("?"):
        source = source[1:]
    if not source:
        return ""

    pairs: list[tuple[str, str]] = []
    seen_keys: set[str] = set()
    for part in [segment for segment in source.split("&") if segment]:
        if "=" in part:
            raw_key, raw_val = part.split("=", 1)
        else:
            raw_key, raw_val = part, ""
        key = _decode_form_component(raw_key)
        val = _decode_form_component(raw_val)
        if not key:
            raise ValueError("Empty query key is not supported in the current fulfillment flow.")
        if key in seen_keys:
            raise ValueError(f"Duplicate query key '{key}' is not supported in the current fulfillment flow.")
        seen_keys.add(key)
        pairs.append((key, val))

    pairs.sort(key=lambda item: (item[0], item[1]))
    return "&".join(f"{_encode_rfc3986_upper(k)}={_encode_rfc3986_upper(v)}" for k, v in pairs)


def hash_canonical_fulfillment_query(raw_query: Optional[str]) -> str:
    canonical = canonicalize_fulfillment_query(raw_query)
    return _sha256_hex_utf8(canonical) if canonical else FULFILLMENT_ZERO_HASH_32


def _b64url_encode_json(payload: dict[str, Any]) -> str:
    data = json.dumps(payload, separators=(",", ":"), sort_keys=False).encode("utf-8")
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode_json(payload: str) -> dict[str, Any]:
    padded = payload + "=" * ((4 - (len(payload) % 4)) % 4)
    decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    return json.loads(decoded)


def _normalize_hex32(value: str) -> str:
    normalized = value.strip().lower()
    if len(normalized) != 66 or not normalized.startswith("0x"):
        raise ValueError("Expected bytes32 hex string.")
    int(normalized[2:], 16)
    return normalized


def _normalize_signature(value: str) -> str:
    normalized = value.strip().lower()
    if not normalized.startswith("0x"):
        raise ValueError("Expected 0x-prefixed signature hex.")
    int(normalized[2:], 16)
    return normalized


def _normalize_address(value: str) -> str:
    normalized = value.strip().lower()
    if len(normalized) != 42 or not normalized.startswith("0x"):
        raise ValueError("Expected 20-byte address.")
    int(normalized[2:], 16)
    return normalized


def _typed_domain(chain_id: int) -> dict[str, Any]:
    return {
        "name": FULFILLMENT_DOMAIN_NAME,
        "version": FULFILLMENT_DOMAIN_VERSION,
        "chainId": chain_id,
        "verifyingContract": FULFILLMENT_DOMAIN_VERIFYING_CONTRACT,
    }


def _ticket_request_auth_typed_data(message: dict[str, Any], chain_id: int) -> dict[str, Any]:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "FulfillmentTicketRequestAuth": [
                {"name": "action", "type": "string"},
                {"name": "serviceSlug", "type": "string"},
                {"name": "method", "type": "string"},
                {"name": "path", "type": "string"},
                {"name": "queryHash", "type": "bytes32"},
                {"name": "bodyHash", "type": "bytes32"},
                {"name": "cost", "type": "uint256"},
                {"name": "issuedAt", "type": "uint256"},
                {"name": "nonce", "type": "string"},
            ],
        },
        "domain": _typed_domain(chain_id),
        "primaryType": "FulfillmentTicketRequestAuth",
        "message": message,
    }


def _delivery_proof_typed_data(message: dict[str, Any], chain_id: int) -> dict[str, Any]:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "FulfillmentDeliveryProof": [
                {"name": "ticketId", "type": "bytes32"},
                {"name": "deliveryProofId", "type": "bytes32"},
                {"name": "merchantSigner", "type": "address"},
                {"name": "serviceSlug", "type": "string"},
                {"name": "completedAt", "type": "uint256"},
                {"name": "statusCode", "type": "uint256"},
                {"name": "latencyMs", "type": "uint256"},
                {"name": "responseHash", "type": "bytes32"},
            ],
        },
        "domain": _typed_domain(chain_id),
        "primaryType": "FulfillmentDeliveryProof",
        "message": message,
    }


def _ticket_typed_data(message: dict[str, Any], chain_id: int) -> dict[str, Any]:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "FulfillmentTicket": [
                {"name": "ticketId", "type": "bytes32"},
                {"name": "consumer", "type": "address"},
                {"name": "merchantOwner", "type": "address"},
                {"name": "gatewayConfigIdHash", "type": "bytes32"},
                {"name": "serviceSlug", "type": "string"},
                {"name": "method", "type": "string"},
                {"name": "path", "type": "string"},
                {"name": "queryHash", "type": "bytes32"},
                {"name": "bodyHash", "type": "bytes32"},
                {"name": "cost", "type": "uint256"},
                {"name": "issuedAt", "type": "uint256"},
                {"name": "expiresAt", "type": "uint256"},
            ],
        },
        "domain": _typed_domain(chain_id),
        "primaryType": "FulfillmentTicket",
        "message": message,
    }


def build_fulfillment_ticket_headers(*, ticket_id: str, ticket: Mapping[str, Any], client_request_id: Optional[str] = None) -> dict[str, str]:
    headers = {
        HEADER_TICKET_VERSION: str(ticket.get("version", "")),
        HEADER_TICKET_PAYLOAD: str(ticket.get("payload", "")),
        HEADER_TICKET_SIGNATURE: _normalize_signature(str(ticket.get("signature", ""))),
        HEADER_TICKET_ID: _normalize_hex32(ticket_id),
    }
    if client_request_id:
        headers[HEADER_CLIENT_REQUEST_ID] = client_request_id.strip()
    return headers


def parse_fulfillment_ticket_headers(headers: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    lower = {str(k).lower(): v for k, v in headers.items()}
    version = str(lower.get(HEADER_TICKET_VERSION, "")).strip()
    payload = str(lower.get(HEADER_TICKET_PAYLOAD, "")).strip()
    signature = str(lower.get(HEADER_TICKET_SIGNATURE, "")).strip()
    ticket_id = str(lower.get(HEADER_TICKET_ID, "")).strip()
    if version != str(FULFILLMENT_API_VERSION) or not payload or not signature or not ticket_id:
        return None
    try:
        parsed = {
            "ticketId": _normalize_hex32(ticket_id),
            "ticket": {
                "version": FULFILLMENT_API_VERSION,
                "payload": payload,
                "signature": _normalize_signature(signature),
            },
            "clientRequestId": str(lower.get(HEADER_CLIENT_REQUEST_ID, "")).strip() or None,
        }
        return parsed
    except Exception:
        return None


@dataclass
class GhostFulfillmentConsumer:
    private_key: str
    base_url: str = os.getenv("GHOST_GATE_BASE_URL", "https://ghostprotocol.cc")
    chain_id: int = FULFILLMENT_DEFAULT_CHAIN_ID
    default_service_slug: str = "agent-18755"

    def __post_init__(self) -> None:
        self.private_key = self.private_key.strip()
        self.base_url = _normalize_base_url(self.base_url)
        if not self.private_key.startswith("0x") or len(self.private_key) != 66:
            raise ValueError("private_key must be a 0x-prefixed 32-byte hex key")

    def _sign_typed(self, typed_data: dict[str, Any]) -> str:
        signable = encode_typed_data(full_message=typed_data)
        return Account.sign_message(signable, private_key=self.private_key).signature.hex().lower()

    def request_ticket(
        self,
        *,
        path: str,
        service_slug: Optional[str] = None,
        method: str = "POST",
        query: Optional[str] = None,
        body_json: Optional[Any] = None,
        cost: int = 1,
        client_request_id: Optional[str] = None,
        timeout: int = 15,
    ) -> requests.Response:
        if cost <= 0:
            raise ValueError("cost must be > 0")
        service = (service_slug or self.default_service_slug).strip()
        method_norm = method.strip().upper()
        path_norm = path.strip()
        if not path_norm.startswith("/"):
            raise ValueError("path must start with '/'")
        query_str = (query or "").strip()
        issued_at = int(time.time())
        nonce = f"fx-{uuid.uuid4().hex}"

        auth_message = {
            "action": "fulfillment_ticket",
            "serviceSlug": service,
            "method": method_norm,
            "path": path_norm,
            "queryHash": hash_canonical_fulfillment_query(query_str),
            "bodyHash": hash_canonical_fulfillment_body_json(body_json if body_json is not None else {}),
            "cost": str(int(cost)),
            "issuedAt": str(issued_at),
            "nonce": nonce,
        }
        auth_signature = self._sign_typed(_ticket_request_auth_typed_data(auth_message, self.chain_id))

        payload = {
            "serviceSlug": service,
            "method": method_norm,
            "path": path_norm,
            "cost": int(cost),
            "query": query_str,
            "clientRequestId": client_request_id or f"fx-{int(time.time() * 1000)}",
            "ticketRequestAuth": {
                "payload": _b64url_encode_json(auth_message),
                "signature": auth_signature,
            },
        }
        return requests.post(
            f"{self.base_url}/api/fulfillment/ticket",
            json=payload,
            headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
            timeout=timeout,
        )

    def execute(
        self,
        *,
        path: str,
        service_slug: Optional[str] = None,
        method: str = "POST",
        query: Optional[str] = None,
        body_json: Optional[Any] = None,
        cost: int = 1,
        timeout: int = 20,
    ) -> dict[str, Any]:
        ticket_res = self.request_ticket(
            path=path,
            service_slug=service_slug,
            method=method,
            query=query,
            body_json=body_json,
            cost=cost,
        )
        ticket_payload: Any
        try:
            ticket_payload = ticket_res.json()
        except Exception:
            ticket_payload = None
        if ticket_res.status_code < 200 or ticket_res.status_code >= 300:
            return {
                "ticket": {"status": ticket_res.status_code, "payload": ticket_payload},
                "merchant": {"attempted": False},
            }

        if not isinstance(ticket_payload, dict):
            raise RuntimeError("Fulfillment ticket response was not JSON object")
        ticket = ticket_payload.get("ticket")
        ticket_id = str(ticket_payload.get("ticketId", ""))
        merchant_target = ticket_payload.get("merchantTarget") or {}
        endpoint_url = str((merchant_target or {}).get("endpointUrl", "")).rstrip("/")
        target_path = str((merchant_target or {}).get("path", path)).strip()
        if not endpoint_url:
            raise RuntimeError("Fulfillment ticket response missing merchantTarget.endpointUrl")

        full_url = endpoint_url + target_path
        if query:
            qs = query[1:] if str(query).startswith("?") else str(query)
            full_url = f"{full_url}?{qs}"

        headers = build_fulfillment_ticket_headers(ticket_id=ticket_id, ticket=ticket)
        headers.setdefault("accept", "application/json, text/plain;q=0.9, */*;q=0.8")
        if body_json is not None:
            headers.setdefault("content-type", "application/json")

        merchant_res = requests.request(
            method=method.strip().upper(),
            url=full_url,
            headers=headers,
            json=body_json if body_json is not None else None,
            timeout=timeout,
        )
        try:
            merchant_json = merchant_res.json()
        except Exception:
            merchant_json = None
        return {
            "ticket": {"status": ticket_res.status_code, "payload": ticket_payload},
            "merchant": {
                "attempted": True,
                "status": merchant_res.status_code,
                "url": full_url,
                "body": merchant_json if merchant_json is not None else merchant_res.text,
            },
        }


@dataclass
class GhostFulfillmentMerchant:
    protocol_signer_addresses: Optional[list[str]] = None
    delegated_private_key: Optional[str] = None
    base_url: str = os.getenv("GHOST_GATE_BASE_URL", "https://ghostprotocol.cc")
    chain_id: int = FULFILLMENT_DEFAULT_CHAIN_ID

    def __post_init__(self) -> None:
        self.base_url = _normalize_base_url(self.base_url)
        signer_addresses = self.protocol_signer_addresses or list(DEFAULT_FULFILLMENT_PROTOCOL_SIGNER_ADDRESSES)
        self.protocol_signer_addresses = [_normalize_address(addr) for addr in signer_addresses]
        if not self.protocol_signer_addresses:
            raise ValueError("At least one protocol signer address is required")
        if self.delegated_private_key:
            self.delegated_private_key = self.delegated_private_key.strip()

    def require_fulfillment_ticket(
        self,
        *,
        headers: Mapping[str, Any],
        method: Optional[str] = None,
        path: Optional[str] = None,
        query: Optional[str] = None,
        body_json: Any = None,
        expected_service_slug: Optional[str] = None,
        now_ms: Optional[int] = None,
    ) -> dict[str, Any]:
        parsed = parse_fulfillment_ticket_headers(headers)
        if not parsed:
            raise ValueError("Missing or invalid fulfillment ticket headers")

        payload = _b64url_decode_json(parsed["ticket"]["payload"])
        if _normalize_hex32(str(payload.get("ticketId", ""))) != parsed["ticketId"]:
            raise ValueError("ticketId header mismatch")

        signable = encode_typed_data(full_message=_ticket_typed_data(payload, self.chain_id))
        recovered = _normalize_address(Account.recover_message(signable, signature=parsed["ticket"]["signature"]))
        if recovered not in self.protocol_signer_addresses:
            raise ValueError("Ticket signer is not in allowed protocol signer set")

        now_seconds = int((now_ms if now_ms is not None else int(time.time() * 1000)) / 1000)
        if int(str(payload["expiresAt"])) < now_seconds:
            raise ValueError("Fulfillment ticket expired")

        if expected_service_slug and str(payload.get("serviceSlug", "")).strip() != expected_service_slug.strip():
            raise ValueError("serviceSlug mismatch")
        if method and str(payload.get("method", "")).strip().upper() != method.strip().upper():
            raise ValueError("method mismatch")
        if path and str(payload.get("path", "")).strip() != path.strip():
            raise ValueError("path mismatch")
        if query is not None and str(payload.get("queryHash", "")).strip().lower() != hash_canonical_fulfillment_query(query):
            raise ValueError("queryHash mismatch")
        if body_json is not None and str(payload.get("bodyHash", "")).strip().lower() != hash_canonical_fulfillment_body_json(body_json):
            raise ValueError("bodyHash mismatch")

        return {
            "ticketId": parsed["ticketId"],
            "ticket": parsed["ticket"],
            "payload": payload,
            "signer": recovered,
            "clientRequestId": parsed.get("clientRequestId"),
        }

    def _sign_delivery_proof(self, message: dict[str, Any]) -> str:
        if not self.delegated_private_key:
            raise ValueError("delegated_private_key is required for capture_completion")
        signable = encode_typed_data(full_message=_delivery_proof_typed_data(message, self.chain_id))
        return Account.sign_message(signable, private_key=self.delegated_private_key).signature.hex().lower()

    def capture_completion(
        self,
        *,
        ticket_id: str,
        service_slug: str,
        status_code: int,
        latency_ms: int,
        response_body_json: Any = None,
        response_body_text: Optional[str] = None,
        completed_at: Optional[int] = None,
        timeout: int = 15,
    ) -> requests.Response:
        if not self.delegated_private_key:
            raise ValueError("delegated_private_key is required")
        if status_code < 100 or status_code > 599:
            raise ValueError("status_code out of range")
        if latency_ms < 0:
            raise ValueError("latency_ms must be >= 0")

        merchant_signer = _normalize_address(Account.from_key(self.delegated_private_key).address)
        if response_body_json is not None:
            response_hash = hash_canonical_fulfillment_body_json(response_body_json)
        elif response_body_text is not None:
            response_hash = _sha256_hex_utf8(response_body_text)
        else:
            response_hash = FULFILLMENT_ZERO_HASH_32

        proof_message = {
            "ticketId": _normalize_hex32(ticket_id),
            "deliveryProofId": "0x" + os.urandom(32).hex(),
            "merchantSigner": merchant_signer,
            "serviceSlug": service_slug.strip(),
            "completedAt": str(int(completed_at if completed_at is not None else time.time())),
            "statusCode": str(int(status_code)),
            "latencyMs": str(int(latency_ms)),
            "responseHash": response_hash,
        }
        proof_signature = self._sign_delivery_proof(proof_message)
        delivery_proof = {"payload": _b64url_encode_json(proof_message), "signature": proof_signature}
        body = {
            "ticketId": proof_message["ticketId"],
            "deliveryProof": delivery_proof,
            "completionMeta": {
                "statusCode": int(status_code),
                "latencyMs": int(latency_ms),
                **({"responseHash": response_hash} if response_hash != FULFILLMENT_ZERO_HASH_32 else {}),
            },
        }
        return requests.post(
            f"{self.base_url}/api/fulfillment/capture",
            json=body,
            headers={"accept": "application/json, text/plain;q=0.9, */*;q=0.8"},
            timeout=timeout,
        )

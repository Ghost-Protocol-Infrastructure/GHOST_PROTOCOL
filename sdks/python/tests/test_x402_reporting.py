import asyncio
import json
import time
import threading
import unittest
from unittest.mock import Mock, patch

import requests
from eth_account import Account

from ghostgate import (
    GhostGate,
    GhostX402AdapterConfig,
    create_settlement_evidence,
    with_ghost_x402_fastapi,
    with_ghost_x402_flask,
)


OWNER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88"
OWNER_ADDRESS = Account.from_key(OWNER_PRIVATE_KEY).address.lower()


class _FakeRequest:
    def __init__(self, *, method="POST", url="https://merchant.test/paid", headers=None):
        self.method = method
        self.url = url
        self.headers = headers or {}


class _FakeFlaskResponse:
    def __init__(self, body, status_code, headers):
        self.body = body
        self.status_code = status_code
        self.headers = headers

    def get_json(self):
        return self.body if isinstance(self.body, dict) else json.loads(self.body)


class X402PythonTests(unittest.TestCase):
    def _response(self, status_code: int, payload=None, *, text=None, headers=None):
        response = Mock()
        response.ok = 200 <= status_code < 300
        response.status_code = status_code
        response.headers = headers or {}
        if payload is not None:
            response.json.return_value = payload
            response.text = text if text is not None else str(payload)
        else:
            response.json.side_effect = ValueError("not json")
            response.text = text or ""
        return response

    def _create_gate(self):
        return GhostGate(private_key=OWNER_PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-123")

    def test_create_settlement_evidence_normalizes_receiver_contract(self):
        evidence = create_settlement_evidence(
            request_id="req_123",
            payment_reference="0xABCD1234",
            payer_identity="0xpayer",
            payer_address="0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
            scheme="X402",
            network="base",
            chain_id=8453,
            asset="usdc",
            amount_atomic="1000000",
            decimals=6,
            success=True,
            status_code=200,
            latency_ms=245,
            occurred_at="2026-03-25T20:00:00.000Z",
            metadata={"rail": "x402"},
        )

        self.assertEqual(
            evidence,
            {
                "requestId": "req_123",
                "paymentReference": "0xabcd1234",
                "payerIdentity": "0xpayer",
                "payerAddress": "0x40dd75406eb154980ec17fadbfae4c6f841ac0fc",
                "scheme": "x402",
                "network": "base",
                "chainId": 8453,
                "asset": "USDC",
                "amountAtomic": "1000000",
                "decimals": 6,
                "success": True,
                "statusCode": 200,
                "latencyMs": 245,
                "occurredAt": "2026-03-25T20:00:00.000Z",
                "metadata": {"rail": "x402"},
            },
        )

    def test_create_settlement_evidence_rejects_invalid_ranges(self):
        invalid_cases = [
            ({"chain_id": 0}, "1000000"),
            ({"decimals": 19}, "1000000"),
            ({"status_code": 99}, "1000000"),
            ({"latency_ms": -1}, "1000000"),
            ({}, 0),
        ]

        for invalid, amount_atomic in invalid_cases:
            with self.assertRaises(ValueError):
                create_settlement_evidence(
                    request_id="req_123",
                    payment_reference="pay_123",
                    payer_identity="payer_123",
                    amount_atomic=amount_atomic,
                    success=True,
                    **invalid,
                )

    def test_report_x402_settlement_uses_canonical_evidence(self):
        gate = self._create_gate()

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post:
            mock_get.return_value = self._response(
                200,
                {
                    "configured": True,
                    "config": {
                        "ownerAddress": OWNER_ADDRESS,
                        "readinessStatus": "LIVE",
                    },
                },
            )
            mock_post.return_value = self._response(200, {"ok": True, "countedForRank": True, "relatedParty": False, "duplicate": False})

            result = gate.report_x402_settlement(
                agent_id="123",
                service_slug="agent-123",
                request_id="req_456",
                payment_reference="0xABCD1234",
                payer_identity="0xPayer",
                payer_address="0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
                scheme="X402",
                network="base",
                chain_id=8453,
                asset="usdc",
                amount_atomic=1000000,
                decimals=6,
                success=True,
                status_code=204,
                latency_ms=125,
                occurred_at="2026-03-25T20:00:00.000Z",
                metadata={"route": "/paid"},
            )

            self.assertTrue(result["ok"])
            body = mock_post.call_args.kwargs["json"]
            self.assertEqual(body["requestId"], "req_456")
            self.assertEqual(body["paymentReference"], "0xabcd1234")
            self.assertEqual(body["payerAddress"], "0x40dd75406eb154980ec17fadbfae4c6f841ac0fc")
            self.assertEqual(body["scheme"], "x402")
            self.assertEqual(body["asset"], "USDC")
            self.assertEqual(body["amountAtomic"], "1000000")
            self.assertEqual(body["statusCode"], 204)
            self.assertEqual(body["latencyMs"], 125)
            self.assertEqual(body["metadata"], {"route": "/paid"})

    def test_python_settlement_reporter_tracks_events_and_retries(self):
        gate = self._create_gate()
        events = []
        post_attempts = {"count": 0}

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post:
            mock_get.return_value = self._response(
                200,
                {
                    "configured": True,
                    "config": {
                        "ownerAddress": OWNER_ADDRESS,
                        "readinessStatus": "LIVE",
                    },
                },
            )

            def post_side_effect(*args, **kwargs):
                post_attempts["count"] += 1
                if post_attempts["count"] == 1:
                    raise requests.RequestException("temporary network failure")
                return self._response(200, {"ok": True, "countedForRank": True, "relatedParty": False, "duplicate": False})

            mock_post.side_effect = post_side_effect

            reporter = gate.create_x402_settlement_reporter(
                runtime="python_server",
                retry_delays_seconds=(0.0,),
                on_event=lambda event: events.append(event),
            )

            reporter.record_payment_verified(
                agent_id="123",
                service_slug="agent-123",
                request_id="req_async",
                payment_reference="0xABCD1234",
            )
            enqueue = reporter.enqueue(
                agent_id="123",
                service_slug="agent-123",
                request_id="req_async",
                payment_reference="0xabcd1234",
                payer_identity="payer_async",
                amount_atomic=1000000,
                success=True,
            )

            self.assertTrue(enqueue["accepted"])
            reporter.flush()

            snapshot = reporter.get_snapshot()
            self.assertEqual(snapshot["counters"]["paymentVerified"], 1)
            self.assertEqual(snapshot["counters"]["reportSent"], 2)
            self.assertEqual(snapshot["counters"]["reportAccepted"], 1)
            self.assertEqual(snapshot["counters"]["reportDropped"], 0)
            self.assertEqual(post_attempts["count"], 2)
            self.assertEqual(
                [event["name"] for event in events[:4]],
                ["payment_verified", "report_enqueued", "report_sent", "report_sent"],
            )
            self.assertEqual(events[-1]["name"], "report_accepted")

    def test_fastapi_adapter_wraps_paid_request_and_reports_async(self):
        gate = self._create_gate()
        settlement_bodies = []
        events = []

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post:
            mock_get.return_value = self._response(
                200,
                {
                    "configured": True,
                    "config": {
                        "ownerAddress": OWNER_ADDRESS,
                        "readinessStatus": "LIVE",
                    },
                },
            )

            def post_side_effect(*args, **kwargs):
                settlement_bodies.append(kwargs["json"])
                return self._response(200, {"ok": True, "countedForRank": True, "relatedParty": False, "duplicate": False})

            mock_post.side_effect = post_side_effect

            reporter = gate.create_x402_settlement_reporter(
                runtime="python_server",
                retry_delays_seconds=(0.0,),
                on_event=lambda event: events.append(event),
            )
            config = GhostX402AdapterConfig(
                gate=gate,
                agent_id="123",
                payment_requirements=[
                    {
                        "scheme": "exact",
                        "network": "base",
                        "maxAmountRequired": "1000000",
                        "asset": "USDC",
                        "extra": {"decimals": 6},
                    }
                ],
                x402_client=object(),
                reporter=reporter,
                decode_payment_header=lambda _: {"scheme": "exact", "network": "base"},
                verify_payment=lambda _: {"isValid": True, "payer": "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC"},
                settle_payment=lambda _: {
                    "success": True,
                    "transaction": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "network": "base",
                    "payer": "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
                },
            )

            handler = with_ghost_x402_fastapi(config, lambda _args: {"ok": True})
            response = asyncio.run(
                handler(
                    _FakeRequest(
                        headers={
                            "X-PAYMENT": "paid-header",
                        }
                    )
                )
            )

            for _ in range(50):
                if settlement_bodies or any(event["name"] == "report_dropped" for event in events):
                    break
                time.sleep(0.01)
            reporter.flush()

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers.get("X-PAYMENT-RESPONSE") is not None, True)
            self.assertEqual(reporter.get_snapshot()["counters"]["paymentVerified"], 1)
            self.assertEqual(len(settlement_bodies), 1)
            self.assertEqual(settlement_bodies[0]["paymentReference"].startswith("0x"), True)
            self.assertEqual(settlement_bodies[0]["chainId"], 8453)
            self.assertEqual([event["name"] for event in events[:4]], ["payment_verified", "report_enqueued", "report_sent", "report_accepted"])

    def test_fastapi_adapter_awaits_async_extension_hooks_and_preserves_reporting(self):
        gate = self._create_gate()
        settlement_bodies = []
        events = []

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post:
            mock_get.return_value = self._response(
                200,
                {
                    "configured": True,
                    "config": {
                        "ownerAddress": OWNER_ADDRESS,
                        "readinessStatus": "LIVE",
                    },
                },
            )

            def post_side_effect(*args, **kwargs):
                settlement_bodies.append(kwargs["json"])
                return self._response(200, {"ok": True, "countedForRank": True, "relatedParty": False, "duplicate": False})

            mock_post.side_effect = post_side_effect

            reporter = gate.create_x402_settlement_reporter(
                runtime="python_server",
                retry_delays_seconds=(0.0,),
                on_event=lambda event: events.append(event),
            )

            async def async_payer_identity(_args):
                await asyncio.sleep(0)
                return "payer_override"

            async def async_payer_address(_args):
                await asyncio.sleep(0)
                return "0xAaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"

            async def async_metadata(_args):
                await asyncio.sleep(0)
                return {"source": "async_hook"}

            config = GhostX402AdapterConfig(
                gate=gate,
                agent_id="123",
                payment_requirements=[
                    {
                        "scheme": "exact",
                        "network": "base",
                        "maxAmountRequired": "1000000",
                        "asset": "USDC",
                        "extra": {"decimals": 6},
                    }
                ],
                x402_client=object(),
                reporter=reporter,
                decode_payment_header=lambda _: {"scheme": "exact", "network": "base"},
                verify_payment=lambda _: {"isValid": True, "payer": "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC"},
                settle_payment=lambda _: {
                    "success": True,
                    "transaction": "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                    "network": "base",
                    "payer": "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
                },
                get_payer_identity=async_payer_identity,
                get_payer_address=async_payer_address,
                get_metadata=async_metadata,
            )

            handler = with_ghost_x402_fastapi(config, lambda args: {"payerIdentity": args["x402"]["payerIdentity"]})
            response = asyncio.run(
                handler(
                    _FakeRequest(
                        headers={
                            "X-PAYMENT": "paid-header",
                        }
                    )
                )
            )

            reporter.flush()

            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(settlement_bodies), 1)
            self.assertEqual(settlement_bodies[0]["payerIdentity"], "payer_override")
            self.assertEqual(settlement_bodies[0]["payerAddress"], "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            self.assertEqual(settlement_bodies[0]["metadata"], {"source": "async_hook"})
            self.assertEqual(settlement_bodies[0]["chainId"], 8453)
            self.assertEqual(events[0]["name"], "payment_verified")
            self.assertEqual(any(event["name"] == "report_dropped" for event in events), False)

    def test_flask_adapter_wraps_paid_request_and_reports_async(self):
        gate = self._create_gate()
        settlement_bodies = []

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post:
            mock_get.return_value = self._response(
                200,
                {
                    "configured": True,
                    "config": {
                        "ownerAddress": OWNER_ADDRESS,
                        "readinessStatus": "LIVE",
                    },
                },
            )
            mock_post.side_effect = lambda *args, **kwargs: settlement_bodies.append(kwargs["json"]) or self._response(
                200, {"ok": True, "countedForRank": True, "relatedParty": False, "duplicate": False}
            )

            reporter = gate.create_x402_settlement_reporter(runtime="python_server", retry_delays_seconds=(0.0,))
            config = GhostX402AdapterConfig(
                gate=gate,
                agent_id="123",
                payment_requirements=[
                    {
                        "scheme": "exact",
                        "network": "base",
                        "maxAmountRequired": "1000000",
                        "asset": "USDC",
                        "extra": {"decimals": 6},
                    }
                ],
                x402_client=object(),
                reporter=reporter,
                decode_payment_header=lambda _: {"scheme": "exact", "network": "base"},
                verify_payment=lambda _: {"isValid": True, "payer": "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC"},
                settle_payment=lambda _: {
                    "success": True,
                    "transaction": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "network": "base",
                    "payer": "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
                },
            )

            request = _FakeRequest(headers={"X-PAYMENT": "paid-header"})
            handler = with_ghost_x402_flask(
                config,
                lambda _args: {"ok": True},
                get_request=lambda: request,
                make_response=lambda body, status_code, headers: _FakeFlaskResponse(body, status_code, headers),
            )

            response = handler()
            reporter.flush()

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers.get("X-PAYMENT-RESPONSE") is not None, True)
            self.assertEqual(response.get_json(), {"ok": True})
            self.assertEqual(reporter.get_snapshot()["counters"]["paymentVerified"], 1)
            self.assertEqual(len(settlement_bodies), 1)

    def test_fastapi_adapter_does_not_block_response_on_async_metadata_resolution(self):
        gate = self._create_gate()
        settlement_bodies = []

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post:
            mock_get.return_value = self._response(
                200,
                {
                    "configured": True,
                    "config": {
                        "ownerAddress": OWNER_ADDRESS,
                        "readinessStatus": "LIVE",
                    },
                },
            )

            def post_side_effect(*args, **kwargs):
                settlement_bodies.append(kwargs["json"])
                return self._response(200, {"ok": True, "countedForRank": True, "relatedParty": False, "duplicate": False})

            mock_post.side_effect = post_side_effect

            metadata_release = threading.Event()

            async def slow_metadata(_args):
                await asyncio.to_thread(metadata_release.wait, 1.0)
                return {"source": "slow_async_hook"}

            reporter = gate.create_x402_settlement_reporter(runtime="python_server", retry_delays_seconds=(0.0,))
            config = GhostX402AdapterConfig(
                gate=gate,
                agent_id="123",
                payment_requirements=[
                    {
                        "scheme": "exact",
                        "network": "base",
                        "maxAmountRequired": "1000000",
                        "asset": "USDC",
                        "extra": {"decimals": 6},
                    }
                ],
                x402_client=object(),
                reporter=reporter,
                decode_payment_header=lambda _: {"scheme": "exact", "network": "base"},
                verify_payment=lambda _: {"isValid": True, "payer": "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC"},
                settle_payment=lambda _: {
                    "success": True,
                    "transaction": "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                    "network": "base",
                    "payer": "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
                },
                get_metadata=slow_metadata,
            )

            handler = with_ghost_x402_fastapi(config, lambda _args: {"ok": True})
            result = {}

            def invoke_handler():
                result["response"] = asyncio.run(
                    handler(
                        _FakeRequest(
                            headers={
                                "X-PAYMENT": "paid-header",
                            }
                        )
                    )
                )

            call_thread = threading.Thread(target=invoke_handler)
            call_thread.start()
            call_thread.join(timeout=0.25)

            self.assertFalse(call_thread.is_alive())
            self.assertEqual(result["response"].status_code, 200)
            self.assertEqual(len(settlement_bodies), 0)

            metadata_release.set()
            reporter.flush()

            self.assertEqual(len(settlement_bodies), 1)
            self.assertEqual(settlement_bodies[0]["metadata"], {"source": "slow_async_hook"})
            self.assertEqual(reporter.get_snapshot()["counters"]["reportAccepted"], 1)


if __name__ == "__main__":
    unittest.main()

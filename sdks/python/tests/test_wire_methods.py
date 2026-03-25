import unittest
from unittest.mock import Mock, patch

from ghostgate import GhostGate, build_wire_request_spec_hash


PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88"


class GhostWireMethodTests(unittest.TestCase):
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

    def test_prepare_wire_job_returns_direct_execution_payload(self):
        gate = GhostGate(private_key=PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-11")

        with patch("ghostgate.requests.post") as mock_post:
            mock_post.return_value = self._response(
                200,
                {
                    "ok": True,
                    "jobId": "wj_123",
                    "quoteId": "wq_123",
                    "chainId": 8453,
                    "jobExpiresAt": "2026-03-16T00:00:00.000Z",
                    "direct": {
                        "approvalMode": "exact",
                        "nextAction": "submit_create_artifact",
                    },
                },
            )

            result = gate.prepare_wire_job(
                quote_id="wq_123",
                client="0x1111111111111111111111111111111111111111",
                provider="0x2222222222222222222222222222222222222222",
                evaluator="0x3333333333333333333333333333333333333333",
                provider_agent_id="18755",
                provider_service_slug="agent-18755",
                spec_hash="0x" + ("aa" * 32),
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["jobId"], "wj_123")
            self.assertEqual(mock_post.call_args.kwargs["json"]["providerAgentId"], "18755")
            self.assertEqual(mock_post.call_args.kwargs["json"]["providerServiceSlug"], "agent-18755")
            self.assertEqual(result["direct"]["nextAction"], "submit_create_artifact")

    def test_prepare_wire_job_derives_spec_hash_from_request_payload(self):
        gate = GhostGate(private_key=PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-11")

        with patch("ghostgate.requests.post") as mock_post:
            mock_post.return_value = self._response(
                200,
                {
                    "ok": True,
                    "jobId": "wj_derived",
                    "quoteId": "wq_derived",
                    "chainId": 8453,
                    "jobExpiresAt": "2026-03-16T00:00:00.000Z",
                    "direct": {
                        "approvalMode": "exact",
                        "nextAction": "submit_create_artifact",
                    },
                },
            )

            request_payload = {
                "prompt": "Roast my wallet honestly.",
                "walletAddress": "0x1111111111111111111111111111111111111111",
                "metadata": {"skill": "booski", "tone": "merciless"},
            }

            gate.prepare_wire_job(
                quote_id="wq_derived",
                client="0x1111111111111111111111111111111111111111",
                provider="0x2222222222222222222222222222222222222222",
                evaluator="0x3333333333333333333333333333333333333333",
                request=request_payload,
            )

            self.assertEqual(
                mock_post.call_args.kwargs["json"]["specHash"],
                build_wire_request_spec_hash(request_payload),
            )
            self.assertEqual(
                mock_post.call_args.kwargs["json"]["request"],
                {
                    "version": 1,
                    "prompt": "Roast my wallet honestly.",
                    "walletAddress": "0x1111111111111111111111111111111111111111",
                    "metadata": {"skill": "booski", "tone": "merciless"},
                },
            )

    def test_create_wire_quote_passes_provider_attribution(self):
        gate = GhostGate(private_key=PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-11")

        with patch("ghostgate.requests.post") as mock_post:
            mock_post.return_value = self._response(200, {"ok": True, "quoteId": "wq_123"})

            result = gate.create_wire_quote(
                client="0x1111111111111111111111111111111111111111",
                provider="0x2222222222222222222222222222222222222222",
                evaluator="0x3333333333333333333333333333333333333333",
                principal_amount="1000000",
                provider_agent_id="18755",
                provider_service_slug="agent-18755",
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["quoteId"], "wq_123")
            self.assertEqual(mock_post.call_args.kwargs["json"]["client"], "0x1111111111111111111111111111111111111111")
            self.assertEqual(mock_post.call_args.kwargs["json"]["providerAgentId"], "18755")
            self.assertEqual(mock_post.call_args.kwargs["json"]["providerServiceSlug"], "agent-18755")

    def test_record_wire_artifacts_signs_client_wallet_auth(self):
        gate = GhostGate(private_key=PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-11")

        with patch("ghostgate.requests.post") as mock_post:
            mock_post.return_value = self._response(
                200,
                {
                    "ok": True,
                    "job": {
                        "jobId": "wj_123",
                        "contractState": "OPEN",
                    },
                    "direct": {
                        "nextAction": "submit_fund_artifact",
                    },
                },
            )

            result = gate.record_wire_artifacts(
                job_id="wj_123",
                client_address="0xaB3D9542d5CCF40526b22AC072Fba32538E22d8c",
                create_tx_hash="0x" + ("aa" * 32),
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["job"]["jobId"], "wj_123")
            payload = mock_post.call_args.kwargs["json"]
            self.assertEqual(payload["createTxHash"], "0x" + ("aa" * 32))
            self.assertEqual(payload["authPayload"]["jobId"], "wj_123")
            self.assertEqual(payload["authPayload"]["clientAddress"], "0xab3d9542d5ccf40526b22ac072fba32538e22d8c")
            self.assertTrue(isinstance(payload["authSignature"], str) and len(payload["authSignature"]) == 130)

    def test_get_wire_deliverable_fetches_locator(self):
        gate = GhostGate(private_key=PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-11")

        job_response = self._response(
            200,
            {
                "ok": True,
                "job": {
                    "jobId": "wj_456",
                    "contractState": "COMPLETED",
                    "metadataUri": "https://merchant.example.com/deliverable?quoteId=wq_456",
                    "deliverable": {
                        "available": True,
                        "locatorUrl": "https://merchant.example.com/deliverable?quoteId=wq_456",
                    },
                },
            },
        )
        deliverable_response = self._response(
            200,
            {"roast": "GhostWire cleared escrow before your alpha did."},
            text='{"roast":"GhostWire cleared escrow before your alpha did."}',
            headers={"content-type": "application/json"},
        )

        with patch("ghostgate.requests.get") as mock_get:
            mock_get.side_effect = [job_response, deliverable_response]

            result = gate.get_wire_deliverable("wj_456")

            self.assertTrue(result["ok"])
            self.assertEqual(result["sourceUrl"], "https://merchant.example.com/deliverable?quoteId=wq_456")
            self.assertEqual(result["bodyJson"]["roast"], "GhostWire cleared escrow before your alpha did.")


if __name__ == "__main__":
    unittest.main()

import unittest
from unittest.mock import Mock, patch

from ghostgate import GhostGate


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

    def test_create_wire_job_uses_exec_secret(self):
        gate = GhostGate(private_key=PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-11")

        with patch("ghostgate.requests.post") as mock_post, patch("ghostgate.os.getenv") as mock_getenv:
            mock_getenv.side_effect = lambda key, default=None: "super-secret" if key == "GHOSTWIRE_EXEC_SECRET" else default
            mock_post.return_value = self._response(200, {"ok": True, "jobId": "wj_123"})

            result = gate.create_wire_job(
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
            self.assertEqual(mock_post.call_args.kwargs["headers"]["Authorization"], "Bearer super-secret")
            self.assertEqual(mock_post.call_args.kwargs["json"]["providerAgentId"], "18755")
            self.assertEqual(mock_post.call_args.kwargs["json"]["providerServiceSlug"], "agent-18755")

    def test_create_wire_quote_passes_provider_attribution(self):
        gate = GhostGate(private_key=PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-11")

        with patch("ghostgate.requests.post") as mock_post:
            mock_post.return_value = self._response(200, {"ok": True, "quoteId": "wq_123"})

            result = gate.create_wire_quote(
                provider="0x2222222222222222222222222222222222222222",
                evaluator="0x3333333333333333333333333333333333333333",
                principal_amount="1000000",
                provider_agent_id="18755",
                provider_service_slug="agent-18755",
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["quoteId"], "wq_123")
            self.assertEqual(mock_post.call_args.kwargs["json"]["providerAgentId"], "18755")
            self.assertEqual(mock_post.call_args.kwargs["json"]["providerServiceSlug"], "agent-18755")

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

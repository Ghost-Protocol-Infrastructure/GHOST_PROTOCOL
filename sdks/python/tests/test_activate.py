import unittest
from unittest.mock import Mock, patch

from eth_account import Account

from ghostgate import GhostGate


OWNER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88"
OWNER_ADDRESS = Account.from_key(OWNER_PRIVATE_KEY).address.lower()


class ActivateTests(unittest.TestCase):
    def _response(self, status_code: int, payload: dict):
        response = Mock()
        response.ok = 200 <= status_code < 300
        response.status_code = status_code
        response.json.return_value = payload
        response.text = str(payload)
        return response

    def test_activate_happy_path(self):
        gate = GhostGate(private_key=OWNER_PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-11")

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post, patch.object(
            GhostGate, "start_heartbeat"
        ) as mock_heartbeat:
            mock_get.return_value = self._response(
                200,
                {
                    "configured": False,
                    "config": {
                        "ownerAddress": OWNER_ADDRESS,
                        "readinessStatus": "UNCONFIGURED",
                    },
                },
            )
            mock_post.side_effect = [
                self._response(
                    200,
                    {
                        "ok": True,
                        "config": {
                            "ownerAddress": OWNER_ADDRESS,
                            "readinessStatus": "CONFIGURED",
                        },
                    },
                ),
                self._response(200, {"ok": True, "verified": True, "readinessStatus": "LIVE"}),
                self._response(200, {"ok": True, "created": True, "alreadyActive": False}),
            ]
            mock_heartbeat.return_value = Mock()

            result = gate.activate(
                agent_id="11",
                service_slug="agent-11",
                endpoint_url="https://merchant.example.com",
            )

            self.assertEqual(result["status"], "LIVE")
            self.assertEqual(result["readiness"], "LIVE")
            self.assertEqual(mock_post.call_count, 3)
            self.assertTrue(mock_heartbeat.called)

    def test_activate_verify_failure(self):
        gate = GhostGate(private_key=OWNER_PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-22")

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post:
            mock_get.return_value = self._response(
                200,
                {
                    "configured": True,
                    "config": {
                        "ownerAddress": OWNER_ADDRESS,
                        "readinessStatus": "CONFIGURED",
                    },
                },
            )
            mock_post.side_effect = [
                self._response(
                    200,
                    {
                        "ok": True,
                        "config": {
                            "ownerAddress": OWNER_ADDRESS,
                            "readinessStatus": "CONFIGURED",
                        },
                    },
                ),
                self._response(
                    422,
                    {
                        "ok": False,
                        "verified": False,
                        "readinessStatus": "DEGRADED",
                        "error": "Canary endpoint returned HTTP 500.",
                    },
                ),
            ]

            with self.assertRaisesRegex(ValueError, r"\[activate:verify\].*HTTP 500"):
                gate.activate(
                    agent_id="22",
                    service_slug="agent-22",
                    endpoint_url="https://merchant.example.com",
                )

    def test_activate_is_idempotent_for_already_active_signer(self):
        gate = GhostGate(private_key=OWNER_PRIVATE_KEY, base_url="https://ghostprotocol.cc", service_slug="agent-33")

        with patch("ghostgate.requests.get") as mock_get, patch("ghostgate.requests.post") as mock_post, patch.object(
            GhostGate, "start_heartbeat"
        ) as mock_heartbeat:
            mock_get.side_effect = [
                self._response(
                    200,
                    {
                        "configured": True,
                        "config": {
                            "ownerAddress": OWNER_ADDRESS,
                            "readinessStatus": "LIVE",
                        },
                    },
                ),
                self._response(
                    200,
                    {
                        "configured": True,
                        "config": {
                            "ownerAddress": OWNER_ADDRESS,
                            "readinessStatus": "LIVE",
                        },
                    },
                ),
            ]
            mock_post.side_effect = [
                self._response(200, {"ok": True, "config": {"ownerAddress": OWNER_ADDRESS}}),
                self._response(200, {"ok": True, "verified": True, "readinessStatus": "LIVE"}),
                self._response(200, {"ok": True, "created": True, "alreadyActive": False}),
                self._response(200, {"ok": True, "config": {"ownerAddress": OWNER_ADDRESS}}),
                self._response(200, {"ok": True, "verified": True, "readinessStatus": "LIVE"}),
                self._response(200, {"ok": True, "created": False, "alreadyActive": True}),
            ]
            mock_heartbeat.return_value = Mock()

            first = gate.activate(agent_id="33", service_slug="agent-33", endpoint_url="https://merchant.example.com")
            second = gate.activate(agent_id="33", service_slug="agent-33", endpoint_url="https://merchant.example.com")

            self.assertEqual(first["readiness"], "LIVE")
            self.assertEqual(second["readiness"], "LIVE")
            self.assertEqual(second["signerRegistration"]["alreadyActive"], True)


if __name__ == "__main__":
    unittest.main()

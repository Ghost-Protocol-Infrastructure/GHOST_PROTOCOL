import unittest

from ghostgate import GhostGate


OWNER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88"


class CreditPolicyTests(unittest.TestCase):
    def test_default_credit_cost_uses_express_minimum(self):
        gate = GhostGate(private_key=OWNER_PRIVATE_KEY)
        self.assertEqual(gate.credit_cost, 5)

    def test_constructor_rejects_credit_cost_below_express_minimum(self):
        with self.assertRaisesRegex(ValueError, r"at least 5"):
            GhostGate(private_key=OWNER_PRIVATE_KEY, credit_cost=4)

    def test_guard_rejects_cost_below_express_minimum(self):
        gate = GhostGate(private_key=OWNER_PRIVATE_KEY, credit_cost=5)
        with self.assertRaisesRegex(ValueError, r"at least 5"):
            gate.guard(cost=1)

    def test_guard_accepts_express_minimum(self):
        gate = GhostGate(private_key=OWNER_PRIVATE_KEY, credit_cost=5)
        decorator = gate.guard(cost=5)
        self.assertTrue(callable(decorator))


if __name__ == "__main__":
    unittest.main()

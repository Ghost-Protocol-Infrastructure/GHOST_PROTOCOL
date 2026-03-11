import { parseAbi } from "viem";

export const GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI = parseAbi([
  "function paymentToken() view returns (address)",
  "function platformFeeBP() view returns (uint256)",
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description) returns (uint256 jobId)",
  "function setBudget(uint256 jobId, uint256 amount)",
  "function fund(uint256 jobId, uint256 expectedBudget)",
  "function getJob(uint256 jobId) view returns ((uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status))",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt)",
  "event BudgetSet(uint256 indexed jobId, uint256 amount)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
]);

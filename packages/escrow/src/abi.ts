/**
 * ERC-8183 AgenticCommerce, subset we use. Taken from the verified implementation behind the Arc testnet
 * proxy 0x0747EEf0706327138c69792bF28Cd525089e4583 (impl 0xa316fd02827242d537f84730f8a37d0ba5fd351a), 2026-09-15.
 */
export const AGENTIC_COMMERCE_ABI = [
  { type: "function", name: "createJob", stateMutability: "nonpayable", inputs: [{ name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "expiredAt", type: "uint256" }, { name: "description", type: "string" }, { name: "hook", type: "address" }], outputs: [{ name: "jobId", type: "uint256" }] },
  { type: "function", name: "setBudget", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "fund", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "submit", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "deliverable", type: "bytes32" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "complete", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "reason", type: "bytes32" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "reject", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "reason", type: "bytes32" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "claimRefund", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "getJob", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ name: "", type: "tuple", components: [{ name: "id", type: "uint256" }, { name: "client", type: "address" }, { name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "description", type: "string" }, { name: "budget", type: "uint256" }, { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" }, { name: "hook", type: "address" }] }] },
  { type: "function", name: "jobCounter", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "jobHasBudget", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "paymentToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "platformFeeBP", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "evaluatorFeeBP", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "event", name: "JobCreated", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "evaluator", type: "address", indexed: false }, { name: "expiredAt", type: "uint256", indexed: false }, { name: "hook", type: "address", indexed: false }] },
  { type: "event", name: "BudgetSet", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "JobFunded", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "JobSubmitted", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "deliverable", type: "bytes32", indexed: false }] },
  { type: "event", name: "JobCompleted", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "evaluator", type: "address", indexed: true }, { name: "reason", type: "bytes32", indexed: false }] },
  { type: "event", name: "JobRejected", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "rejector", type: "address", indexed: true }, { name: "reason", type: "bytes32", indexed: false }] },
  { type: "event", name: "PaymentReleased", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "Refunded", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

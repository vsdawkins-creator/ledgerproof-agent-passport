# Changelog

## 0.1.0
- Initial release. Agent Passport — LedgerProof's authorization + receipt layer for x402
  machine payments (a companion to x402, not a replacement).
  - `AgentPassport` / `PassportSession` — the `agent.buy(...)` developer fast lane.
  - `requirePassport()` — ProofGateway provider middleware (Express-style).
  - `makeViemSigner()` — reference EIP-3009 x402 signer (viem).

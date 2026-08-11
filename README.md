# LedgerProof — Agent Passport

**LedgerProof gives agents a Passport to buy and use paid services safely.**

Technically: Agent Passport is LedgerProof's low-latency **authorization + receipt** layer for x402 and other
machine-payment flows. It is a **companion to x402, not a replacement** — x402 stays the payment rail and never
depends on LedgerProof. You opt in, per route, when you want more than commodity access.

| Question | x402 answers | LedgerProof / Agent Passport answers |
|---|---|---|
| Can this client pay? | ✅ payment proof is valid | not its job |
| Did value transfer? | ✅ facilitator/chain confirms settlement | records the linked evidence |
| **Who** authorized the agent? | usually not | principal, organization, delegated agent |
| Was this purchase **permitted**? | usually not | scope, vendor, route, purpose, amount, expiry |
| Can we **stop** the agent now? | wallet controls may help | revoke the Passport/session, block the route |
| What **exactly** did it receive? | payment alone can't prove it | request/result hashes + provider-signed receipt |
| Can finance/audit **reconcile** it? | partial chain record | business-context receipt + export |

## The stack

```
LedgerProof
├─ Evidence layer   signed receipts · tamper-evident history · reconciliation exports · receipt verification
├─ Control layer    org mandates · agent identity · spend limits + provider allowlists · revocation · sessions
└─ Agent Passport   the fast lane: SDK · provider middleware · short-lived sessions · local verification
                    · x402 payment adapter · portable receipts
```

Brand architecture — one system, a clear product per buyer:

| Name | Audience | Job |
|---|---|---|
| **LedgerProof** | enterprise, providers, auditors | trust, policy, receipts, verification, controls |
| **Agent Passport** | agent developers | fast, scoped access to paid APIs |
| **ProofGateway** | API providers | middleware to verify a Passport, settle x402, issue a receipt |
| **ProofReceipt** | finance, security, compliance | signed evidence linking authority → request → settled payment → response hash (existence/integrity, not delivery proof) |
| **ProofConsole** | organizations | mandates, budgets, policy, revocation, reporting |

## How it works with x402

x402 stays exactly as it is: the provider returns a `402` with payment terms; the agent supplies a signed
payment; a facilitator verifies/settles it; the provider returns the resource. Agent Passport adds the
governance context **above** settlement:

1. A principal creates a **mandate** for a specific agent, provider, route set, spend cap, and purpose.
2. The agent exchanges that mandate for a short-lived **Passport session** (spend- and call-capped).
3. Per call, the agent sends `Passport + nonce + X-PAYMENT`. The gateway verifies the Passport locally,
   **atomically** consumes a monotonic nonce and session budget (route + revocation checked in the same lock),
   verifies **and settles** the x402 payment, returns the resource, and emits a signed **ProofReceipt**.
4. Every call appends to a **per-session hash-chained evidence log**; the org can **revoke** instantly.

The provider releases a premium route only after **both** (a) a Passport authorizes the exact route + terms
**and** (b) x402 payment verification + settlement succeed.

## Quickstart — agent (buyer)

```js
import { AgentPassport } from "./agent-passport.mjs";

const pp = new AgentPassport({
  gateway: "https://ledgerproofhq.io/api/laen/proofgate",
  provider: "proofgate-demo",
  signPayment,                         // (requirements) => base64 X-PAYMENT — your wallet/x402 signer
});

const session = await pp.openSession({
  mandate,                             // issued by your org admin (POST /mandates)
  allowedRoutes: ["/v1/premium-market-data"],
  budgetUsd: 5, maxCalls: 50,
});

const { result, receipt, session: s } = await session.buy(
  "/v1/premium-market-data", { query: { symbol: "ETH" }, amount: 0.25 });
// nonce, remaining budget/calls tracked for you; `receipt` is portable + independently verifiable.
```

## Quickstart — provider (seller)

```js
import express from "express";
import { requirePassport } from "./proofgateway-middleware.mjs";

const app = express();
app.get("/v1/premium-market-data",
  requirePassport({ provider: "your-provider-id", route: "/v1/premium-market-data", priceUsd: 0.25 }),
  (req, res) => {
    // reached ONLY with a valid Passport + a settled x402 payment for this exact request.
    // req.ledgerproof.receipt is the signed, anchored ProofReceipt.
    res.json({ symbol: req.query.symbol, data: "…premium payload…" });
  });
```

Routes you don't wrap keep working exactly as before — the requirement is opt-in and route-scoped.

## Verifying a receipt

A ProofReceipt is an EdDSA JWT (typ `LP-RECEIPT`) plus a public-record anchor. Verify it anywhere:

```js
const jwks = await pp.jwks();                       // GET /.well-known/jwks.json — cache it
const check = await pp.verify(receipt.jwt, "LP-RECEIPT");   // or verify locally with the JWKS
// receipt_anchor.verify_url resolves the anchored entry on the public record.
```

**Proof scope (honest by construction):** a receipt attests the *existence and integrity* of the authorization,
the settled payment reference, and the request/response hashes — **not** the truth or quality of the provider's
response content.

## The adoption ladder

Value is opt-in and earned, never forced:

- **x402 alone** → ordinary, commodity paid access.
- **x402 + Agent Passport** → verified, scoped, budgeted access; higher limits; predictable pricing; portable receipts.
- **x402 + Passport + ProofReceipt** → delegated org budgets, licensed-data usage rights, finance reconciliation, audit-grade evidence.

## Security boundary

This SDK is the developer-facing client for the **live** LedgerProof gateway (the gateway runs real EdDSA signing,
real x402 facilitator verify+**settle**, real witness anchoring, and an atomic nonce/budget/revocation guard). Before
you move real funds you still own: a funded Base-USDC wallet + a real x402 signer (`signPayment`), org-authenticated
mandate issuance, and your own key custody. The gateway never holds your wallet keys — you sign every payment.

*x402 remains the payment rail. LedgerProof makes trusted machine commerce operationally viable on top of it.*

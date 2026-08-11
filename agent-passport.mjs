// @ledgerproof/agent-passport — the developer "fast lane" for buying paid services safely.
//
// COMPANION TO x402, NOT A REPLACEMENT. x402 is still the payment rail; this SDK adds bounded
// authorization (org mandate → short-lived session → per-call nonce + budget) and portable,
// audit-grade receipts on top of it. x402 works fine without it; with it you get verified,
// scoped, budgeted access and receipts finance can reconcile.
//
// Zero hard dependencies. You supply a `signPayment(requirements)` that returns a base64
// X-PAYMENT (use x402-fetch, Coinbase AgentKit, or viem+EIP-3009 — see ./examples/sign-viem.mjs).
//
//   const pp = new AgentPassport({
//     gateway: "https://ledgerproofhq.io/api/laen/proofgate",
//     provider: "proofgate-demo",
//     signPayment,                       // (requirements) => Promise<base64 X-PAYMENT>
//   });
//   const session = await pp.openSession({ mandate, allowedRoutes: ["/v1/premium-market-data"], budgetUsd: 5, maxCalls: 50 });
//   const { result, receipt, session: s } = await session.buy("/v1/premium-market-data", { query: { symbol: "ETH" }, amount: 0.25 });
//   // s.remaining_budget, s.remaining_calls, s.next_nonce are tracked for you; receipt is portable + verifiable.

const DEFAULT_GATEWAY = "https://ledgerproofhq.io/api/laen/proofgate";

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
async function get(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

export class AgentPassport {
  /** @param {{gateway?:string, provider:string, signPayment:(requirements:any)=>Promise<string>}} opts */
  constructor({ gateway = DEFAULT_GATEWAY, provider, signPayment }) {
    if (!provider) throw new Error("AgentPassport: `provider` is required");
    if (typeof signPayment !== "function") throw new Error("AgentPassport: `signPayment(requirements)` is required");
    this.gateway = gateway.replace(/\/$/, "");
    this.provider = provider;
    this.signPayment = signPayment;
  }

  /** Fetch the provider's verification keys (JWKS) so you can verify receipts locally, off the request path. */
  async jwks() { return (await get(`${this.gateway}/.well-known/jwks.json`)).body; }

  /** Verify any permit / passport / receipt at the gateway (or do it locally with the JWKS). */
  async verify(token, type, audience = this.provider) {
    return (await post(`${this.gateway}/verify`, { token, type, audience })).body;
  }

  /**
   * Exchange a mandate for a short-lived, spend/call-capped session (a Passport).
   * @param {{mandate:string, allowedRoutes:string[], budgetUsd?:number, maxCalls?:number, ttlSeconds?:number}} o
   */
  async openSession({ mandate, allowedRoutes, budgetUsd, maxCalls, ttlSeconds }) {
    if (!mandate || !Array.isArray(allowedRoutes) || allowedRoutes.length === 0)
      throw new Error("openSession: `mandate` and non-empty `allowedRoutes` are required");
    const { status, body } = await post(`${this.gateway}/sessions`, {
      mandate, provider: this.provider, allowedRoutes,
      ...(budgetUsd != null ? { budgetUsd } : {}), ...(maxCalls != null ? { maxCalls } : {}), ...(ttlSeconds != null ? { ttlSeconds } : {}),
    });
    if (status !== 201) throw new PassportError("open_session_failed", status, body);
    return new PassportSession(this, body);
  }
}

/** A live session that tracks the monotonic nonce and remaining budget/calls for you. */
export class PassportSession {
  constructor(client, created) {
    this._c = client;
    this.sessionId = created.sessionId;
    this.passport = created.passport;
    this.provider = created.provider;
    this.allowedRoutes = created.allowedRoutes;
    this.perCallMax = Number(created.perCallMax);
    this.budgetUsd = Number(created.budgetUsd);
    this.maxCalls = Number(created.maxCalls);
    this.expiresInSeconds = created.expiresInSeconds;
    this._nonce = Number(created.nextNonce || 1);
    this.remainingBudget = this.budgetUsd;
    this.remainingCalls = this.maxCalls;
    this.receipts = [];
  }

  /**
   * Make ONE bounded purchase under this session: build+sign the x402 payment, authorize through the
   * gateway (nonce + budget + route enforced atomically server-side), and return the signed receipt.
   * @param {string} route  one of allowedRoutes
   * @param {{query?:object, amount?:number, method?:string, responseHash?:string}} [o]
   */
  async buy(route, { query = {}, amount, method = "GET", responseHash } = {}) {
    if (!this.allowedRoutes.includes(route)) throw new Error(`buy: route ${route} is not in this session's allowedRoutes`);
    const callAmount = amount != null ? Number(amount) : this.perCallMax;
    if (callAmount > this.perCallMax + 1e-9) throw new Error(`buy: amount ${callAmount} exceeds per-call cap ${this.perCallMax}`);
    if (callAmount > this.remainingBudget + 1e-9) throw new Error(`buy: amount ${callAmount} exceeds remaining session budget ${this.remainingBudget}`);

    // 1) fetch the real x402 terms (payTo / asset / atomic value) for this exact route+amount, then sign an X-PAYMENT
    const quote = await get(`${this._c.gateway}/quote?resource=${encodeURIComponent(route)}&amount=${callAmount}`);
    if (quote.status !== 200 || !quote.body?.accepts?.[0]) throw new PassportError("quote_failed", quote.status, quote.body);
    const requirements = quote.body.accepts[0];   // { scheme, network, maxAmountRequired, resource, payTo, asset, extra, ... }
    const payment = await this._c.signPayment(requirements);
    if (!payment || typeof payment !== "string") throw new Error("buy: signPayment must return a base64 X-PAYMENT string");

    // 2) authorize through the gateway (verify → atomic consume(nonce/budget/route/revoked) → settle → anchored receipt)
    const nonce = this._nonce;
    const { status, body } = await post(`${this._c.gateway}/sessions/authorize`, {
      passport: this.passport, nonce, route, amount: callAmount, payment,
      request: { provider: this.provider, method, query }, ...(responseHash ? { responseHash } : {}),
    });

    if (status === 200) {
      this._nonce = Number(body.session?.next_nonce ?? nonce + 1);
      if (body.session) { this.remainingBudget = Number(body.session.remaining_budget); this.remainingCalls = Number(body.session.remaining_calls); }
      const receipt = { jwt: body.receipt, anchor: body.receipt_anchor, evidence: body.evidence, session_id: this.sessionId, nonce };
      this.receipts.push(receipt);
      return { result: body.result, receipt, session: body.session };
    }
    // On a settle failure the server refunds the budget but the nonce is consumed — advance and let the caller retry.
    if (body?.error === "settlement_failed") { this._nonce = nonce + 1; }
    throw new PassportError(body?.error || "authorize_failed", status, body);
  }

  /** Current session status + hash-chained evidence log (for your own audit / ProofConsole). */
  async status() { return (await get(`${this._c.gateway}/sessions/${this.sessionId}`)).body; }
  async evidence() { return (await get(`${this._c.gateway}/sessions/${this.sessionId}/evidence`)).body; }
}

export class PassportError extends Error {
  constructor(code, status, body) {
    super(`${code} (HTTP ${status})${body?.reason ? ": " + body.reason : ""}`);
    this.name = "PassportError"; this.code = code; this.status = status; this.body = body;
  }
}

export default AgentPassport;

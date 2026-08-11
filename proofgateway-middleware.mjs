// @ledgerproof/proofgateway — provider middleware (Express-style).
//
// Lets an x402 provider CHOOSE to reserve a route for Passport-bearing agents. It does not replace
// your x402 flow — it sits in front of it: a request without a Passport + payment gets a 402 (with your
// x402 terms AND the LedgerProof requirement); a request WITH both is verified + settled through the
// LedgerProof gateway, and only then does your handler run. You get verified traffic, spend controls,
// and a signed receipt on `req.ledgerproof` for every fulfilled call.
//
//   import express from "express";
//   import { requirePassport } from "@ledgerproof/proofgateway";
//   const app = express();
//   app.get("/v1/premium-market-data",
//     requirePassport({ provider: "your-provider-id", route: "/v1/premium-market-data", priceUsd: 0.25 }),
//     (req, res) => {
//       // reached ONLY when a valid Passport session authorized this exact request AND the x402 payment settled.
//       // req.ledgerproof = { session_id, nonce, receipt, receipt_anchor, evidence }
//       res.json({ symbol: req.query.symbol, data: "…your premium payload…" });
//     });
//
// The LedgerProof requirement is OPT-IN and route-scoped: routes you don't wrap keep working exactly as before.

const DEFAULT_GATEWAY = "https://ledgerproofhq.io/api/laen/proofgate";

// Recursive, sorted-key canonicalization — MUST match the gateway so the request hashes agree.
function canonical(v) {
  const sortDeep = (x) => Array.isArray(x) ? x.map(sortDeep)
    : (x && typeof x === "object") ? Object.keys(x).sort().reduce((o, k) => (o[k] = sortDeep(x[k]), o), {}) : x;
  return JSON.stringify(sortDeep(v));
}

/**
 * @param {{provider:string, route:string, priceUsd:number, gateway?:string, method?:string,
 *          headerPassport?:string, headerPayment?:string}} opts
 */
export function requirePassport(opts) {
  const gateway = (opts.gateway || DEFAULT_GATEWAY).replace(/\/$/, "");
  const provider = opts.provider;
  const route = opts.route;
  const priceUsd = opts.priceUsd;
  const method = (opts.method || "GET").toUpperCase();
  const hPass = (opts.headerPassport || "ledgerproof-passport").toLowerCase();
  const hPay = (opts.headerPayment || "x-payment").toLowerCase();
  if (!provider || !route || priceUsd == null) throw new Error("requirePassport: provider, route, priceUsd are required");

  return async function ledgerproofGate(req, res, next) {
    const query = { ...(req.query || {}) };
    const passport = (req.get?.(hPass) || req.headers?.[hPass] || "").replace(/^Bearer\s+/i, "");
    const payment = req.get?.(hPay) || req.headers?.[hPay] || "";

    // No Passport/payment → return the opt-in challenge (x402 terms + how to get a Passport).
    if (!passport || !payment) {
      return res.status(402).json({
        error: "Payment and LedgerProof authorization required for this route",
        x402: { scheme: "exact", network: "base", asset: "USDC", resource: route, priceUsd, provider },
        ledgerProof: {
          required: true, gateway, provider, resource: route,
          requestHashOver: canonical({ method, resource: route, query }),
          requiredHeaders: [opts.headerPassport || "LedgerProof-Passport", opts.headerPayment || "X-Payment"],
          getSession: `POST ${gateway}/sessions with a mandate + provider "${provider}" + allowedRoutes including "${route}"`,
        },
      });
    }

    // Passport + payment present → authorize + settle through the LedgerProof gateway.
    let r, body;
    try {
      r = await fetch(`${gateway}/sessions/authorize`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ passport, payment, nonce: Number(req.get?.("agent-nonce") || req.headers?.["agent-nonce"]),
          route, amount: priceUsd, request: { provider, method, query } }),
      });
      body = await r.json().catch(() => ({}));
    } catch (e) {
      return res.status(502).json({ error: "ledgerproof_gateway_unreachable", detail: String(e?.message || e) });
    }
    if (r.status !== 200) return res.status(r.status).json(body);

    // Authorized + settled. Expose the receipt to the handler and to the client.
    // (session_id, nonce, request/response hashes and the settled payment are all inside the signed receipt JWT.)
    req.ledgerproof = { receipt: body.receipt, receipt_anchor: body.receipt_anchor, evidence: body.evidence, session: body.session };
    if (body.receipt) res.setHeader("LedgerProof-Receipt", body.receipt);
    return next();
  };
}

export default { requirePassport };

// examples/sign-viem.mjs — a reference `signPayment(requirements)` for AgentPassport, built on viem.
//
// Produces a base64 x402 "exact"-scheme X-PAYMENT by signing an EIP-3009 TransferWithAuthorization
// for USDC on Base. The facilitator sponsors gas, so the payer wallet needs USDC only (no ETH).
// You own the key — the LedgerProof gateway never sees it; it only ever receives the SIGNED payment.
//
//   npm i viem
//   AGENT_PK=0x<your-funded-base-usdc-key> node your-agent.mjs
//
//   import { makeViemSigner } from "./examples/sign-viem.mjs";
//   const signPayment = makeViemSigner(process.env.AGENT_PK);
//   const pp = new AgentPassport({ provider: "proofgate-demo", signPayment });

import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = { base: 8453, "base-sepolia": 84532 };

function randNonce() {
  const b = new Uint8Array(32);
  (globalThis.crypto ?? require("node:crypto").webcrypto).getRandomValues(b);
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** @param {`0x${string}`} privateKey  @param {{timeoutSeconds?:number}} [opts] */
export function makeViemSigner(privateKey, opts = {}) {
  const account = privateKeyToAccount(privateKey);
  const timeout = opts.timeoutSeconds ?? 120;

  /** @param {any} requirements  the gateway's accepts[0] (from GET /quote) */
  return async function signPayment(requirements) {
    const chainId = CHAIN_ID[requirements.network];
    if (!chainId) throw new Error(`sign-viem: unsupported network ${requirements.network}`);
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: account.address,
      to: requirements.payTo,
      value: String(requirements.maxAmountRequired),   // atomic USDC (6 decimals)
      validAfter: "0",
      validBefore: String(now + timeout),
      nonce: randNonce(),
    };
    // EIP-712 TransferWithAuthorization over the USDC token domain.
    const signature = await account.signTypedData({
      domain: {
        name: requirements.extra?.name ?? "USD Coin",
        version: requirements.extra?.version ?? "2",
        chainId,
        verifyingContract: requirements.asset,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    const payment = { x402Version: 1, scheme: requirements.scheme || "exact", network: requirements.network, payload: { signature, authorization } };
    return Buffer.from(JSON.stringify(payment)).toString("base64");
  };
}

export default makeViemSigner;

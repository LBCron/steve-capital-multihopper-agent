/**
 * OOBE Protocol — Synapse Agent Protocol (SAP v2) & Steve Capital Mandate Engine
 *
 * Canonical Solana Mainnet Constants (`@synapse-sap/sdk`):
 * - SAP v2 Program ID      : SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ
 * - Upgrade Authority      : GBLQznn1QMnx64zHXcDguP9yNW9ZfYCVdrY8eDovBvPk
 * - Program Metadata IDL   : ENs7L1NFuoP7dur8cqGGE6b98CQHfNeDZPWPSjRzhc4f
 * - USDC Mint (Mainnet)    : EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 * - USDG Mint (Mainnet)    : 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH
 */

import crypto from "node:crypto";
import { decodeBase58PublicKey, encodeBase58, findProgramAddressSync } from "./solana-pda.mjs";

export const SAP_PROGRAM_ID = "SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ";
export const SAP_UPGRADE_AUTHORITY = "GBLQznn1QMnx64zHXcDguP9yNW9ZfYCVdrY8eDovBvPk";
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDG_MINT_MAINNET = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
export const DEFAULT_OWNER_WALLET = "32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM";
export const STEVE_ARENA_MIN_FUNDING_USDC = 20;

export const SAP_SEEDS = Object.freeze({
  GLOBAL: "sap_global",
  AGENT: "sap_agent",
  STATS: "sap_stats",
  STAKE: "sap_stake",
  PRICING: "sap_pricing",
  VAULT: "sap_vault",
  SESSION: "sap_session",
  DELEGATE: "sap_delegate",
  ESCROW: "sap_escrow",
  ESCROW_V2: "sap_escrow_v2",
  TOOL: "sap_tool",
  TOOL_CAT: "sap_tool_cat",
  CHECKPOINT: "sap_checkpoint",
});

export const SAP_TOOL_CATEGORIES = Object.freeze({
  Swap: 0,
  Lend: 1,
  Stake: 2,
  Nft: 3,
  Payment: 4,
  Data: 5,
  Governance: 6,
  Bridge: 7,
  Analytics: 8,
  Custom: 9,
});

function u64le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

/**
 * Derives the full SAP v2 account hierarchy for a Steve Capital autonomous agent wallet.
 */
export function deriveSapAgentHierarchy(
  walletAddress = DEFAULT_OWNER_WALLET,
  { escrowNonce = 1n, sessionId = 1n, delegatePubkey = walletAddress, programId = SAP_PROGRAM_ID } = {}
) {
  const walletBuf = decodeBase58PublicKey(walletAddress);
  const delegateBuf = decodeBase58PublicKey(delegatePubkey);

  const [globalRegistry, globalBump] = findProgramAddressSync([Buffer.from(SAP_SEEDS.GLOBAL)], programId);
  const [agentPda, agentBump] = findProgramAddressSync([Buffer.from(SAP_SEEDS.AGENT), walletBuf], programId);
  const [, , agentPdaBytes] = findProgramAddressSync([Buffer.from(SAP_SEEDS.AGENT), walletBuf], programId);

  const [agentStatsPda, statsBump] = findProgramAddressSync(
    [Buffer.from(SAP_SEEDS.STATS), agentPdaBytes],
    programId
  );
  const [pricingMenuPda, pricingBump] = findProgramAddressSync(
    [Buffer.from(SAP_SEEDS.PRICING), agentPdaBytes],
    programId
  );
  const [vaultPda, vaultBump] = findProgramAddressSync(
    [Buffer.from(SAP_SEEDS.VAULT), agentPdaBytes],
    programId
  );
  const [, , vaultPdaBytes] = findProgramAddressSync(
    [Buffer.from(SAP_SEEDS.VAULT), agentPdaBytes],
    programId
  );
  const [sessionPda, sessionBump] = findProgramAddressSync(
    [Buffer.from(SAP_SEEDS.SESSION), vaultPdaBytes, u64le(sessionId)],
    programId
  );
  const [delegatePda, delegateBump] = findProgramAddressSync(
    [Buffer.from(SAP_SEEDS.DELEGATE), vaultPdaBytes, delegateBuf],
    programId
  );
  const [escrowV2Pda, escrowBump] = findProgramAddressSync(
    [Buffer.from(SAP_SEEDS.ESCROW_V2), agentPdaBytes, walletBuf, u64le(escrowNonce)],
    programId
  );

  return {
    programId,
    walletAddress,
    globalRegistry: { address: globalRegistry, bump: globalBump },
    agent: { address: agentPda, bump: agentBump },
    agentStats: { address: agentStatsPda, bump: statsBump },
    pricingMenu: { address: pricingMenuPda, bump: pricingBump },
    vault: { address: vaultPda, bump: vaultBump },
    session: { address: sessionPda, bump: sessionBump, sessionId: String(sessionId) },
    delegate: { address: delegatePda, bump: delegateBump, delegateWallet: delegatePubkey },
    escrowV2: { address: escrowV2Pda, bump: escrowBump, nonce: String(escrowNonce) },
  };
}

/**
 * Derives a SAP v2 `ToolCategory` index PDA (`["sap_tool_cat", discriminant_u8]`).
 */
export function deriveSapToolCategoryIndex(categoryNameOrIndex, programId = SAP_PROGRAM_ID) {
  const idx =
    typeof categoryNameOrIndex === "number"
      ? categoryNameOrIndex
      : SAP_TOOL_CATEGORIES[categoryNameOrIndex];
  if (idx === undefined || idx < 0 || idx > 9) {
    throw new Error(`Invalid SAP ToolCategory: ${categoryNameOrIndex}`);
  }
  const [address, bump] = findProgramAddressSync([Buffer.from(SAP_SEEDS.TOOL_CAT), Buffer.from([idx])], programId);
  return { categoryIndex: idx, address, bump };
}

/**
 * Steve Capital Programmable Guardrail, Risk Policy & Specialist Sub-Agent Mandate Engine.
 *
 * Enforces:
 * 1. Minimum 20 USDC (or SOL equivalent) Steve Arena capital threshold.
 * 2. Per-transaction USD spend cap & rolling 24-hour USD spend ceiling.
 * 3. Protocol allowlist (`jupiter`, `kamino`, `orca`, `raydium`, `meteora`, `adrena`, `phoenix`,
 *    `multihopper`, `magicblock`, `ace-data-cloud`).
 * 4. Maximum slippage basis points & maximum leverage ceiling (for Adrena/Phoenix perps).
 * 5. Strict anti-abuse guardrails: blocks wash-trading, self-transfers, and circular wallet loops.
 * 6. Specialist Sub-Agent budgets (`subAgents` map with isolated per-tx and daily limits).
 */
export class SteveMandateGuard {
  constructor({
    ownerWallet = DEFAULT_OWNER_WALLET,
    agentWallet,
    fundedBalanceUsd = 25.0,
    maxPerTxUsd = 15.0,
    dailySpendCapUsd = 60.0,
    maxSlippageBps = 50,
    maxLeverage = 3.0,
    allowedProtocols = [
      "jupiter",
      "kamino",
      "orca",
      "adrena",
      "multihopper",
      "magicblock",
      "ace-data-cloud",
    ],
  } = {}) {
    if (!agentWallet) {
      throw new Error("agentWallet is required to initialize SteveMandateGuard");
    }
    this.ownerWallet = ownerWallet;
    this.agentWallet = agentWallet;
    this.fundedBalanceUsd = Number(fundedBalanceUsd);
    this.maxPerTxUsd = Number(maxPerTxUsd);
    this.dailySpendCapUsd = Number(dailySpendCapUsd);
    this.maxSlippageBps = Number(maxSlippageBps);
    this.maxLeverage = Number(maxLeverage);
    this.allowedProtocols = new Set(allowedProtocols.map((p) => p.toLowerCase()));
    this.rollingHistory = []; // { tsMs, amountUsd, protocol, subAgentId }
    this.subAgents = new Map();
  }

  registerSubAgent({ id, role, delegateWallet, maxPerTxUsd, dailySpendCapUsd, allowedProtocols }) {
    if (!id || !delegateWallet) {
      throw new Error("Sub-agent registration requires id and delegateWallet");
    }
    if (maxPerTxUsd > this.maxPerTxUsd || dailySpendCapUsd > this.dailySpendCapUsd) {
      throw new Error("Sub-agent mandate cannot exceed parent agent spending ceilings");
    }
    const pdas = deriveSapAgentHierarchy(this.agentWallet, { delegatePubkey: delegateWallet });
    const spec = {
      id,
      role,
      delegateWallet,
      delegatePda: pdas.delegate.address,
      maxPerTxUsd: Number(maxPerTxUsd),
      dailySpendCapUsd: Number(dailySpendCapUsd),
      allowedProtocols: new Set((allowedProtocols || [...this.allowedProtocols]).map((p) => p.toLowerCase())),
    };
    this.subAgents.set(id, spec);
    return spec;
  }

  rollingSpendUsd(nowMs = Date.now(), subAgentId = null) {
    const cutoff = nowMs - 86_400_000;
    return this.rollingHistory
      .filter((item) => item.tsMs >= cutoff && (subAgentId === null || item.subAgentId === subAgentId))
      .reduce((acc, item) => acc + item.amountUsd, 0);
  }

  evaluateIntent({
    protocol,
    action,
    amountUsd,
    slippageBps = 10,
    leverage = 1.0,
    inputMint = null,
    outputMint = null,
    recipientWallets = [],
    subAgentId = null,
    nowMs = Date.now(),
  }) {
    const proto = String(protocol || "").toLowerCase();
    const amt = Number(amountUsd);

    if (this.fundedBalanceUsd < STEVE_ARENA_MIN_FUNDING_USDC) {
      return {
        approved: false,
        code: "ARENA_MIN_FUNDING_NOT_MET",
        reason: `Agent wallet fundedBalanceUsd (${this.fundedBalanceUsd}) is below Steve Arena minimum (${STEVE_ARENA_MIN_FUNDING_USDC} USDC)`,
      };
    }
    if (!(amt > 0)) {
      return { approved: false, code: "NON_POSITIVE_AMOUNT", reason: "Intent amountUsd must be > 0" };
    }
    if (!this.allowedProtocols.has(proto)) {
      return {
        approved: false,
        code: "PROTOCOL_NOT_ALLOWLISTED",
        reason: `Protocol '${proto}' is not enabled in Steve Capital mandate`,
      };
    }
    if (slippageBps > this.maxSlippageBps) {
      return {
        approved: false,
        code: "SLIPPAGE_CAP_EXCEEDED",
        reason: `Slippage ${slippageBps} bps exceeds mandate ceiling ${this.maxSlippageBps} bps`,
      };
    }
    if (leverage > this.maxLeverage) {
      return {
        approved: false,
        code: "LEVERAGE_CAP_EXCEEDED",
        reason: `Leverage ${leverage}x exceeds mandate ceiling ${this.maxLeverage}x`,
      };
    }

    // Anti-wash & anti-circular checks (required by OOBE Arena & MultiHopper judging rules)
    if (inputMint && outputMint && inputMint === outputMint && action === "swap") {
      return {
        approved: false,
        code: "WASH_SWAP_BLOCKED",
        reason: "Self-swap with identical inputMint and outputMint is blocked by anti-wash policy",
      };
    }
    for (const w of recipientWallets) {
      if (w === this.agentWallet) {
        return {
          approved: false,
          code: "SELF_TRANSFER_BLOCKED",
          reason: "Circular/self-transfer back to agentWallet is prohibited",
        };
      }
    }

    if (amt > this.maxPerTxUsd) {
      return {
        approved: false,
        code: "PER_TX_CAP_EXCEEDED",
        reason: `Intent $${amt.toFixed(2)} exceeds parent per-tx cap $${this.maxPerTxUsd.toFixed(2)}`,
      };
    }
    const spent24h = this.rollingSpendUsd(nowMs);
    if (spent24h + amt > this.dailySpendCapUsd) {
      return {
        approved: false,
        code: "DAILY_CAP_EXCEEDED",
        reason: `Rolling 24h spend ($${(spent24h + amt).toFixed(2)}) exceeds daily cap $${this.dailySpendCapUsd.toFixed(2)}`,
      };
    }

    if (subAgentId) {
      const sub = this.subAgents.get(subAgentId);
      if (!sub) {
        return { approved: false, code: "UNKNOWN_SUB_AGENT", reason: `Sub-agent '${subAgentId}' not registered` };
      }
      if (!sub.allowedProtocols.has(proto)) {
        return {
          approved: false,
          code: "SUB_AGENT_PROTOCOL_FORBIDDEN",
          reason: `Sub-agent '${subAgentId}' is not permitted to invoke '${proto}'`,
        };
      }
      if (amt > sub.maxPerTxUsd) {
        return {
          approved: false,
          code: "SUB_AGENT_PER_TX_EXCEEDED",
          reason: `Intent $${amt.toFixed(2)} exceeds sub-agent '${subAgentId}' cap $${sub.maxPerTxUsd.toFixed(2)}`,
        };
      }
      const subSpent = this.rollingSpendUsd(nowMs, subAgentId);
      if (subSpent + amt > sub.dailySpendCapUsd) {
        return {
          approved: false,
          code: "SUB_AGENT_DAILY_CAP_EXCEEDED",
          reason: `Sub-agent '${subAgentId}' 24h spend exceeds $${sub.dailySpendCapUsd.toFixed(2)}`,
        };
      }
    }

    return {
      approved: true,
      code: "MANDATE_APPROVED",
      remainingDailyBudgetUsd: Number((this.dailySpendCapUsd - (spent24h + amt)).toFixed(4)),
    };
  }

  commitIntent(intent, nowMs = Date.now()) {
    const verdict = this.evaluateIntent({ ...intent, nowMs });
    if (!verdict.approved) {
      throw new Error(`${verdict.code}: ${verdict.reason}`);
    }
    this.rollingHistory.push({
      tsMs: nowMs,
      amountUsd: Number(intent.amountUsd),
      protocol: String(intent.protocol).toLowerCase(),
      subAgentId: intent.subAgentId || null,
    });
    return verdict;
  }
}

/**
 * Generates and verifies SAP v2 `x402` (`solana:mainnet-beta`) Ed25519 payment headers
 * for autonomous agent-to-agent and paid MCP service calls.
 */
export function createEd25519SessionSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPubkey = spki.subarray(spki.length - 32);
  return {
    publicKey,
    privateKey,
    solanaAddress: encodeBase58(rawPubkey),
    rawPubkey,
  };
}

export function signSapX402PaymentHeader({
  signer,
  agentWallet,
  serviceEndpoint,
  amountAtomic,
  mint = USDC_MINT_MAINNET,
  network = "solana:mainnet-beta",
  nonce = crypto.randomUUID(),
  timestamp = Math.floor(Date.now() / 1000),
}) {
  const canonicalPayload = JSON.stringify({
    version: "sap-x402-v2",
    network,
    agentWallet,
    sessionSigner: signer.solanaAddress,
    serviceEndpoint,
    mint,
    amountAtomic: String(amountAtomic),
    nonce,
    timestamp,
  });
  const signature = crypto.sign(null, Buffer.from(canonicalPayload, "utf8"), signer.privateKey);
  return {
    headerValue: Buffer.from(
      JSON.stringify({
        payload: JSON.parse(canonicalPayload),
        signatureBase64: signature.toString("base64"),
      })
    ).toString("base64url"),
    canonicalPayload,
    signatureBase64: signature.toString("base64"),
  };
}

export function verifySapX402PaymentHeader(headerValue, publicKeyObj) {
  const decoded = JSON.parse(Buffer.from(headerValue, "base64url").toString("utf8"));
  const canonicalPayload = JSON.stringify(decoded.payload);
  const sig = Buffer.from(decoded.signatureBase64, "base64");
  const valid = crypto.verify(null, Buffer.from(canonicalPayload, "utf8"), publicKeyObj, sig);
  return { valid, payload: decoded.payload };
}

/**
 * MultiHopper x Steve Capital Agent Routing & Build-and-Route Engine
 *
 * Verified Solana Mainnet Programs:
 * - MultiHopper Core       : 3jLoS2wbNgtKzieUUxwg6Xhdv6gbZkHDtPWA9ZAgspFh
 * - Orchestrator           : 4TPCmR2uN3hDM1FbTsf7ZtFXwXGSz4u1Kxv5YHj6eruX
 * - Token-2022 Hook Guard  : 2JEv3pD6nczEvn1xDXaEzehkJofPPjoQQpnW5nGY3r52
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { decodeBase58PublicKey, findProgramAddressSync } from "./solana-pda.mjs";

export const MULTIHOPPER_PROGRAMS = Object.freeze({
  CORE: "3jLoS2wbNgtKzieUUxwg6Xhdv6gbZkHDtPWA9ZAgspFh",
  ORCHESTRATOR: "4TPCmR2uN3hDM1FbTsf7ZtFXwXGSz4u1Kxv5YHj6eruX",
  TRANSFER_HOOK_GUARD: "2JEv3pD6nczEvn1xDXaEzehkJofPPjoQQpnW5nGY3r52",
});

export const SUPPORTED_WEBHOOK_EVENTS = new Set([
  "transfer.quote_created",
  "transfer.deposit_confirmed",
  "transfer.processing",
  "transfer.phase_changed",
  "transfer.hop_complete",
  "transfer.completed",
  "transfer.failed",
  "transfer.expired",
  "transfer.refunded",
  "transfer.recoverable",
  "transfer.rescued",
  "transfer.rent_reclaimed",
  "payout.completed",
]);

export const MAX_DESTINATIONS_PER_TRANSFER = 20;
export const FULL_RATE_FEE_BPS = 50;
export const INTEGRATOR_REVSHARE_BPS = 25;
export const MULTIHOPPER_NET_FEE_RATE = 0.0025;
export const BUILD_AND_ROUTE_PRIZE_FLOOR_USD = 100_000;

export function buildMultiHopperPdaSeeds(kind, idOrKey) {
  const toLeU64 = (v) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(v));
    return buf;
  };
  switch (kind) {
    case "RouteConfig":
      return [Buffer.from("route"), toLeU64(idOrKey)];
    case "RouteState":
      return [Buffer.from("state"), toLeU64(idOrKey)];
    case "PermanentDelegate":
      return [Buffer.from("delegate"), toLeU64(idOrKey)];
    case "WrapperMint":
      return [Buffer.from("mint_authority"), toLeU64(idOrKey)];
    case "Vault":
      return [
        Buffer.from("vault_authority"),
        typeof idOrKey === "string" && idOrKey.length >= 32
          ? decodeBase58PublicKey(idOrKey)
          : Buffer.from(idOrKey),
      ];
    case "SolVault":
      return [
        Buffer.from("sol_vault"),
        typeof idOrKey === "string" && idOrKey.length >= 32
          ? decodeBase58PublicKey(idOrKey)
          : Buffer.from(idOrKey),
      ];
    case "Provider":
      return [Buffer.from("provider"), Buffer.from(String(idOrKey))];
    case "FeeSchedule":
      return [Buffer.from("fee_schedule"), Buffer.from(String(idOrKey))];
    default:
      throw new Error(`Unknown MultiHopper PDA kind: ${kind}`);
  }
}

/**
 * Computes actual Solana off-curve PDA (`[address, bump]`) against MultiHopper Core.
 */
export function deriveMultiHopperPda(kind, idOrKey, programId = MULTIHOPPER_PROGRAMS.CORE) {
  const seeds = buildMultiHopperPdaSeeds(kind, idOrKey);
  const [address, bump] = findProgramAddressSync(seeds, programId);
  return { kind, address, bump, programId };
}

/**
 * Builds a compliant MultiHopper route payload for an autonomous Steve Capital agent:
 * - Enforces XOR between `recipientWallet` and `destinations[]` (<= 20).
 * - Enforces exact `BigInt` conservation (`sum(destinations) === amountRaw`).
 * - Blocks circular/self-transfers when `senderAgentWallet` is provided (anti-abuse rule).
 */
export function buildAgentRoutePayload({
  senderAgentWallet = null,
  tokenMint,
  amountRaw,
  tokenDecimals = 6,
  hops = 3,
  recipientWallet,
  destinations,
  routeTemplateId,
  purpose = "agent-treasury-settlement",
}) {
  const hasSingle = Boolean(recipientWallet);
  const hasMulti = Array.isArray(destinations) && destinations.length > 0;
  if (hasSingle === hasMulti) {
    throw new Error("Route payload requires exact XOR of recipientWallet OR non-empty destinations[]");
  }
  if (!Number.isInteger(hops) || hops < 1 || hops > 6) {
    throw new Error("hops must be an integer between 1 and 6");
  }
  const total = BigInt(amountRaw);
  if (total <= 0n) {
    throw new Error("amountRaw must be strictly positive");
  }

  if (hasSingle && senderAgentWallet && recipientWallet === senderAgentWallet) {
    throw new Error("Circular self-transfer blocked: recipientWallet cannot equal senderAgentWallet");
  }

  if (hasMulti) {
    if (destinations.length > MAX_DESTINATIONS_PER_TRANSFER) {
      throw new Error(`MultiHopper supports at most ${MAX_DESTINATIONS_PER_TRANSFER} destinations per route`);
    }
    const seen = new Set();
    let sum = 0n;
    for (const d of destinations) {
      if (!d.wallet || typeof d.wallet !== "string") {
        throw new Error("Every destination must specify a valid Solana wallet string");
      }
      decodeBase58PublicKey(d.wallet);
      if (senderAgentWallet && d.wallet === senderAgentWallet) {
        throw new Error(`Circular transfer blocked: destination ${d.wallet} equals senderAgentWallet`);
      }
      if (seen.has(d.wallet)) {
        throw new Error(`Duplicate destination wallet in same Multi-Send batch: ${d.wallet}`);
      }
      seen.add(d.wallet);
      const part = BigInt(d.amountRaw);
      if (part <= 0n) {
        throw new Error(`Destination ${d.wallet} has non-positive amountRaw`);
      }
      sum += part;
    }
    if (sum !== total) {
      throw new Error(`Destination sum (${sum}) does not equal transfer amountRaw (${total})`);
    }
  } else {
    decodeBase58PublicKey(recipientWallet);
  }

  return {
    tokenMint,
    amountRaw: total.toString(),
    tokenDecimals,
    hops,
    purpose,
    ...(hasSingle
      ? { recipientWallet }
      : {
          destinations: destinations.map((d) => ({
            wallet: d.wallet,
            amountRaw: BigInt(d.amountRaw).toString(),
          })),
        }),
    ...(routeTemplateId ? { routeTemplateId } : {}),
  };
}

export function chunkPayrollIntoRoutes(
  payrollId,
  tokenMint,
  tokenDecimals,
  recipients,
  { hops = 3, senderAgentWallet = null } = {}
) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("Payroll recipients list cannot be empty");
  }
  const batches = [];
  for (let i = 0; i < recipients.length; i += MAX_DESTINATIONS_PER_TRANSFER) {
    const slice = recipients.slice(i, i + MAX_DESTINATIONS_PER_TRANSFER);
    const batchTotal = slice.reduce((acc, r) => acc + BigInt(r.amountRaw), 0n);
    const batchIndex = Math.floor(i / MAX_DESTINATIONS_PER_TRANSFER);
    const idempotencyKey = crypto
      .createHash("sha256")
      .update(`${payrollId}:batch:${batchIndex}:${batchTotal}`)
      .digest("hex")
      .slice(0, 32);
    batches.push({
      batchIndex,
      idempotencyKey,
      payload: buildAgentRoutePayload({
        senderAgentWallet,
        tokenMint,
        amountRaw: batchTotal.toString(),
        tokenDecimals,
        hops,
        destinations: slice,
        purpose: `payroll:${payrollId}:batch-${batchIndex}`,
      }),
    });
  }
  return batches;
}

export class CrashSafeJournal {
  constructor(filePath) {
    this.filePath = filePath;
  }

  read(transferId) {
    if (!fs.existsSync(this.filePath)) return {};
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
    const state = {};
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (rec.transferId === transferId) {
        state[rec.step] = rec.data;
      }
    }
    return state;
  }

  append(transferId, step, data) {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      transferId,
      step,
      data,
    });
    fs.appendFileSync(this.filePath, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export async function executeCrashSafeDeployment({
  apiBaseUrl,
  apiKey,
  transferId,
  journal,
  fetchImpl = globalThis.fetch,
  signAndSendV0,
  signAndSendLegacy,
  maxSpendLamports,
}) {
  const headers = {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  };

  const prepRes = await fetchImpl(`${apiBaseUrl}/api/v1/transfers/${transferId}/prepare`, {
    method: "POST",
    headers,
  });
  if (!prepRes.ok) {
    throw new Error(`Prepare failed with HTTP ${prepRes.status}`);
  }
  const { preparedTxs, requiredSolUpFrontLamports } = await prepRes.json();

  if (maxSpendLamports !== undefined && requiredSolUpFrontLamports !== undefined) {
    if (BigInt(requiredSolUpFrontLamports) > BigInt(maxSpendLamports)) {
      throw new Error(
        `Mandate Policy Violation: requiredSolUpFrontLamports (${requiredSolUpFrontLamports}) exceeds maxSpendLamports (${maxSpendLamports})`
      );
    }
  }

  const prior = journal.read(transferId);

  let keeperSig = prior.keeperFundingSignature || null;
  if (!keeperSig && preparedTxs.keeperFundingTx) {
    keeperSig = await signAndSendV0(preparedTxs.keeperFundingTx);
    journal.append(transferId, "keeperFundingSignature", keeperSig);
  }
  if (keeperSig && !prior.keeperCheckpointConfirmed) {
    const cp1 = await fetchImpl(`${apiBaseUrl}/api/v1/transfers/${transferId}/confirm-broadcast`, {
      method: "POST",
      headers,
      body: JSON.stringify({ keeperFundingSignature: keeperSig }),
    });
    if (!cp1.ok) {
      throw new Error(`Keeper checkpoint #1 failed with HTTP ${cp1.status}`);
    }
    journal.append(transferId, "keeperCheckpointConfirmed", true);
  }

  const normalizeB64List = (arr) =>
    Array.isArray(arr) ? arr.map((item) => (typeof item === "string" ? item : item.base64)) : [];

  const sendGroup = async (stepName, rawList, senderFn) => {
    if (prior[stepName]) return prior[stepName];
    const list = normalizeB64List(rawList);
    if (list.length === 0) return undefined;
    const sigs = [];
    for (const b64 of list) {
      sigs.push(await senderFn(b64));
    }
    journal.append(transferId, stepName, sigs);
    return sigs;
  };

  const routeInitSignatures = await sendGroup("routeInitSignatures", preparedTxs.routeInitTxs, signAndSendV0);
  const dispersionInitSignatures = await sendGroup(
    "dispersionInitSignatures",
    preparedTxs.dispersionInitTxs,
    signAndSendV0
  );

  let orchestratorInitSignature = prior.orchestratorInitSignature;
  if (!orchestratorInitSignature && preparedTxs.orchestratorInitTx) {
    orchestratorInitSignature = await signAndSendLegacy(preparedTxs.orchestratorInitTx);
    journal.append(transferId, "orchestratorInitSignature", orchestratorInitSignature);
  }

  const sessionInitSignatures = await sendGroup("sessionInitSignatures", preparedTxs.sessionInitTxs, signAndSendV0);

  const cp2 = await fetchImpl(`${apiBaseUrl}/api/v1/transfers/${transferId}/confirm-broadcast`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      routeInitSignatures,
      dispersionInitSignatures,
      orchestratorInitSignature,
      sessionInitSignatures,
    }),
  });
  if (!cp2.ok) {
    throw new Error(`Init bundle checkpoint #2 failed with HTTP ${cp2.status}`);
  }
  const result = await cp2.json();
  journal.append(transferId, "initCheckpointConfirmed", true);
  return {
    keeperFundingSignature: keeperSig,
    routeInitSignatures,
    dispersionInitSignatures,
    orchestratorInitSignature,
    sessionInitSignatures,
    confirmation: result,
  };
}

export function verifyMultiHopperWebhook(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader || !webhookSecret) return false;
  const cleanSig = signatureHeader.replace(/^sha256=/i, "").trim();
  const expectedHex = crypto
    .createHmac("sha256", webhookSecret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest("hex");
  const a = Buffer.from(cleanSig, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Dual Competition Volume & Transfer Ledger:
 * 1) Steve Capital x MultiHopper Side-Track ($125 USDC):
 *    - Counts USD principal ONCE per completed mainnet route originating from registered `agentWallet`
 *      (hops & Multi-Send destinations never multiply volume; excludes self/circular/devnet).
 *    - Tracks `completedRoutesCount` (`Most Successful Transfers` $40) and `routedPrincipalUsd` (`Highest Routing Volume` $60).
 * 2) MultiHopper Build & Route Challenge ($5,000 - $50,000 + 25 bps rev-share):
 *    - `feeAdjustedQualifyingVolumeUsd = multihopperCollectedFeeUsd / 0.0025` ($100,000 floor).
 */
export class MultiHopperDualLedger {
  constructor({ registeredAgentWallet = null } = {}) {
    this.registeredAgentWallet = registeredAgentWallet;
    this.completedRoutes = new Map();
  }

  recordEvent(event) {
    if (!SUPPORTED_WEBHOOK_EVENTS.has(event.type)) {
      throw new Error(`Unsupported MultiHopper webhook event: ${event.type}`);
    }
    if (event.network && event.network !== "mainnet-beta") {
      return { counted: false, reason: "non-mainnet" };
    }
    if (event.type === "transfer.refunded" || event.type === "transfer.failed" || event.type === "transfer.expired") {
      this.completedRoutes.delete(event.transferId);
      return { counted: false, reason: event.type };
    }
    if (event.type === "transfer.completed") {
      if (this.registeredAgentWallet && event.senderWallet && event.senderWallet !== this.registeredAgentWallet) {
        return { counted: false, reason: "unregistered-sender-wallet" };
      }
      if (event.senderWallet && Array.isArray(event.destinationWallets)) {
        if (event.destinationWallets.includes(event.senderWallet)) {
          return { counted: false, reason: "circular-transfer-excluded" };
        }
      }
      const principalUsd = Number(event.principalUsd || 0);
      const mhCollectedFeeUsd = Number(event.multihopperCollectedFeeUsd || 0);
      const integratorRevShareUsd = Number(event.integratorRevShareUsd || mhCollectedFeeUsd);
      if (principalUsd <= 0 && mhCollectedFeeUsd <= 0) {
        return { counted: false, reason: "zero-value" };
      }
      const feeAdjustedUsd = mhCollectedFeeUsd > 0 ? mhCollectedFeeUsd / MULTIHOPPER_NET_FEE_RATE : 0;
      this.completedRoutes.set(event.transferId, {
        principalUsd: principalUsd > 0 ? principalUsd : feeAdjustedUsd,
        mhCollectedFeeUsd,
        integratorRevShareUsd,
        feeAdjustedQualifyingVolumeUsd: feeAdjustedUsd,
        hops: Number(event.hops || 1),
      });
      return { counted: true };
    }
    return { counted: false, reason: "lifecycle-update" };
  }

  summary() {
    let steveSideTrackPrincipalUsd = 0;
    let totalMhFeeUsd = 0;
    let totalIntegratorRevUsd = 0;
    let buildAndRouteQualifyingUsd = 0;

    for (const r of this.completedRoutes.values()) {
      steveSideTrackPrincipalUsd += r.principalUsd;
      totalMhFeeUsd += r.mhCollectedFeeUsd;
      totalIntegratorRevUsd += r.integratorRevShareUsd;
      buildAndRouteQualifyingUsd += r.feeAdjustedQualifyingVolumeUsd;
    }

    return {
      completedRoutesCount: this.completedRoutes.size,
      steveSideTrackPrincipalUsd: Number(steveSideTrackPrincipalUsd.toFixed(2)),
      buildAndRouteQualifyingUsd: Number(buildAndRouteQualifyingUsd.toFixed(2)),
      totalMhFeeUsd: Number(totalMhFeeUsd.toFixed(4)),
      totalIntegratorRevUsd: Number(totalIntegratorRevUsd.toFixed(4)),
      meets100kBuildAndRouteFloor: buildAndRouteQualifyingUsd >= BUILD_AND_ROUTE_PRIZE_FLOOR_USD,
    };
  }
}

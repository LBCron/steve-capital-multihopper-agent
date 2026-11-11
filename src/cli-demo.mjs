#!/usr/bin/env node
/**
 * End-to-End CLI Demonstration:
 * Steve Capital (OOBE Protocol SAP v2) + MultiHopper Agent Routing + Ace Data Cloud MCP
 */

import {
  DEFAULT_OWNER_WALLET,
  SAP_PROGRAM_ID,
  USDC_MINT_MAINNET,
  SteveMandateGuard,
  createEd25519SessionSigner,
  deriveSapAgentHierarchy,
  deriveSapToolCategoryIndex,
  signSapX402PaymentHeader,
  verifySapX402PaymentHeader,
} from "./sap-mandate-engine.mjs";
import {
  MULTIHOPPER_PROGRAMS,
  MultiHopperDualLedger,
  buildAgentRoutePayload,
  deriveMultiHopperPda,
} from "./multihopper-router.mjs";
import { AceResearchLedger, computeRiskAdjustedAllocation } from "./strategy-engine.mjs";
import { handleMcpRequest } from "./mcp-server.mjs";
import { verifyMainnetPrograms } from "./solana-pda.mjs";

const TREASURY_DEST_A = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";
const TREASURY_DEST_B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

async function main() {
  console.log("================================================================================");
  console.log("  Steve Capital x OOBE SAP v2 x MultiHopper Autonomous Capital Agent (Solana)");
  console.log("================================================================================");

  // 1. Live Solana Mainnet RPC Verification (falls back cleanly if offline)
  try {
    const rpcReport = await verifyMainnetPrograms([
      SAP_PROGRAM_ID,
      MULTIHOPPER_PROGRAMS.CORE,
      MULTIHOPPER_PROGRAMS.ORCHESTRATOR,
      MULTIHOPPER_PROGRAMS.TRANSFER_HOOK_GUARD,
    ]);
    console.log(`[1] Live Solana Mainnet RPC Verified @ Slot #${rpcReport.contextSlot}:`);
    for (const p of rpcReport.programs) {
      console.log(`    - ${p.address} | executable=${p.executable} | owner=${p.owner}`);
    }
  } catch (err) {
    console.log(`[1] Offline Mode (RPC skipped: ${err.message})`);
  }

  // 2. SAP v2 Deterministic Agent Account Hierarchy
  const sessionSigner = createEd25519SessionSigner();
  const sapPdas = deriveSapAgentHierarchy(DEFAULT_OWNER_WALLET, {
    escrowNonce: 1n,
    sessionId: 42n,
    delegatePubkey: sessionSigner.solanaAddress,
  });
  const paymentCat = deriveSapToolCategoryIndex("Payment");
  console.log(`\n[2] OOBE SAP v2 Account Hierarchy for ${DEFAULT_OWNER_WALLET}:`);
  console.log(`    - GlobalRegistry PDA : ${sapPdas.globalRegistry.address} (bump=${sapPdas.globalRegistry.bump})`);
  console.log(`    - AgentAccount PDA   : ${sapPdas.agent.address} (bump=${sapPdas.agent.bump})`);
  console.log(`    - AgentVault PDA     : ${sapPdas.vault.address} (bump=${sapPdas.vault.bump})`);
  console.log(`    - Delegate PDA       : ${sapPdas.delegate.address} (session=${sessionSigner.solanaAddress})`);
  console.log(`    - EscrowV2 PDA (#1)  : ${sapPdas.escrowV2.address}`);
  console.log(`    - Payment ToolCat    : ${paymentCat.address}`);

  // 3. Steve Capital Mandate & Specialist Sub-Agent Enforcement
  const guard = new SteveMandateGuard({
    ownerWallet: DEFAULT_OWNER_WALLET,
    agentWallet: DEFAULT_OWNER_WALLET,
    fundedBalanceUsd: 120.0,
    maxPerTxUsd: 35.0,
    dailySpendCapUsd: 90.0,
    maxSlippageBps: 40,
    maxLeverage: 2.5,
  });
  guard.registerSubAgent({
    id: "multihopper-settlement-bot",
    role: "Automated MultiHopper Profit & Contributor Router",
    delegateWallet: sessionSigner.solanaAddress,
    maxPerTxUsd: 25.0,
    dailySpendCapUsd: 50.0,
    allowedProtocols: ["multihopper"],
  });

  const validVerdict = guard.commitIntent({
    protocol: "multihopper",
    action: "multi_send",
    amountUsd: 12.0,
    recipientWallets: [TREASURY_DEST_A, TREASURY_DEST_B],
    subAgentId: "multihopper-settlement-bot",
  });
  const blockedCircular = guard.evaluateIntent({
    protocol: "multihopper",
    action: "transfer",
    amountUsd: 5.0,
    recipientWallets: [DEFAULT_OWNER_WALLET],
  });
  console.log(`\n[3] Steve Capital Programmable Guardrails:`);
  console.log(`    - Sub-Agent MultiHopper $12 Route : ${validVerdict.code} (remaining 24h=$${validVerdict.remainingDailyBudgetUsd})`);
  console.log(`    - Self/Circular Transfer Defense  : ${blockedCircular.code} (${blockedCircular.reason})`);

  // 4. Risk-Adjusted Allocation + Ace Data Cloud Paid Research Ledger
  const aceLedger = new AceResearchLedger();
  for (let i = 1; i <= 5; i++) {
    aceLedger.recordRequest({
      requestId: `ace-paid-0${i}`,
      toolName: i <= 3 ? "ace_google_search" : "ace_research_briefing",
      creditSource: "purchased",
      creditsUsed: 2,
      querySummary: `Solana funding & liquidity regime scan #${i}`,
    });
  }
  const allocation = computeRiskAdjustedAllocation({
    portfolioUsd: 120.0,
    kaminoSupplyAprPct: 8.4,
    adrenaFundingAprPct: 24.5,
    jupiterMomentumScore: 0.55,
    volatilityRegime: "normal",
  });
  console.log(`\n[4] Strategy Allocation & Ace Data Cloud MCP Side-Track:`);
  console.log(`    - Allocations ($120) : ${JSON.stringify(allocation.allocationsUsd)}`);
  console.log(`    - Blended Yield APR  : ${allocation.expectedBlendedAprPct}%`);
  console.log(`    - Ace Paid Requests  : ${JSON.stringify(aceLedger.qualificationSummary())}`);

  // 5. MultiHopper Programmable Route + SAP x402 Proof + MCP Server Call
  const routePayload = buildAgentRoutePayload({
    senderAgentWallet: DEFAULT_OWNER_WALLET,
    tokenMint: USDC_MINT_MAINNET,
    amountRaw: "12000000",
    hops: 3,
    destinations: [
      { wallet: TREASURY_DEST_A, amountRaw: "7000000" },
      { wallet: TREASURY_DEST_B, amountRaw: "5000000" },
    ],
  });
  const mhRoutePda = deriveMultiHopperPda("RouteConfig", 101n);
  const x402 = signSapX402PaymentHeader({
    signer: sessionSigner,
    agentWallet: DEFAULT_OWNER_WALLET,
    serviceEndpoint: "https://mcp.sap.oobeprotocol.ai/x402",
    amountAtomic: "250000",
  });
  const x402Verify = verifySapX402PaymentHeader(x402.headerValue, sessionSigner.publicKey);
  const mhLedger = new MultiHopperDualLedger({ registeredAgentWallet: DEFAULT_OWNER_WALLET });
  mhLedger.recordEvent({
    type: "transfer.completed",
    transferId: "mh-route-101",
    network: "mainnet-beta",
    senderWallet: DEFAULT_OWNER_WALLET,
    destinationWallets: [TREASURY_DEST_A, TREASURY_DEST_B],
    principalUsd: 12.0,
    multihopperCollectedFeeUsd: 0.03,
    hops: 3,
  });

  const mcpResp = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/list",
  });
  console.log(`\n[5] MultiHopper Route, SAP x402 Proof & MCP Workspace Readiness:`);
  console.log(`    - RouteConfig PDA (#101): ${mhRoutePda.address} (hops=${routePayload.hops}, dests=${routePayload.destinations.length})`);
  console.log(`    - SAP v2 x402 Verified  : ${x402Verify.valid}`);
  console.log(`    - Dual Volume Summary   : ${JSON.stringify(mhLedger.summary())}`);
  console.log(`    - MCP Tools Exposed     : ${mcpResp.result.tools.length} tools ready for Steve Capital MCP Workspace`);
  console.log("================================================================================");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AceResearchLedger,
  CrashSafeJournal,
  DEFAULT_OWNER_WALLET,
  MULTIHOPPER_PROGRAMS,
  MultiHopperDualLedger,
  SAP_PROGRAM_ID,
  SteveMandateGuard,
  USDC_MINT_MAINNET,
  buildAgentRoutePayload,
  chunkPayrollIntoRoutes,
  computeRiskAdjustedAllocation,
  createEd25519SessionSigner,
  deriveMultiHopperPda,
  deriveSapAgentHierarchy,
  deriveSapToolCategoryIndex,
  executeCrashSafeDeployment,
  findProgramAddressSync,
  handleMcpRequest,
  isOnEd25519Curve,
  signSapX402PaymentHeader,
  verifySapX402PaymentHeader,
  verifyMultiHopperWebhook,
} from "../src/index.mjs";

const DEST_1 = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";
const DEST_2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const DEST_3 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("1. Solana PDA engine matches official OOBE SAP v2 GlobalRegistry and ToolCategory PDAs bit-for-bit", () => {
  const [globalPda, globalBump, globalBytes] = findProgramAddressSync(
    [Buffer.from("sap_global")],
    SAP_PROGRAM_ID
  );
  assert.equal(globalBump, 255);
  assert.equal(isOnEd25519Curve(globalBytes), false);
  assert.equal(globalPda, "9odFrYBBZq6UQC6aGyzMPNXWJQn55kMtfigzhLg6S6L5");

  const expectedCategories = [
    ["Swap", "5H8yn9RuRgZWqkDiWbKNaCHzTMjqSpwbNQKMPLtUXx2G"],
    ["Lend", "5Lqqk6VtFWnYq3h4Ae4FuUAKnFzw1Nm1DaSdt2cjcTDj"],
    ["Stake", "kC8oAiVUcFMXEnmMNu1h2sdAc3dWKcwV5qVKRFYMmQD"],
    ["Payment", "Eh7MwxJYWRN8bzAmY3ZPTRXYjWpWypokBf1STixu2dy9"],
    ["Data", "AwpVxehQUZCVTAJ9icZfS6oRbF66jNo32duXaL11B5df"],
    ["Bridge", "664nyr6kBeeFiE1ij5gtdncNCVHrXqrk2uBhnKmUREvK"],
    ["Custom", "3Nk5dvFWEyWPEArdG9cCdab6C6ym36mSWUSB8HzN35ZM"],
  ];
  for (const [cat, expectedAddress] of expectedCategories) {
    const derived = deriveSapToolCategoryIndex(cat);
    assert.equal(derived.address, expectedAddress);
  }
});

test("2. deriveSapAgentHierarchy derives deterministic off-curve SAP v2 agent, vault, session & escrow PDAs", () => {
  const pdas = deriveSapAgentHierarchy(DEFAULT_OWNER_WALLET, { escrowNonce: 7n, sessionId: 3n });
  assert.equal(pdas.globalRegistry.bump, 255);
  assert.notEqual(pdas.agent.address, pdas.vault.address);
  assert.notEqual(pdas.vault.address, pdas.escrowV2.address);
  assert.equal(pdas.escrowV2.nonce, "7");
  assert.equal(pdas.session.sessionId, "3");
});

test("3. SteveMandateGuard enforces 20 USDC Arena minimum funding, per-tx, 24h rolling, slippage & leverage caps", () => {
  const unfunded = new SteveMandateGuard({
    agentWallet: DEFAULT_OWNER_WALLET,
    fundedBalanceUsd: 19.99,
  });
  assert.equal(
    unfunded.evaluateIntent({ protocol: "jupiter", action: "swap", amountUsd: 5 }).code,
    "ARENA_MIN_FUNDING_NOT_MET"
  );

  const guard = new SteveMandateGuard({
    agentWallet: DEFAULT_OWNER_WALLET,
    fundedBalanceUsd: 50,
    maxPerTxUsd: 20,
    dailySpendCapUsd: 35,
    maxSlippageBps: 30,
    maxLeverage: 2.0,
  });

  assert.equal(
    guard.evaluateIntent({ protocol: "unknown-dex", action: "swap", amountUsd: 10 }).code,
    "PROTOCOL_NOT_ALLOWLISTED"
  );
  assert.equal(
    guard.evaluateIntent({ protocol: "jupiter", action: "swap", amountUsd: 10, slippageBps: 45 }).code,
    "SLIPPAGE_CAP_EXCEEDED"
  );
  assert.equal(
    guard.evaluateIntent({ protocol: "adrena", action: "open_perp", amountUsd: 10, leverage: 3.0 }).code,
    "LEVERAGE_CAP_EXCEEDED"
  );
  assert.equal(
    guard.evaluateIntent({ protocol: "kamino", action: "deposit", amountUsd: 25 }).code,
    "PER_TX_CAP_EXCEEDED"
  );

  const t0 = 1_800_000_000_000;
  guard.commitIntent({ protocol: "kamino", action: "deposit", amountUsd: 20 }, t0);
  assert.equal(
    guard.evaluateIntent({ protocol: "kamino", action: "deposit", amountUsd: 16, nowMs: t0 + 1000 }).code,
    "DAILY_CAP_EXCEEDED"
  );
  // Rolling 24h window resets cleanly after 86,400s
  assert.equal(
    guard.evaluateIntent({ protocol: "kamino", action: "deposit", amountUsd: 16, nowMs: t0 + 86_400_001 }).approved,
    true
  );
});

test("4. SteveMandateGuard enforces specialist sub-agent delegation bounds and anti-wash rules", () => {
  const signer = createEd25519SessionSigner();
  const guard = new SteveMandateGuard({
    agentWallet: DEFAULT_OWNER_WALLET,
    fundedBalanceUsd: 100,
    maxPerTxUsd: 30,
    dailySpendCapUsd: 80,
  });
  const sub = guard.registerSubAgent({
    id: "mh-router",
    role: "MultiHopper Settlement Specialist",
    delegateWallet: signer.solanaAddress,
    maxPerTxUsd: 12,
    dailySpendCapUsd: 24,
    allowedProtocols: ["multihopper"],
  });
  assert.ok(sub.delegatePda.length >= 32);

  assert.equal(
    guard.evaluateIntent({
      protocol: "jupiter",
      action: "swap",
      amountUsd: 5,
      subAgentId: "mh-router",
    }).code,
    "SUB_AGENT_PROTOCOL_FORBIDDEN"
  );
  assert.equal(
    guard.evaluateIntent({
      protocol: "jupiter",
      action: "swap",
      amountUsd: 5,
      inputMint: USDC_MINT_MAINNET,
      outputMint: USDC_MINT_MAINNET,
    }).code,
    "WASH_SWAP_BLOCKED"
  );
  assert.equal(
    guard.evaluateIntent({
      protocol: "multihopper",
      action: "transfer",
      amountUsd: 5,
      recipientWallets: [DEFAULT_OWNER_WALLET],
    }).code,
    "SELF_TRANSFER_BLOCKED"
  );
});

test("5. SAP v2 x402 Ed25519 payment header signs and verifies deterministically and rejects tampering", () => {
  const signer = createEd25519SessionSigner();
  assert.equal(isOnEd25519Curve(signer.rawPubkey), true);
  const signed = signSapX402PaymentHeader({
    signer,
    agentWallet: DEFAULT_OWNER_WALLET,
    serviceEndpoint: "https://mcp.sap.oobeprotocol.ai/x402",
    amountAtomic: "500000",
  });
  const check = verifySapX402PaymentHeader(signed.headerValue, signer.publicKey);
  assert.equal(check.valid, true);
  assert.equal(check.payload.amountAtomic, "500000");

  const otherSigner = createEd25519SessionSigner();
  assert.equal(verifySapX402PaymentHeader(signed.headerValue, otherSigner.publicKey).valid, false);
});

test("6. MultiHopper PDA derivation and route builder enforce XOR, <=20 batching, conservation & anti-circularity", () => {
  const pda1 = deriveMultiHopperPda("RouteConfig", 99n);
  const pda2 = deriveMultiHopperPda("RouteState", 99n);
  assert.equal(pda1.programId, MULTIHOPPER_PROGRAMS.CORE);
  assert.notEqual(pda1.address, pda2.address);

  assert.throws(
    () =>
      buildAgentRoutePayload({
        senderAgentWallet: DEFAULT_OWNER_WALLET,
        tokenMint: USDC_MINT_MAINNET,
        amountRaw: "1000000",
        recipientWallet: DEFAULT_OWNER_WALLET,
      }),
    /Circular self-transfer blocked/
  );

  assert.throws(
    () =>
      buildAgentRoutePayload({
        senderAgentWallet: DEFAULT_OWNER_WALLET,
        tokenMint: USDC_MINT_MAINNET,
        amountRaw: "1000000",
        destinations: [
          { wallet: DEST_1, amountRaw: "600000" },
          { wallet: DEST_2, amountRaw: "300000" },
        ],
      }),
    /does not equal transfer amountRaw/
  );

  // 25 unique valid base58 recipients -> 2 batches (20 + 5)
  const recipients = Array.from({ length: 25 }, (_, i) => ({
    wallet: createEd25519SessionSigner().solanaAddress,
    amountRaw: String((i + 1) * 100_000),
  }));
  const batches = chunkPayrollIntoRoutes("steve-dao-epoch-1", USDC_MINT_MAINNET, 6, recipients, {
    senderAgentWallet: DEFAULT_OWNER_WALLET,
  });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].payload.destinations.length, 20);
  assert.equal(batches[1].payload.destinations.length, 5);
});

test("7. Crash-safe MultiHopper broadcaster checkpoints keeperFundingTx and prevents double-funding on retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steve-mh-"));
  const journalPath = path.join(dir, "routes.journal");
  const journal = new CrashSafeJournal(journalPath);

  let keeperBroadcastCount = 0;
  let failOnOrchestrator = true;

  const mockFetch = async (url) => {
    if (url.endsWith("/prepare")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          requiredSolUpFrontLamports: "4000000",
          preparedTxs: {
            keeperFundingTx: "keeper-b64",
            routeInitTxs: ["route-b64"],
            dispersionInitTxs: ["disp-b64"],
            orchestratorInitTx: "orch-b64",
            sessionInitTxs: ["sess-b64"],
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "confirmed" }) };
  };

  await assert.rejects(
    () =>
      executeCrashSafeDeployment({
        apiBaseUrl: "https://api.multihopper.com",
        apiKey: "test-key",
        transferId: "tx-777",
        journal,
        fetchImpl: mockFetch,
        maxSpendLamports: "10000000",
        signAndSendV0: async (b64) => {
          if (b64 === "keeper-b64") keeperBroadcastCount++;
          return `sig-${b64}`;
        },
        signAndSendLegacy: async () => {
          if (failOnOrchestrator) {
            failOnOrchestrator = false;
            throw new Error("Simulated RPC timeout during orchestratorInitTx");
          }
          return "sig-orch-b64";
        },
      }),
    /Simulated RPC timeout/
  );
  assert.equal(keeperBroadcastCount, 1);

  // Retry resumes from journal WITHOUT re-sending keeperFundingTx
  const recovered = await executeCrashSafeDeployment({
    apiBaseUrl: "https://api.multihopper.com",
    apiKey: "test-key",
    transferId: "tx-777",
    journal,
    fetchImpl: mockFetch,
    maxSpendLamports: "10000000",
    signAndSendV0: async (b64) => {
      if (b64 === "keeper-b64") keeperBroadcastCount++;
      return `sig-${b64}`;
    },
    signAndSendLegacy: async () => "sig-orch-b64",
  });
  assert.equal(keeperBroadcastCount, 1);
  assert.equal(recovered.orchestratorInitSignature, "sig-orch-b64");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("8. MultiHopper webhook HMAC verifier and Dual Competition Ledger enforce single-counted principal & exclusions", () => {
  const secret = "whsec_steve_mh_2026";
  const body = JSON.stringify({ type: "transfer.completed", transferId: "r-1" });
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyMultiHopperWebhook(body, `sha256=${sig}`, secret), true);
  assert.equal(verifyMultiHopperWebhook(body, "sha256=deadbeef", secret), false);

  const ledger = new MultiHopperDualLedger({ registeredAgentWallet: DEFAULT_OWNER_WALLET });
  // Devnet excluded
  assert.equal(
    ledger.recordEvent({
      type: "transfer.completed",
      transferId: "dev-1",
      network: "devnet",
      senderWallet: DEFAULT_OWNER_WALLET,
      principalUsd: 500,
      multihopperCollectedFeeUsd: 1.25,
    }).counted,
    false
  );
  // Circular excluded
  assert.equal(
    ledger.recordEvent({
      type: "transfer.completed",
      transferId: "circ-1",
      network: "mainnet-beta",
      senderWallet: DEFAULT_OWNER_WALLET,
      destinationWallets: [DEST_1, DEFAULT_OWNER_WALLET],
      principalUsd: 500,
      multihopperCollectedFeeUsd: 1.25,
    }).counted,
    false
  );
  // Valid 4-hop route: principal counted ONCE ($250), fee-adjusted volume = 0.625 / 0.0025 = $250
  assert.equal(
    ledger.recordEvent({
      type: "transfer.completed",
      transferId: "main-1",
      network: "mainnet-beta",
      senderWallet: DEFAULT_OWNER_WALLET,
      destinationWallets: [DEST_1, DEST_2, DEST_3],
      principalUsd: 250,
      multihopperCollectedFeeUsd: 0.625,
      hops: 4,
    }).counted,
    true
  );
  const sum = ledger.summary();
  assert.equal(sum.completedRoutesCount, 1);
  assert.equal(sum.steveSideTrackPrincipalUsd, 250);
  assert.equal(sum.buildAndRouteQualifyingUsd, 250);
});

test("9. Risk-adjusted strategy engine & Ace Data Cloud MCP 5-paid-request verifier", () => {
  const alloc = computeRiskAdjustedAllocation({
    portfolioUsd: 200,
    kaminoSupplyAprPct: 7.5,
    adrenaFundingAprPct: 28.0,
    jupiterMomentumScore: 0.6,
    volatilityRegime: "normal",
  });
  const weightSum = Object.values(alloc.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(weightSum - 1.0) < 0.002);
  assert.ok(alloc.allocationsUsd.kaminoUsdcYield >= 70);

  const ace = new AceResearchLedger();
  // Free trial credits do NOT qualify
  ace.recordRequest({ requestId: "free-1", toolName: "ace_google_search", creditSource: "trial", creditsUsed: 5 });
  assert.equal(ace.qualificationSummary().qualifyingPaidRequests, 0);
  for (let i = 1; i <= 5; i++) {
    ace.recordRequest({
      requestId: `paid-${i}`,
      toolName: "ace_google_search",
      creditSource: "purchased",
      creditsUsed: 1,
    });
  }
  assert.equal(ace.qualificationSummary().meetsSideTrackMinimum, true);
});

test("10. MCP JSON-RPC 2.0 server handles initialize, tools/list, and tools/call cleanly", async () => {
  const initRes = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(initRes.result.serverInfo.name, "steve-capital-multihopper-mcp");

  const listRes = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listRes.result.tools.length, 6);

  const callRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "multihopper_plan_route",
      arguments: {
        senderAgentWallet: DEFAULT_OWNER_WALLET,
        amountRaw: "5000000",
        hops: 3,
        routeId: 12,
        recipientWallet: DEST_1,
      },
    },
  });
  assert.equal(callRes.result.isError, false);
  const parsed = JSON.parse(callRes.result.content[0].text);
  assert.equal(parsed.routePayload.amountRaw, "5000000");
  assert.equal(parsed.onChainPdas.routeConfigPda.programId, MULTIHOPPER_PROGRAMS.CORE);
});

#!/usr/bin/env node
/**
 * Model Context Protocol (MCP) JSON-RPC 2.0 Server for Steve Capital MCP Workspace
 *
 * Exposes 6 deterministic tools for autonomous capital management across
 * OOBE Protocol SAP v2, MultiHopper Programmable Routing, and Solana Mainnet RPC.
 */

import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { verifyMainnetPrograms } from "./solana-pda.mjs";
import {
  DEFAULT_OWNER_WALLET,
  SAP_PROGRAM_ID,
  USDC_MINT_MAINNET,
  SteveMandateGuard,
  deriveSapAgentHierarchy,
} from "./sap-mandate-engine.mjs";
import {
  MULTIHOPPER_PROGRAMS,
  buildAgentRoutePayload,
  deriveMultiHopperPda,
  verifyMultiHopperWebhook,
} from "./multihopper-router.mjs";
import { computeRiskAdjustedAllocation } from "./strategy-engine.mjs";

export const MCP_SERVER_INFO = Object.freeze({
  name: "steve-capital-multihopper-mcp",
  version: "1.0.0",
  protocolVersion: "2024-11-05",
});

export const MCP_TOOLS = [
  {
    name: "sap_derive_agent_pdas",
    description:
      "Derives canonical OOBE Protocol SAP v2 PDAs (GlobalRegistry, AgentAccount, AgentStats, Vault, Session, Delegate, EscrowV2) on Solana.",
    inputSchema: {
      type: "object",
      properties: {
        walletAddress: { type: "string", description: "Solana Base58 agent owner wallet" },
        escrowNonce: { type: "integer", default: 1 },
        sessionId: { type: "integer", default: 1 },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "steve_evaluate_mandate",
    description:
      "Evaluates an autonomous trading, yield, or transfer intent against Steve Capital programmable risk guardrails and anti-wash rules.",
    inputSchema: {
      type: "object",
      properties: {
        agentWallet: { type: "string" },
        fundedBalanceUsd: { type: "number" },
        maxPerTxUsd: { type: "number" },
        dailySpendCapUsd: { type: "number" },
        protocol: { type: "string" },
        action: { type: "string" },
        amountUsd: { type: "number" },
        slippageBps: { type: "number" },
        leverage: { type: "number" },
        recipientWallets: { type: "array", items: { type: "string" } },
      },
      required: ["agentWallet", "protocol", "action", "amountUsd"],
    },
  },
  {
    name: "steve_compute_allocation",
    description:
      "Computes risk-adjusted capital weights across Kamino USDC yield, Jupiter spot, Adrena delta-neutral perps, and MultiHopper profit sweeps.",
    inputSchema: {
      type: "object",
      properties: {
        portfolioUsd: { type: "number" },
        kaminoSupplyAprPct: { type: "number" },
        adrenaFundingAprPct: { type: "number" },
        jupiterMomentumScore: { type: "number" },
        volatilityRegime: { type: "string", enum: ["low", "normal", "elevated"] },
      },
      required: ["portfolioUsd", "kaminoSupplyAprPct", "adrenaFundingAprPct"],
    },
  },
  {
    name: "multihopper_plan_route",
    description:
      "Builds a non-custodial MultiHopper route or <=20-wallet Multi-Send payload with PDA verification and circular-transfer prevention.",
    inputSchema: {
      type: "object",
      properties: {
        senderAgentWallet: { type: "string" },
        tokenMint: { type: "string" },
        amountRaw: { type: "string" },
        hops: { type: "integer", default: 3 },
        routeId: { type: "integer", default: 1 },
        recipientWallet: { type: "string" },
        destinations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              wallet: { type: "string" },
              amountRaw: { type: "string" },
            },
            required: ["wallet", "amountRaw"],
          },
        },
      },
      required: ["amountRaw"],
    },
  },
  {
    name: "multihopper_verify_webhook",
    description: "Constant-time HMAC-SHA256 verification of x-multihopper-signature completion webhooks.",
    inputSchema: {
      type: "object",
      properties: {
        rawBody: { type: "string" },
        signatureHeader: { type: "string" },
        webhookSecret: { type: "string" },
      },
      required: ["rawBody", "signatureHeader", "webhookSecret"],
    },
  },
  {
    name: "solana_verify_mainnet_programs",
    description:
      "Verifies live executable deployment of OOBE SAP v2 and MultiHopper Core/Orchestrator/HookGuard on Solana Mainnet RPC.",
    inputSchema: {
      type: "object",
      properties: {
        rpcUrl: { type: "string" },
      },
    },
  },
];

export async function handleMcpRequest(req, { fetchImpl = globalThis.fetch } = {}) {
  const { jsonrpc = "2.0", id = null, method, params = {} } = req || {};

  const ok = (result) => ({ jsonrpc, id, result });
  const err = (code, message) => ({ jsonrpc, id, error: { code, message } });

  try {
    if (method === "initialize") {
      return ok({
        protocolVersion: MCP_SERVER_INFO.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
      });
    }
    if (method === "notifications/initialized") {
      return null;
    }
    if (method === "tools/list") {
      return ok({ tools: MCP_TOOLS });
    }
    if (method === "tools/call") {
      const { name, arguments: args = {} } = params;
      let payload;

      switch (name) {
        case "sap_derive_agent_pdas":
          payload = deriveSapAgentHierarchy(args.walletAddress || DEFAULT_OWNER_WALLET, {
            escrowNonce: BigInt(args.escrowNonce ?? 1),
            sessionId: BigInt(args.sessionId ?? 1),
          });
          break;

        case "steve_evaluate_mandate": {
          const guard = new SteveMandateGuard({
            agentWallet: args.agentWallet,
            fundedBalanceUsd: args.fundedBalanceUsd ?? 25.0,
            maxPerTxUsd: args.maxPerTxUsd ?? 15.0,
            dailySpendCapUsd: args.dailySpendCapUsd ?? 60.0,
          });
          payload = guard.evaluateIntent({
            protocol: args.protocol,
            action: args.action,
            amountUsd: args.amountUsd,
            slippageBps: args.slippageBps ?? 15,
            leverage: args.leverage ?? 1.0,
            recipientWallets: args.recipientWallets ?? [],
          });
          break;
        }

        case "steve_compute_allocation":
          payload = computeRiskAdjustedAllocation({
            portfolioUsd: args.portfolioUsd,
            kaminoSupplyAprPct: args.kaminoSupplyAprPct,
            adrenaFundingAprPct: args.adrenaFundingAprPct,
            jupiterMomentumScore: args.jupiterMomentumScore ?? 0.4,
            volatilityRegime: args.volatilityRegime ?? "normal",
          });
          break;

        case "multihopper_plan_route": {
          const routePayload = buildAgentRoutePayload({
            senderAgentWallet: args.senderAgentWallet || null,
            tokenMint: args.tokenMint || USDC_MINT_MAINNET,
            amountRaw: args.amountRaw,
            hops: args.hops ?? 3,
            recipientWallet: args.recipientWallet,
            destinations: args.destinations,
          });
          const routeConfigPda = deriveMultiHopperPda("RouteConfig", args.routeId ?? 1);
          const routeStatePda = deriveMultiHopperPda("RouteState", args.routeId ?? 1);
          payload = { routePayload, onChainPdas: { routeConfigPda, routeStatePda } };
          break;
        }

        case "multihopper_verify_webhook":
          payload = {
            valid: verifyMultiHopperWebhook(args.rawBody, args.signatureHeader, args.webhookSecret),
          };
          break;

        case "solana_verify_mainnet_programs":
          payload = await verifyMainnetPrograms(
            [
              SAP_PROGRAM_ID,
              MULTIHOPPER_PROGRAMS.CORE,
              MULTIHOPPER_PROGRAMS.ORCHESTRATOR,
              MULTIHOPPER_PROGRAMS.TRANSFER_HOOK_GUARD,
            ],
            args.rpcUrl || "https://api.mainnet-beta.solana.com",
            fetchImpl
          );
          break;

        default:
          return err(-32601, `Unknown MCP tool: ${name}`);
      }

      return ok({
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: false,
      });
    }

    return err(-32601, `Method not found: ${method}`);
  } catch (e) {
    return ok({
      content: [{ type: "text", text: JSON.stringify({ error: String(e.message || e) }) }],
      isError: true,
    });
  }
}

export function startStdioMcpServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed);
      const res = await handleMcpRequest(req);
      if (res !== null) {
        process.stdout.write(`${JSON.stringify(res)}\n`);
      }
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`
      );
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startStdioMcpServer();
}

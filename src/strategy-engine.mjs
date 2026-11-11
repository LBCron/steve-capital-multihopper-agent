/**
 * Steve Capital Risk-Adjusted Allocation & Ace Data Cloud MCP Conviction Engine
 *
 * Allocates capital across Solana protocols available in Steve Capital / SAP MCP:
 * - Kamino / Meteora USDC lending yield (low-volatility reserve)
 * - Jupiter spot rebalance (SOL / JitoSOL / tokenized RWA)
 * - Adrena / Phoenix delta-neutral funding capture (SOL-PERP, XAU-PERP)
 * - MultiHopper programmable treasury & sub-agent profit settlement
 *
 * Also tracks Ace Data Cloud MCP paid credit usage (`>= 5` paid requests required
 * for the Ace Data Cloud x Steve Capital $125 Side-Track).
 */

export const ACE_SIDE_TRACK_MIN_PAID_REQUESTS = 5;

/**
 * Computes conviction-weighted, volatility-capped portfolio allocations for a Steve Capital agent.
 */
export function computeRiskAdjustedAllocation({
  portfolioUsd,
  kaminoSupplyAprPct,
  adrenaFundingAprPct,
  jupiterMomentumScore, // [-1.0, +1.0] from Ace Data Cloud research synthesis
  volatilityRegime = "normal", // "low" | "normal" | "elevated"
  reserveFloorPct = 0.35,
  maxPerpsWeightPct = 0.25,
  maxSpotWeightPct = 0.30,
  settlementSweepPct = 0.10,
}) {
  if (!(portfolioUsd >= 20)) {
    throw new Error("Steve Capital allocation requires at least 20 USDC funded portfolio");
  }
  const volHaircut = volatilityRegime === "elevated" ? 0.5 : volatilityRegime === "low" ? 1.0 : 0.8;

  // Risk-adjusted perp hedge weight (only active when funding APR spreads beat Kamino base rate + 4%)
  const excessFunding = Math.max(0, Number(adrenaFundingAprPct) - (Number(kaminoSupplyAprPct) + 4.0));
  const rawPerpsWeight = Math.min(maxPerpsWeightPct, (excessFunding / 80.0) * volHaircut);

  // Spot directional sleeve driven by positive research conviction
  const clampedMomentum = Math.max(-1, Math.min(1, Number(jupiterMomentumScore || 0)));
  const rawSpotWeight = clampedMomentum > 0 ? Math.min(maxSpotWeightPct, clampedMomentum * maxSpotWeightPct * volHaircut) : 0;

  const multihopperSweepWeight = settlementSweepPct;
  const kaminoReserveWeight = Math.max(
    reserveFloorPct,
    Number((1.0 - rawPerpsWeight - rawSpotWeight - multihopperSweepWeight).toFixed(6))
  );

  const totalWeight = kaminoReserveWeight + rawSpotWeight + rawPerpsWeight + multihopperSweepWeight;
  const norm = (w) => Number((w / totalWeight).toFixed(4));

  const weights = {
    kaminoUsdcYield: norm(kaminoReserveWeight),
    jupiterSpotSleeve: norm(rawSpotWeight),
    adrenaDeltaNeutralPerps: norm(rawPerpsWeight),
    multihopperProfitSweep: norm(multihopperSweepWeight),
  };

  return {
    portfolioUsd: Number(portfolioUsd.toFixed(2)),
    volatilityRegime,
    weights,
    allocationsUsd: {
      kaminoUsdcYield: Number((portfolioUsd * weights.kaminoUsdcYield).toFixed(2)),
      jupiterSpotSleeve: Number((portfolioUsd * weights.jupiterSpotSleeve).toFixed(2)),
      adrenaDeltaNeutralPerps: Number((portfolioUsd * weights.adrenaDeltaNeutralPerps).toFixed(2)),
      multihopperProfitSweep: Number((portfolioUsd * weights.multihopperProfitSweep).toFixed(2)),
    },
    expectedBlendedAprPct: Number(
      (
        weights.kaminoUsdcYield * Number(kaminoSupplyAprPct) +
        weights.adrenaDeltaNeutralPerps * Math.max(0, Number(adrenaFundingAprPct))
      ).toFixed(2)
    ),
  };
}

/**
 * Tracks Ace Data Cloud MCP requests inside a Steve Capital workflow.
 * Per official rules: free/promotional trial credits do NOT count toward the $125 side-track;
 * at least 5 genuine paid requests using purchased Ace credits are required.
 */
export class AceResearchLedger {
  constructor() {
    this.requests = [];
  }

  recordRequest({ requestId, toolName, creditSource, creditsUsed, httpStatus = 200, querySummary }) {
    if (!requestId || !toolName) {
      throw new Error("Ace MCP request record requires requestId and toolName");
    }
    const isPaid = creditSource === "purchased" && Number(creditsUsed) > 0 && httpStatus === 200;
    const entry = {
      requestId,
      toolName,
      creditSource,
      creditsUsed: Number(creditsUsed || 0),
      httpStatus,
      querySummary: querySummary || "",
      qualifiesForSideTrack: isPaid,
    };
    this.requests.push(entry);
    return entry;
  }

  qualificationSummary() {
    const qualifying = this.requests.filter((r) => r.qualifiesForSideTrack);
    return {
      totalRequests: this.requests.length,
      qualifyingPaidRequests: qualifying.length,
      meetsSideTrackMinimum: qualifying.length >= ACE_SIDE_TRACK_MIN_PAID_REQUESTS,
      remainingPaidRequestsNeeded: Math.max(0, ACE_SIDE_TRACK_MIN_PAID_REQUESTS - qualifying.length),
      toolsUsed: [...new Set(qualifying.map((r) => r.toolName))],
    };
  }
}

import { calculateAtr, detectMarketStructure, detectPivots } from "../gann/engine";
import type { Candle, MarketSnapshot, MarketTimeframe, TimeframeSeries } from "../market-data/types";
import { calculateSupertrend } from "./supertrend";
import type { PriceZone, UnifiedCondition, UnifiedDirection, UnifiedLifecycle, UnifiedStrategyConfig, UnifiedStrategyResult } from "./types";

export const defaultUnifiedStrategyConfig: UnifiedStrategyConfig = {
  biasFrames: ["4H", "1H"],
  setupFrame: "15m",
  confirmationFrame: "5m",
  pivotWing: 3,
  supertrendAtrLength: 10,
  supertrendMultiplier: 3,
  liquidityToleranceAtr: 0.35,
  zoneToleranceAtr: 0.45,
  sweepLookback: 36,
  maxBarsSweepToBos: 14,
  maxBarsBosToRetest: 18,
  displacementAtr: 1.15,
  confirmationBodyAtr: 0.22,
  requireFvg: false,
};

type Candidate = {
  direction: Exclude<UnifiedDirection, "NONE">;
  lifecycle: UnifiedLifecycle;
  conditions: UnifiedCondition[];
  reasonsFor: string[];
  reasonsAgainst: string[];
  liquidityPools: PriceZone[];
  liquiditySweep: PriceZone | null;
  bos: PriceZone | null;
  displacement: UnifiedStrategyResult["displacement"];
  fvg: PriceZone | null;
  retestZone: PriceZone | null;
  confirmation: UnifiedStrategyResult["confirmation"];
  entryZone: [number, number] | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  invalidationLevel: number | null;
};

function frame(snapshot: MarketSnapshot, timeframe: MarketTimeframe) {
  return snapshot.series.find((item) => item.timeframe === timeframe);
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

function candleBody(candle: Candle) {
  return Math.abs(candle.close - candle.open);
}

function candleRange(candle: Candle) {
  return Math.max(0.01, candle.high - candle.low);
}

function zoneContains(zone: PriceZone, candle: Candle, tolerance = 0) {
  return candle.low <= zone.high + tolerance && candle.high >= zone.low - tolerance;
}

function condition(key: UnifiedCondition["key"], label: string, state: UnifiedCondition["state"], detail: string): UnifiedCondition {
  return { key, label, state, detail };
}

function empty(status: UnifiedStrategyResult["status"], snapshot: MarketSnapshot, instruction: string): UnifiedStrategyResult {
  return {
    id: `UNIFIED:${status}:${snapshot.updatedAt}`,
    strategy: "Unified Strategy",
    status,
    lifecycle: status === "DATA ERROR" ? "INVALIDATED" : "SEARCHING",
    decision: "NO TRADE",
    direction: "NONE",
    instruction,
    htfBias: "MIXED",
    marketStructure: "MIXED",
    supertrend: "UNKNOWN",
    supportZones: [],
    resistanceZones: [],
    liquidityPools: [],
    liquiditySweep: null,
    bos: null,
    displacement: { confirmed: false, candleTimestamp: null, rangeToAtr: null },
    fvg: null,
    retestZone: null,
    confirmation: { confirmed: false, candleTimestamp: null, detail: instruction },
    entryZone: null,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    invalidationLevel: null,
    setupQuality: { confirmed: 0, total: 9, items: [] },
    reasonsFor: [],
    reasonsAgainst: [instruction],
    dataTimestamp: snapshot.updatedAt,
    candleTimeframe: null,
    currentPrice: snapshot.currentPrice,
    atr: null,
  };
}

function buildZones(series: TimeframeSeries, atr: number, kind: "support" | "resistance", toleranceAtr: number): PriceZone[] {
  const pivots = detectPivots(series.candles, series.timeframe, 4).filter((pivot) => (
    kind === "support" ? pivot.kind === "low" : pivot.kind === "high"
  ));
  const tolerance = atr * toleranceAtr;
  const clusters: PriceZone[] = [];

  for (const pivot of pivots) {
    const found = clusters.find((zone) => Math.abs(zone.level - pivot.price) <= tolerance);
    if (!found) {
      clusters.push({
        kind,
        low: round2(pivot.price - tolerance),
        high: round2(pivot.price + tolerance),
        level: round2(pivot.price),
        strength: 1,
        touches: 1,
        timeframe: series.timeframe,
        createdAt: pivot.timestamp,
      });
    } else {
      found.level = round2((found.level * found.touches + pivot.price) / (found.touches + 1));
      found.low = round2(Math.min(found.low, pivot.price - tolerance));
      found.high = round2(Math.max(found.high, pivot.price + tolerance));
      found.touches += 1;
      found.strength = Math.min(5, found.strength + 1);
      found.createdAt = pivot.timestamp;
    }
  }

  return clusters
    .filter((zone) => zone.touches >= 1)
    .sort((a, b) => b.strength - a.strength || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);
}

function buildLiquidityPools(series: TimeframeSeries, atr: number, direction: "BUY" | "SELL", toleranceAtr: number): PriceZone[] {
  const kind = direction === "BUY" ? "low" : "high";
  const pivots = detectPivots(series.candles, series.timeframe, 3).filter((pivot) => pivot.kind === kind);
  const tolerance = atr * toleranceAtr;
  const pools: PriceZone[] = [];

  for (const pivot of pivots) {
    const found = pools.find((pool) => Math.abs(pool.level - pivot.price) <= tolerance);
    if (!found) {
      pools.push({
        kind: "liquidity",
        direction: direction === "BUY" ? "bullish" : "bearish",
        low: round2(pivot.price - tolerance),
        high: round2(pivot.price + tolerance),
        level: round2(pivot.price),
        strength: 1,
        touches: 1,
        timeframe: series.timeframe,
        createdAt: pivot.timestamp,
      });
    } else {
      found.level = round2((found.level * found.touches + pivot.price) / (found.touches + 1));
      found.touches += 1;
      found.strength = Math.min(5, found.strength + 1);
      found.createdAt = pivot.timestamp;
    }
  }

  return pools.filter((pool) => pool.touches >= 2).sort((a, b) => b.strength - a.strength).slice(0, 4);
}

function detectSweep(series: TimeframeSeries, pools: PriceZone[], direction: "BUY" | "SELL", atr: number, lookback: number) {
  const candles = series.candles;
  const start = Math.max(0, candles.length - lookback);
  const tolerance = atr * 0.08;

  for (let index = candles.length - 1; index >= start; index -= 1) {
    const candle = candles[index];
    for (const pool of pools) {
      const swept = direction === "BUY"
        ? candle.low < pool.level - tolerance && candle.close > pool.level
        : candle.high > pool.level + tolerance && candle.close < pool.level;
      if (swept) {
        return {
          zone: {
            ...pool,
            low: round2(Math.min(pool.low, candle.low)),
            high: round2(Math.max(pool.high, candle.high)),
            createdAt: candle.timestamp,
          },
          index,
        };
      }
    }
  }

  return null;
}

function detectBos(series: TimeframeSeries, direction: "BUY" | "SELL", sweepIndex: number, maxBars: number, atr: number) {
  const candles = series.candles;
  const pivots = detectPivots(candles, series.timeframe, 3);
  const targetPivot = direction === "BUY"
    ? pivots.filter((pivot) => pivot.kind === "high" && pivot.index < sweepIndex).at(-1)
    : pivots.filter((pivot) => pivot.kind === "low" && pivot.index < sweepIndex).at(-1);
  if (!targetPivot) return null;

  const end = Math.min(candles.length - 1, sweepIndex + maxBars);
  for (let index = sweepIndex + 1; index <= end; index += 1) {
    const candle = candles[index];
    const broke = direction === "BUY" ? candle.close > targetPivot.price : candle.close < targetPivot.price;
    if (!broke) continue;
    const rangeToAtr = round2(candleRange(candle) / Math.max(0.01, atr));
    return {
      zone: {
        kind: "bos" as const,
        direction: direction === "BUY" ? "bullish" as const : "bearish" as const,
        low: round2(targetPivot.price - atr * 0.18),
        high: round2(targetPivot.price + atr * 0.18),
        level: round2(targetPivot.price),
        strength: 3,
        touches: 1,
        timeframe: series.timeframe,
        createdAt: candle.timestamp,
      },
      index,
      rangeToAtr,
    };
  }

  return null;
}

function detectFvg(series: TimeframeSeries, direction: "BUY" | "SELL", startIndex: number, atr: number) {
  const candles = series.candles;
  for (let index = candles.length - 1; index >= Math.max(2, startIndex); index -= 1) {
    const first = candles[index - 2];
    const middle = candles[index - 1];
    const third = candles[index];
    const bullish = first.high < third.low;
    const bearish = first.low > third.high;
    const displacement = candleRange(middle) >= atr * 0.8;
    if (direction === "BUY" && bullish && displacement) {
      return {
        kind: "fvg" as const,
        direction: "bullish" as const,
        low: round2(first.high),
        high: round2(third.low),
        level: round2((first.high + third.low) / 2),
        strength: 2,
        touches: 1,
        timeframe: series.timeframe,
        createdAt: third.timestamp,
      };
    }
    if (direction === "SELL" && bearish && displacement) {
      return {
        kind: "fvg" as const,
        direction: "bearish" as const,
        low: round2(third.high),
        high: round2(first.low),
        level: round2((third.high + first.low) / 2),
        strength: 2,
        touches: 1,
        timeframe: series.timeframe,
        createdAt: third.timestamp,
      };
    }
  }
  return null;
}

function detectRetest(series: TimeframeSeries, direction: "BUY" | "SELL", zone: PriceZone, bosIndex: number, maxBars: number, atr: number) {
  const candles = series.candles;
  const end = Math.min(candles.length - 1, bosIndex + maxBars);
  const tolerance = atr * 0.12;
  for (let index = bosIndex + 1; index <= end; index += 1) {
    const candle = candles[index];
    if (!zoneContains(zone, candle, tolerance)) continue;
    const held = direction === "BUY" ? candle.close >= zone.low : candle.close <= zone.high;
    return { index, active: index >= candles.length - 3, held };
  }
  return null;
}

function detectConfirmation(series: TimeframeSeries, direction: "BUY" | "SELL", zone: PriceZone, atr: number) {
  const candles = series.candles.slice(-5);
  const previous = candles.at(-2);
  const last = candles.at(-1);
  if (!last || !previous) return { confirmed: false, candleTimestamp: null, detail: "Waiting for enough confirmation candles." };
  const inZone = zoneContains(zone, last, atr * 0.2) || zoneContains(zone, previous, atr * 0.2);
  const bodyEnough = candleBody(last) >= atr * 0.22;
  const bullish = last.close > last.open && (last.close > previous.high || last.close > zone.high);
  const bearish = last.close < last.open && (last.close < previous.low || last.close < zone.low);
  const confirmed = inZone && bodyEnough && (direction === "BUY" ? bullish : bearish);
  return {
    confirmed,
    candleTimestamp: confirmed ? last.timestamp : null,
    detail: confirmed
      ? `${direction} confirmation close printed at the retest area.`
      : "Price entered retest zone - waiting for a valid confirmation close.",
  };
}

function riskPlan(
  direction: "BUY" | "SELL",
  entryZone: [number, number],
  sweep: PriceZone,
  atr: number,
  opposingZones: PriceZone[],
) {
  const entry = round2((entryZone[0] + entryZone[1]) / 2);
  const stopLoss = direction === "BUY" ? round2(sweep.low - atr * 0.35) : round2(sweep.high + atr * 0.35);
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk < atr * 0.2) return null;
  const takeProfit = direction === "BUY" ? round2(entry + risk * 3) : round2(entry - risk * 3);
  const blocker = opposingZones.find((zone) => direction === "BUY"
    ? zone.level > entry && zone.level < entry + risk * 1.5
    : zone.level < entry && zone.level > entry - risk * 1.5);
  if (blocker) return null;
  return {
    entry,
    stopLoss,
    takeProfit,
    riskReward: round2(Math.abs(takeProfit - entry) / risk),
    invalidationLevel: stopLoss,
  };
}

function lifecycleFromCandidate(candidate: Candidate): UnifiedLifecycle {
  if (!candidate.liquidityPools.length) return "SEARCHING";
  if (!candidate.liquiditySweep) return "LIQUIDITY_FOUND";
  if (!candidate.bos) return "SWEPT";
  if (!candidate.displacement.confirmed) return "BOS_CONFIRMED";
  if (!candidate.retestZone) return "BOS_CONFIRMED";
  if (!candidate.entryZone) return "RETEST_PENDING";
  if (!candidate.confirmation.confirmed) return "CONFIRMATION_PENDING";
  return "READY";
}

function buildCandidate(
  direction: "BUY" | "SELL",
  snapshot: MarketSnapshot,
  setupFrame: TimeframeSeries,
  confirmFrame: TimeframeSeries,
  setupAtr: number,
  confirmAtr: number,
  supportZones: PriceZone[],
  resistanceZones: PriceZone[],
  bias: "BULLISH" | "BEARISH" | "MIXED",
  supertrend: "BULLISH" | "BEARISH" | "UNKNOWN",
  config: UnifiedStrategyConfig,
): Candidate {
  const wantsBull = direction === "BUY";
  const reasonsFor: string[] = [];
  const reasonsAgainst: string[] = [];
  const conditions: UnifiedCondition[] = [];
  const expectedBias = wantsBull ? "BULLISH" : "BEARISH";
  const structureOk = bias === expectedBias;
  const supertrendOk = supertrend === expectedBias;
  const locationZones = wantsBull ? supportZones : resistanceZones;
  const opposingZones = wantsBull ? resistanceZones : supportZones;
  const currentPrice = snapshot.currentPrice ?? setupFrame.candles.at(-1)?.close ?? null;
  const nearLocation = currentPrice
    ? locationZones.find((zone) => Math.abs(currentPrice - zone.level) <= setupAtr * 2.4)
    : null;

  conditions.push(condition("marketStructure", "Market Structure", structureOk ? "CONFIRMED" : "CONFLICT", `${bias} higher-timeframe bias.`));
  conditions.push(condition("supertrend", "Supertrend", supertrendOk ? "CONFIRMED" : "CONFLICT", `${supertrend} trend filter.`));
  conditions.push(condition("supportResistance", wantsBull ? "Support" : "Resistance", nearLocation ? "CONFIRMED" : "WAITING", nearLocation ? `${round2(nearLocation.low)}-${round2(nearLocation.high)}` : "Waiting for a meaningful trading location."));

  if (structureOk) reasonsFor.push(`${expectedBias} higher-timeframe structure.`);
  else reasonsAgainst.push(`${direction} blocked by ${bias} higher-timeframe structure.`);
  if (supertrendOk) reasonsFor.push(`${expectedBias} Supertrend filter.`);
  else reasonsAgainst.push(`${direction} blocked by ${supertrend} Supertrend filter.`);

  if (!structureOk || !supertrendOk) {
    conditions.push(
      condition("liquidity", "Liquidity", "WAITING", "Liquidity search waits for aligned bias and Supertrend."),
      condition("liquiditySweep", "Liquidity Sweep", "WAITING", "Sweep waits for aligned bias and liquidity."),
      condition("bos", "BOS", "WAITING", "BOS waits for sweep first."),
      condition("displacement", "Displacement", "WAITING", "Displacement waits for BOS."),
      condition("fvg", "FVG", config.requireFvg ? "WAITING" : "OPTIONAL", "No fresh FVG confluence."),
      condition("retest", "Retest", "WAITING", "Retest waits for BOS and a valid retest zone."),
      condition("confirmation", "Confirmation", "WAITING", "Confirmation waits for retest."),
    );
    return {
      direction,
      lifecycle: "SEARCHING",
      conditions,
      reasonsFor,
      reasonsAgainst,
      liquidityPools: [],
      liquiditySweep: null,
      bos: null,
      displacement: { confirmed: false, candleTimestamp: null, rangeToAtr: null },
      fvg: null,
      retestZone: null,
      confirmation: { confirmed: false, candleTimestamp: null, detail: "Bias or Supertrend conflicts with this direction." },
      entryZone: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      invalidationLevel: null,
    };
  }

  const liquidityPools = buildLiquidityPools(setupFrame, setupAtr, direction, config.liquidityToleranceAtr);
  const sweep = detectSweep(setupFrame, liquidityPools, direction, setupAtr, config.sweepLookback);
  conditions.push(condition("liquidity", "Liquidity", liquidityPools.length ? "CONFIRMED" : "WAITING", liquidityPools.length ? `${liquidityPools.length} stop pool(s) detected.` : "Waiting for equal highs/lows."));
  conditions.push(condition("liquiditySweep", "Liquidity Sweep", sweep ? "CONFIRMED" : "WAITING", sweep ? `Swept ${round2(sweep.zone.level)}.` : "Waiting for liquidity sweep."));
  if (liquidityPools.length) reasonsFor.push(`${liquidityPools.length} ${wantsBull ? "sell-side" : "buy-side"} liquidity pool(s) detected.`);
  else reasonsAgainst.push("No equal-high/equal-low liquidity pool.");

  const bos = sweep ? detectBos(setupFrame, direction, sweep.index, config.maxBarsSweepToBos, setupAtr) : null;
  conditions.push(condition("bos", "BOS", bos ? "CONFIRMED" : "WAITING", bos ? `Close broke ${round2(bos.zone.level)} after sweep.` : sweep ? "Liquidity swept - waiting for BOS." : "BOS waits for sweep first."));
  const displacementConfirmed = Boolean(bos && bos.rangeToAtr >= config.displacementAtr);
  conditions.push(condition("displacement", "Displacement", displacementConfirmed ? "CONFIRMED" : "WAITING", bos ? `${bos.rangeToAtr} ATR BOS candle range.` : "Waiting for BOS candle displacement."));

  const fvg = bos ? detectFvg(setupFrame, direction, bos.index, setupAtr) : null;
  conditions.push(condition("fvg", "FVG", fvg ? "CONFIRMED" : config.requireFvg ? "WAITING" : "OPTIONAL", fvg ? `${round2(fvg.low)}-${round2(fvg.high)}` : "No fresh FVG confluence."));

  const retestZone = fvg ?? bos?.zone ?? nearLocation ?? null;
  const retest = bos && retestZone ? detectRetest(setupFrame, direction, retestZone, bos.index, config.maxBarsBosToRetest, setupAtr) : null;
  const entryZone = retestZone && retest ? [round2(retestZone.low), round2(retestZone.high)] as [number, number] : null;
  conditions.push(condition("retest", "Retest", retest ? "CONFIRMED" : "WAITING", retestZone ? retest ? `Retest touched ${round2(retestZone.low)}-${round2(retestZone.high)}.` : "BOS confirmed - waiting for retest." : "No valid retest zone yet."));

  const confirmation = entryZone && retestZone && retest?.active
    ? detectConfirmation(confirmFrame, direction, retestZone, confirmAtr)
    : { confirmed: false, candleTimestamp: null, detail: retest ? "Retest happened earlier - waiting for current confirmation." : "Waiting for retest before confirmation." };
  conditions.push(condition("confirmation", "Confirmation", confirmation.confirmed ? "CONFIRMED" : "WAITING", confirmation.detail));

  const plan = sweep && entryZone ? riskPlan(direction, entryZone, sweep.zone, setupAtr, opposingZones) : null;
  if (!plan && entryZone) reasonsAgainst.push("Risk plan rejected by structure or nearby opposing zone.");
  if (fvg) reasonsFor.push("Fresh FVG confluence after BOS.");
  if (bos) reasonsFor.push(`BOS confirmed after liquidity sweep at ${round2(bos.zone.level)}.`);
  if (displacementConfirmed) reasonsFor.push("BOS candle shows displacement.");
  if (retest) reasonsFor.push("Retest touched the relevant entry area.");
  if (confirmation.confirmed) reasonsFor.push(confirmation.detail);

  const candidate: Candidate = {
    direction,
    lifecycle: "SEARCHING",
    conditions,
    reasonsFor,
    reasonsAgainst,
    liquidityPools,
    liquiditySweep: sweep?.zone ?? null,
    bos: bos?.zone ?? null,
    displacement: {
      confirmed: displacementConfirmed,
      candleTimestamp: bos?.zone.createdAt ?? null,
      rangeToAtr: bos?.rangeToAtr ?? null,
    },
    fvg,
    retestZone,
    confirmation,
    entryZone,
    entry: plan?.entry ?? null,
    stopLoss: plan?.stopLoss ?? null,
    takeProfit: plan?.takeProfit ?? null,
    riskReward: plan?.riskReward ?? null,
    invalidationLevel: plan?.invalidationLevel ?? null,
  };
  candidate.lifecycle = lifecycleFromCandidate(candidate);
  if (candidate.lifecycle === "READY" && !plan) candidate.lifecycle = "INVALIDATED";
  return candidate;
}

function statusFromLifecycle(candidate: Candidate): UnifiedStrategyResult["status"] {
  if (candidate.lifecycle === "READY") return candidate.direction === "BUY" ? "VALID BUY" : "VALID SELL";
  if (candidate.lifecycle === "LIQUIDITY_FOUND" || candidate.lifecycle === "SWEPT") return "PRICE NEAR";
  if (["BOS_CONFIRMED", "RETEST_PENDING", "RETEST_ACTIVE", "CONFIRMATION_PENDING"].includes(candidate.lifecycle)) return "PENDING";
  return "NO TRADE";
}

function instructionFromLifecycle(candidate: Candidate) {
  if (candidate.lifecycle === "SEARCHING") return "Waiting for liquidity and location.";
  if (candidate.lifecycle === "LIQUIDITY_FOUND") return "Waiting for liquidity sweep.";
  if (candidate.lifecycle === "SWEPT") return "Liquidity swept - waiting for BOS.";
  if (candidate.lifecycle === "BOS_CONFIRMED") return "BOS confirmed - waiting for displacement/retest zone.";
  if (candidate.lifecycle === "RETEST_PENDING") return "Wait for retest.";
  if (candidate.lifecycle === "RETEST_ACTIVE") return "Price entered retest zone - waiting for confirmation close.";
  if (candidate.lifecycle === "CONFIRMATION_PENDING") return "Waiting for confirmation close.";
  if (candidate.lifecycle === "READY") return `${candidate.direction} setup confirmed.`;
  if (candidate.lifecycle === "INVALIDATED") return "Setup invalidated.";
  return "Setup expired.";
}

function scoreCandidate(candidate: Candidate) {
  return candidate.conditions.filter((item) => item.state === "CONFIRMED").length;
}

function chooseCandidate(buy: Candidate, sell: Candidate) {
  const buyScore = scoreCandidate(buy);
  const sellScore = scoreCandidate(sell);
  const buyReady = buy.lifecycle === "READY" ? 100 : 0;
  const sellReady = sell.lifecycle === "READY" ? 100 : 0;
  return buyScore + buyReady >= sellScore + sellReady ? buy : sell;
}

function htfBias(snapshot: MarketSnapshot, config: UnifiedStrategyConfig) {
  const structures = config.biasFrames
    .map((timeframe) => frame(snapshot, timeframe))
    .filter(Boolean)
    .map((series) => detectMarketStructure(detectPivots(series!.candles, series!.timeframe, 4)));
  const bullish = structures.filter((item) => item === "HH" || item === "HL").length;
  const bearish = structures.filter((item) => item === "LL" || item === "LH").length;
  return {
    bias: bullish > bearish ? "BULLISH" as const : bearish > bullish ? "BEARISH" as const : "MIXED" as const,
    text: structures.length ? structures.join(" -> ") : "MIXED",
  };
}

export function buildUnifiedStrategy(snapshot: MarketSnapshot, config = defaultUnifiedStrategyConfig): UnifiedStrategyResult {
  if (snapshot.marketState === "CLOSED") return empty("MARKET CLOSED", snapshot, "Market closed - no automatic strategy scan.");
  if (!snapshot.currentPrice || snapshot.stale || snapshot.series.length === 0) {
    return empty("DATA ERROR", snapshot, "Market data is missing, stale, incomplete or rejected.");
  }

  const setupFrame = frame(snapshot, config.setupFrame);
  const confirmFrame = frame(snapshot, config.confirmationFrame);
  if (!setupFrame || !confirmFrame) return empty("DATA ERROR", snapshot, "Required setup/confirmation candles are unavailable.");

  const setupAtr = calculateAtr(setupFrame.candles);
  const confirmAtr = calculateAtr(confirmFrame.candles);
  if (!setupAtr || !confirmAtr || setupFrame.candles.length < 80 || confirmFrame.candles.length < 80) {
    return empty("DATA ERROR", snapshot, "Insufficient closed candles for unified strategy calculations.");
  }

  const bias = htfBias(snapshot, config);
  const trendPoints = calculateSupertrend(setupFrame.candles, config.supertrendAtrLength, config.supertrendMultiplier);
  const supertrend = trendPoints.at(-1)?.direction ?? "UNKNOWN";
  const supportZones = buildZones(setupFrame, setupAtr, "support", config.zoneToleranceAtr);
  const resistanceZones = buildZones(setupFrame, setupAtr, "resistance", config.zoneToleranceAtr);
  const buy = buildCandidate("BUY", snapshot, setupFrame, confirmFrame, setupAtr, confirmAtr, supportZones, resistanceZones, bias.bias, supertrend, config);
  const sell = buildCandidate("SELL", snapshot, setupFrame, confirmFrame, setupAtr, confirmAtr, supportZones, resistanceZones, bias.bias, supertrend, config);
  const chosen = chooseCandidate(buy, sell);
  const status = statusFromLifecycle(chosen);
  const confirmed = scoreCandidate(chosen);

  return {
    id: `UNIFIED:${chosen.direction}:${chosen.lifecycle}:${setupFrame.latestClosedAt}`,
    strategy: "Unified Strategy",
    status,
    lifecycle: chosen.lifecycle,
    decision: status === "VALID BUY" ? "BUY" : status === "VALID SELL" ? "SELL" : "NO TRADE",
    direction: chosen.direction,
    instruction: instructionFromLifecycle(chosen),
    htfBias: bias.bias,
    marketStructure: bias.text,
    supertrend,
    supportZones,
    resistanceZones,
    liquidityPools: chosen.liquidityPools,
    liquiditySweep: chosen.liquiditySweep,
    bos: chosen.bos,
    displacement: chosen.displacement,
    fvg: chosen.fvg,
    retestZone: chosen.retestZone,
    confirmation: chosen.confirmation,
    entryZone: chosen.entryZone,
    entry: chosen.entry,
    stopLoss: chosen.stopLoss,
    takeProfit: chosen.takeProfit,
    riskReward: chosen.riskReward,
    invalidationLevel: chosen.invalidationLevel,
    setupQuality: {
      confirmed,
      total: chosen.conditions.length,
      items: chosen.conditions,
    },
    reasonsFor: chosen.reasonsFor,
    reasonsAgainst: chosen.reasonsAgainst,
    dataTimestamp: snapshot.updatedAt,
    candleTimeframe: setupFrame.timeframe,
    currentPrice: snapshot.currentPrice,
    atr: round2(setupAtr),
  };
}

import type { Candle, MarketSnapshot, MarketTimeframe } from "../market-data/types";
import type { GannLevel, GannSetupResult, MarketStructure, Pivot, ProximityState, TimeframeAnalysis } from "./types";

export const gannDegrees = [45, 90, 135, 180, 225, 270, 315, 360] as const;

export function squareOfNineLevel(pivot: number, degree: number, direction: 1 | -1) {
  const moved = Math.sqrt(pivot) + direction * (degree / 180);
  return Math.max(0, moved * moved);
}

export function calculateGannLevels(pivot: number, direction: 1 | -1): GannLevel[] {
  return gannDegrees.map((degree) => ({
    degree,
    price: squareOfNineLevel(pivot, degree, direction),
  }));
}

export function calculateAtr(candles: Candle[], period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = candles.slice(1).map((candle, index) => {
    const previous = candles[index];
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close),
    );
  });
  const values = trueRanges.slice(-period);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function detectPivots(candles: Candle[], timeframe: MarketTimeframe, wing = 3): Pivot[] {
  const pivots: Pivot[] = [];
  if (candles.length < wing * 2 + 1) return pivots;

  for (let index = wing; index < candles.length - wing; index += 1) {
    const candle = candles[index];
    const left = candles.slice(index - wing, index);
    const right = candles.slice(index + 1, index + wing + 1);
    const isHigh = left.every((item) => candle.high > item.high) && right.every((item) => candle.high >= item.high);
    const isLow = left.every((item) => candle.low < item.low) && right.every((item) => candle.low <= item.low);

    if (isHigh) {
      pivots.push({
        kind: "high",
        price: candle.high,
        timestamp: candle.timestamp,
        index,
        timeframe,
        strength: wing >= 4 ? "major" : "minor",
      });
    }
    if (isLow) {
      pivots.push({
        kind: "low",
        price: candle.low,
        timestamp: candle.timestamp,
        index,
        timeframe,
        strength: wing >= 4 ? "major" : "minor",
      });
    }
  }

  return pivots;
}

export function countBarsSincePivot(candles: Candle[], pivot: Pivot) {
  return Math.max(0, candles.length - 1 - pivot.index);
}

export function detectMarketStructure(pivots: Pivot[]): MarketStructure {
  const highs = pivots.filter((pivot) => pivot.kind === "high").slice(-2);
  const lows = pivots.filter((pivot) => pivot.kind === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "MIXED";
  const highHigher = highs[1].price > highs[0].price;
  const lowHigher = lows[1].price > lows[0].price;
  if (highHigher && lowHigher) return "HH";
  if (!highHigher && !lowHigher) return "LL";
  if (lowHigher) return "HL";
  return "LH";
}

function nearestLevel(levels: GannLevel[], price: number) {
  return levels.reduce((nearest, level) => (
    Math.abs(level.price - price) < Math.abs(nearest.price - price) ? level : nearest
  ), levels[0]);
}

function riskReward(entry: number, stop: number, targets: [number, number, number], direction: "BUY" | "SELL"): [number, number, number] {
  const risk = Math.max(0.01, Math.abs(entry - stop));
  return targets.map((target) => {
    const reward = direction === "BUY" ? target - entry : entry - target;
    return Number((reward / risk).toFixed(2));
  }) as [number, number, number];
}

function setupId(symbol: string, direction: string, pivot: Pivot | null, frame: string) {
  return [symbol, direction, frame, pivot?.kind, pivot?.timestamp, pivot?.price.toFixed(2)].join(":");
}

function analyzeFrame(timeframe: MarketTimeframe, candles: Candle[]): TimeframeAnalysis {
  const minor = detectPivots(candles, timeframe, 3);
  const major = detectPivots(candles, timeframe, 5);
  const pivots = [...minor, ...major].sort((a, b) => a.index - b.index);
  return {
    timeframe,
    candles,
    pivots,
    latestPivot: pivots.at(-1) ?? null,
    structure: detectMarketStructure(pivots),
    atr: calculateAtr(candles),
  };
}

function proximityState(distance: number, atr: number): ProximityState {
  if (distance <= atr * 0.35) return "in-zone";
  if (distance <= atr * 0.9) return "approaching";
  return "far";
}

export function buildGannSetup(snapshot: MarketSnapshot): GannSetupResult {
  const now = snapshot.updatedAt;
  if (snapshot.marketState === "CLOSED") {
    return emptySetup("MARKET CLOSED", snapshot, ["Gold market is closed."], false);
  }
  if (!snapshot.currentPrice || snapshot.stale || snapshot.series.length === 0) {
    return emptySetup("DATA ERROR", snapshot, ["Market data is missing or stale."], snapshot.marketState === "OPEN");
  }

  const analyses = snapshot.series.map((item) => analyzeFrame(item.timeframe, item.candles));
  const primary = analyses.find((item) => item.timeframe === "1H") ?? analyses[0];
  if (!primary?.latestPivot || !primary.atr) {
    return emptySetup("NO SETUP", snapshot, ["Not enough confirmed closed candles for a pivot."], true);
  }

  const pivot = primary.latestPivot;
  const direction = pivot.kind === "low" ? "BUY" : "SELL";
  const sign = direction === "BUY" ? 1 : -1;
  const levels = calculateGannLevels(pivot.price, sign);
  const sortedLevels = [...levels].sort((a, b) => direction === "BUY" ? a.price - b.price : b.price - a.price);
  const nearest = nearestLevel(sortedLevels, snapshot.currentPrice);
  const entry = nearest.price;
  const entryHalfWidth = primary.atr * 0.25;
  const entryZone: [number, number] = [
    Number((entry - entryHalfWidth).toFixed(2)),
    Number((entry + entryHalfWidth).toFixed(2)),
  ];
  const distanceToEntry = Math.abs(snapshot.currentPrice - entry);
  const proximity = proximityState(distanceToEntry, primary.atr);
  const barsElapsed = countBarsSincePivot(primary.candles, pivot);
  const cycleLength = Math.max(1, Math.round(Math.sqrt(pivot.price)));
  const remainder = barsElapsed % cycleLength;
  const barsToWindow = remainder === 0 && barsElapsed > 0 ? 0 : cycleLength - remainder;
  const timeActive = barsToWindow <= 2 || barsToWindow >= cycleLength - 2;
  const structureSupports = direction === "BUY"
    ? primary.structure === "HH" || primary.structure === "HL"
    : primary.structure === "LL" || primary.structure === "LH";
  const supportingTimeframes = analyses
    .filter((item) => direction === "BUY"
      ? item.structure === "HH" || item.structure === "HL"
      : item.structure === "LL" || item.structure === "LH")
    .map((item) => item.timeframe);
  const closeConfirms = direction === "BUY"
    ? primary.candles.at(-1)!.close > pivot.price
    : primary.candles.at(-1)!.close < pivot.price;
  const oneByOne = direction === "BUY"
    ? snapshot.currentPrice >= pivot.price + barsElapsed
    : snapshot.currentPrice <= pivot.price - barsElapsed;
  const confluenceCount = analyses.filter((item) => item.latestPivot?.kind === pivot.kind).length;
  const fiftyLevel = direction === "BUY"
    ? pivot.price + (entry - pivot.price) / 2
    : pivot.price - (pivot.price - entry) / 2;

  const targetCandidates = sortedLevels.filter((level) => (
    direction === "BUY" ? level.price > entry : level.price < entry
  ));
  const targets = (targetCandidates.length >= 3 ? targetCandidates.slice(0, 3) : sortedLevels.slice(1, 4))
    .map((level) => Number(level.price.toFixed(2))) as [number, number, number];
  const stopLoss = Number((direction === "BUY" ? pivot.price - primary.atr : pivot.price + primary.atr).toFixed(2));
  const invalidationLevel = stopLoss;
  const entryValue = Number(entry.toFixed(2));
  const rr = riskReward(entryValue, stopLoss, targets, direction);

  const scoreParts = [
    proximity !== "far" ? 22 : 4,
    structureSupports ? 18 : 0,
    closeConfirms ? 16 : 0,
    supportingTimeframes.length >= 3 ? 18 : supportingTimeframes.length * 5,
    timeActive ? 12 : 3,
    oneByOne ? 8 : 0,
    confluenceCount >= 3 ? 6 : 0,
  ];
  const score = Math.min(100, scoreParts.reduce((sum, value) => sum + value, 0));

  let status: GannSetupResult["status"] = "NO SETUP";
  if (proximity === "approaching") status = "PRICE NEAR";
  if (proximity === "in-zone") status = "PENDING CONFIRMATION";
  if (proximity === "in-zone" && structureSupports && closeConfirms && supportingTimeframes.length >= 2 && score >= 66) {
    status = direction === "BUY" ? "VALID BUY SETUP" : "VALID SELL SETUP";
  }

  const reasons = [
    `${pivot.strength} ${pivot.kind} pivot selected from ${primary.timeframe}.`,
    `Current price is ${distanceToEntry.toFixed(2)} from ${nearest.degree} degree Square-of-Nine level.`,
    structureSupports ? "Market structure supports the setup direction." : "Market structure confirmation is incomplete.",
    closeConfirms ? "Latest closed candle confirms away from the anchor pivot." : "Closing-price confirmation is missing.",
    timeActive ? "Gann time window is active or very near." : `Next time-square window in ${barsToWindow} bars.`,
  ];

  return {
    id: setupId(snapshot.symbol, direction, pivot, primary.timeframe),
    status,
    direction,
    symbol: snapshot.symbol,
    currentPrice: snapshot.currentPrice,
    dataTimestamp: now,
    anchorPivot: pivot,
    supportingTimeframes,
    entryZone,
    stopLoss,
    targets,
    riskReward: rr,
    invalidationLevel,
    distanceToEntry: Number(distanceToEntry.toFixed(2)),
    proximityState: proximity,
    score,
    ruleBreakdown: [
      `Adaptive ATR proximity: ${proximity}`,
      `Structure: ${primary.structure}`,
      `1x1 trend rule: ${oneByOne ? "confirmed" : "not confirmed"}`,
      `50% level between pivot and entry: ${fiftyLevel.toFixed(2)}`,
      `Double/triple pivot confluence count: ${confluenceCount}`,
    ],
    gannLevels: levels.map((level) => ({ degree: level.degree, price: Number(level.price.toFixed(2)) })),
    timeCycle: {
      barsElapsed,
      cycleLength,
      barsToWindow,
      active: timeActive,
    },
    reasons,
    marketStructure: primary.structure,
    atr: Number(primary.atr.toFixed(2)),
    marketOpen: true,
  };
}

function emptySetup(status: GannSetupResult["status"], snapshot: MarketSnapshot, reasons: string[], marketOpen: boolean): GannSetupResult {
  return {
    id: `${snapshot.symbol}:${status}:${snapshot.updatedAt}`,
    status,
    direction: "NONE",
    symbol: snapshot.symbol,
    currentPrice: snapshot.currentPrice,
    dataTimestamp: snapshot.updatedAt,
    anchorPivot: null,
    supportingTimeframes: [],
    entryZone: null,
    stopLoss: null,
    targets: null,
    riskReward: null,
    invalidationLevel: null,
    distanceToEntry: null,
    proximityState: "far",
    score: 0,
    ruleBreakdown: [],
    gannLevels: [],
    timeCycle: null,
    reasons,
    marketStructure: "MIXED",
    atr: null,
    marketOpen,
  };
}


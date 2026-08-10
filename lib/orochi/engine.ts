import { calculateAtr, detectMarketStructure, detectPivots } from "../gann/engine";
import type { Candle, MarketSnapshot, MarketTimeframe, TimeframeSeries } from "../market-data/types";
import type { AuctionCondition, OrochiResult } from "./types";

type Profile = {
  vah: number;
  val: number;
  poc: number;
  vwap: number;
  upperBand: number;
  lowerBand: number;
};

function frame(snapshot: MarketSnapshot, timeframe: MarketTimeframe) {
  return snapshot.series.find((item) => item.timeframe === timeframe);
}

function hlc3(candle: Candle) {
  return (candle.high + candle.low + candle.close) / 3;
}

function candleWeight(candle: Candle) {
  return Math.max(1, candle.volume ?? 1);
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

function baghdadSessionKey(timestamp: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function currentSession(candles: Candle[]) {
  const lastKey = baghdadSessionKey(candles.at(-1)!.timestamp);
  return candles.filter((candle) => baghdadSessionKey(candle.timestamp) === lastKey);
}

function buildProfile(candles: Candle[]): Profile | null {
  if (candles.length < 20) return null;
  const prices = candles.flatMap((candle) => [candle.high, candle.low, candle.close]);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const binCount = 24;
  const step = Math.max(0.01, (high - low) / binCount);
  const bins = Array.from({ length: binCount + 1 }, (_, index) => ({
    index,
    price: low + index * step,
    volume: 0,
  }));
  let totalVolume = 0;
  let weightedPrice = 0;

  candles.forEach((candle) => {
    const price = hlc3(candle);
    const volume = candleWeight(candle);
    const index = Math.max(0, Math.min(binCount, Math.round((price - low) / step)));
    bins[index].volume += volume;
    totalVolume += volume;
    weightedPrice += price * volume;
  });

  const sorted = [...bins].sort((a, b) => b.volume - a.volume);
  const poc = sorted[0].price;
  const valueTarget = totalVolume * 0.7;
  let accumulated = 0;
  const selected: number[] = [];
  for (const bin of sorted) {
    accumulated += bin.volume;
    selected.push(bin.price);
    if (accumulated >= valueTarget) break;
  }

  const vwap = weightedPrice / totalVolume;
  const variance = candles.reduce((sum, candle) => {
    const price = hlc3(candle);
    return sum + Math.pow(price - vwap, 2) * candleWeight(candle);
  }, 0) / totalVolume;
  const deviation = Math.sqrt(variance);

  return {
    vah: round2(Math.max(...selected)),
    val: round2(Math.min(...selected)),
    poc: round2(poc),
    vwap: round2(vwap),
    upperBand: round2(vwap + deviation),
    lowerBand: round2(vwap - deviation),
  };
}

function structureFor(series: TimeframeSeries) {
  const pivots = detectPivots(series.candles, series.timeframe, 3);
  return {
    pivots,
    structure: detectMarketStructure(pivots),
  };
}

function riskReward(entry: number, stop: number, targets: [number, number, number], direction: "BUY" | "SELL"): [number, number, number] {
  const risk = Math.max(0.01, Math.abs(entry - stop));
  return targets.map((target) => {
    const reward = direction === "BUY" ? target - entry : entry - target;
    return round2(reward / risk);
  }) as [number, number, number];
}

function empty(status: OrochiResult["status"], snapshot: MarketSnapshot, reason: string): OrochiResult {
  return {
    id: `OROCHI:${status}:${snapshot.updatedAt}`,
    strategy: "Orochi Auction Framework",
    status,
    decision: "NO TRADE",
    direction: "NONE",
    frameworkSetup: "No trade",
    marketCondition: "Transition",
    entryType: "None",
    entryZone: null,
    stopLoss: null,
    targets: null,
    riskReward: null,
    invalidationLevel: null,
    confidence: 0,
    score: 0,
    structure: "MIXED",
    confluences: [],
    auctionEvidence: [reason],
    orderFlowEvidence: [],
    missingInformation: ["CVD / footprint delta", "Live economic news filter"],
    newsRisk: "Unknown - no live economic news feed connected.",
    dataTimestamp: snapshot.updatedAt,
    candleTimeframe: "15m",
    valueArea: null,
  };
}

function marketCondition(currentPrice: number, profile: Profile, structure: string, atr: number): AuctionCondition {
  const insideValue = currentPrice >= profile.val && currentPrice <= profile.vah;
  const valueWidth = profile.vah - profile.val;
  if (insideValue && valueWidth <= atr * 4) return "Balance";
  if (structure === "HH" || structure === "LL") return "Imbalance";
  return "Transition";
}

export function buildOrochiSetup(snapshot: MarketSnapshot): OrochiResult {
  if (snapshot.marketState === "CLOSED") return empty("MARKET CLOSED", snapshot, "Gold market is closed.");
  if (!snapshot.currentPrice || snapshot.stale || snapshot.series.length === 0) {
    return empty("DATA ERROR", snapshot, "Market data is missing or stale.");
  }

  const biasFrame = frame(snapshot, "1H") ?? frame(snapshot, "4H");
  const setupFrame = frame(snapshot, "15m");
  const confirmFrame = frame(snapshot, "5m");
  if (!biasFrame || !setupFrame || !confirmFrame) return empty("DATA ERROR", snapshot, "Required 1H/15m/5m candles are unavailable.");

  const profile = buildProfile(currentSession(setupFrame.candles)) ?? buildProfile(setupFrame.candles.slice(-96));
  const atr = calculateAtr(setupFrame.candles);
  if (!profile || !atr) return empty("NO SETUP", snapshot, "Not enough candles to build auction profile.");

  const bias = structureFor(biasFrame);
  const setup = structureFor(setupFrame);
  const confirmationCandles = confirmFrame.candles.slice(-3);
  const last = confirmationCandles.at(-1)!;
  const previous = confirmationCandles.at(-2) ?? last;
  const condition = marketCondition(snapshot.currentPrice, profile, bias.structure, atr);
  const bullishBias = bias.structure === "HH" || bias.structure === "HL";
  const bearishBias = bias.structure === "LL" || bias.structure === "LH";
  const returnedInsideValue = last.close >= profile.val && last.close <= profile.vah;
  const bullishClose = last.close > previous.high || (last.close > last.open && last.close > profile.val);
  const bearishClose = last.close < previous.low || (last.close < last.open && last.close < profile.vah);
  const nearVal = snapshot.currentPrice <= profile.val + atr * 0.55 || snapshot.currentPrice <= profile.lowerBand + atr * 0.35;
  const nearVah = snapshot.currentPrice >= profile.vah - atr * 0.55 || snapshot.currentPrice >= profile.upperBand - atr * 0.35;
  const brokeAboveValue = setupFrame.candles.slice(-4, -1).some((candle) => candle.high > profile.vah + atr * 0.25);
  const brokeBelowValue = setupFrame.candles.slice(-4, -1).some((candle) => candle.low < profile.val - atr * 0.25);

  let direction: "BUY" | "SELL" | "NONE" = "NONE";
  let frameworkSetup = "No trade";
  let entryType: OrochiResult["entryType"] = "None";
  const confluences: string[] = [];
  const auctionEvidence: string[] = [
    `${condition} auction condition from 15m profile proxy.`,
    `Value area ${profile.val.toFixed(2)}-${profile.vah.toFixed(2)}, POC ${profile.poc.toFixed(2)}, VWAP ${profile.vwap.toFixed(2)}.`,
    `${biasFrame.timeframe} structure: ${bias.structure}; ${setupFrame.timeframe} structure: ${setup.structure}.`,
  ];

  if (condition === "Balance" && nearVal && returnedInsideValue && bullishBias) {
    direction = "BUY";
    frameworkSetup = "Balance Fade";
    entryType = "Confirmation";
    confluences.push("VAL / lower VWAP deviation rejection", "Higher-timeframe bullish structure");
  } else if (condition === "Balance" && nearVah && returnedInsideValue && bearishBias) {
    direction = "SELL";
    frameworkSetup = "Balance Fade";
    entryType = "Confirmation";
    confluences.push("VAH / upper VWAP deviation rejection", "Higher-timeframe bearish structure");
  } else if (brokeAboveValue && returnedInsideValue && bearishClose) {
    direction = "SELL";
    frameworkSetup = "Failed Auction";
    entryType = "Confirmation";
    confluences.push("Failed acceptance above value", "Return inside value");
  } else if (brokeBelowValue && returnedInsideValue && bullishClose) {
    direction = "BUY";
    frameworkSetup = "Failed Auction";
    entryType = "Confirmation";
    confluences.push("Failed acceptance below value", "Return inside value");
  } else if (snapshot.currentPrice > profile.vah && bullishBias && last.low >= profile.vah - atr * 0.25) {
    direction = "BUY";
    frameworkSetup = "Accepted Breakout";
    entryType = "Confirmation";
    confluences.push("Acceptance above VAH", "Retest holding above value");
  } else if (snapshot.currentPrice < profile.val && bearishBias && last.high <= profile.val + atr * 0.25) {
    direction = "SELL";
    frameworkSetup = "Accepted Breakout";
    entryType = "Confirmation";
    confluences.push("Acceptance below VAL", "Retest holding below value");
  }

  if (direction === "NONE") {
    return {
      ...empty("NO SETUP", snapshot, "No complete Orochi auction setup from closed candles."),
      marketCondition: condition,
      structure: `${bias.structure} / ${setup.structure}`,
      auctionEvidence,
      valueArea: profile,
    };
  }

  const entryMid = direction === "BUY" ? Math.max(profile.val, profile.lowerBand) : Math.min(profile.vah, profile.upperBand);
  const entryZone: [number, number] = [round2(entryMid - atr * 0.18), round2(entryMid + atr * 0.18)];
  const stopLoss = direction === "BUY" ? round2(Math.min(profile.val, last.low) - atr * 0.65) : round2(Math.max(profile.vah, last.high) + atr * 0.65);
  const targets: [number, number, number] = direction === "BUY"
    ? [round2(profile.poc), round2(profile.vah), round2(profile.vah + atr * 2.2)]
    : [round2(profile.poc), round2(profile.val), round2(profile.val - atr * 2.2)];
  const rr = riskReward((entryZone[0] + entryZone[1]) / 2, stopLoss, targets, direction);
  const closedCandleConfirms = direction === "BUY" ? bullishClose : bearishClose;
  const score = Math.min(72, 28
    + (condition !== "Transition" ? 12 : 4)
    + (confluences.length * 8)
    + (closedCandleConfirms ? 12 : 0)
    + (Math.max(...rr) >= 3 ? 8 : 0));

  const status: OrochiResult["status"] = closedCandleConfirms ? "PENDING" : "PRICE NEAR";
  const missingInformation = [
    "True TPO / exchange volume profile is not connected; using candle-volume profile proxy.",
    "CVD / footprint delta / stacked imbalance feed is not connected.",
    "Live economic news filter is not connected.",
  ];

  return {
    id: `OROCHI:${frameworkSetup}:${direction}:${setupFrame.latestClosedAt}`,
    strategy: "Orochi Auction Framework",
    status,
    decision: "NO TRADE",
    direction,
    frameworkSetup,
    marketCondition: condition,
    entryType,
    entryZone,
    stopLoss,
    targets,
    riskReward: rr,
    invalidationLevel: stopLoss,
    confidence: score,
    score,
    structure: `${bias.structure} / ${setup.structure}`,
    confluences,
    auctionEvidence,
    orderFlowEvidence: ["Unavailable: no CVD, volume delta or footprint provider is connected."],
    missingInformation,
    newsRisk: "Unknown - no live economic news feed connected.",
    dataTimestamp: snapshot.updatedAt,
    candleTimeframe: setupFrame.timeframe,
    valueArea: profile,
  };
}

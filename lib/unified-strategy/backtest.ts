import type { Candle, MarketSnapshot, MarketTimeframe, TimeframeSeries } from "../market-data/types";
import { buildUnifiedStrategy, defaultUnifiedStrategyConfig } from "./engine";
import type { BacktestSummary, BacktestTrade, UnifiedStrategyConfig } from "./types";

function riskResult(direction: "BUY" | "SELL", entry: number, stop: number, target: number, candles: Candle[]) {
  for (const candle of candles) {
    const hitStop = direction === "BUY" ? candle.low <= stop : candle.high >= stop;
    const hitTarget = direction === "BUY" ? candle.high >= target : candle.low <= target;
    if (hitStop) return { result: "LOSS" as const, closedAt: candle.timestamp, r: -1 };
    if (hitTarget) return { result: "WIN" as const, closedAt: candle.timestamp, r: Math.abs(target - entry) / Math.abs(entry - stop) };
  }
  return { result: "OPEN" as const, closedAt: null, r: 0 };
}

function sliceSeries(series: TimeframeSeries[], endTimestamp: string): TimeframeSeries[] {
  const end = new Date(endTimestamp).getTime();
  return series.map((item) => {
    const candles = item.candles.filter((candle) => new Date(candle.timestamp).getTime() <= end);
    return {
      timeframe: item.timeframe,
      candles,
      latestClosedAt: candles.at(-1)?.timestamp ?? null,
    };
  });
}

export function backtestUnifiedStrategy(
  baseSnapshot: MarketSnapshot,
  config: UnifiedStrategyConfig = defaultUnifiedStrategyConfig,
  executionFrame: MarketTimeframe = "5m",
): BacktestSummary {
  const setupSeries = baseSnapshot.series.find((item) => item.timeframe === config.setupFrame);
  const executionSeries = baseSnapshot.series.find((item) => item.timeframe === executionFrame);
  if (!setupSeries || !executionSeries) {
    return { setups: 0, wins: 0, losses: 0, winRate: 0, averageR: 0, expectancy: 0, maxDrawdownR: 0, buySetups: 0, sellSetups: 0, trades: [] };
  }

  const trades: BacktestTrade[] = [];
  for (let index = 90; index < setupSeries.candles.length - 10; index += 1) {
    const timestamp = setupSeries.candles[index].timestamp;
    const snapshot: MarketSnapshot = {
      ...baseSnapshot,
      currentPrice: setupSeries.candles[index].close,
      updatedAt: timestamp,
      stale: false,
      series: sliceSeries(baseSnapshot.series, timestamp),
    };
    const result = buildUnifiedStrategy(snapshot, config);
    if ((result.decision !== "BUY" && result.decision !== "SELL") || !result.entry || !result.stopLoss || !result.takeProfit) continue;
    if (trades.some((trade) => trade.openedAt === result.dataTimestamp && trade.direction === result.decision)) continue;

    const future = executionSeries.candles.filter((candle) => new Date(candle.timestamp).getTime() > new Date(timestamp).getTime()).slice(0, 120);
    const outcome = riskResult(result.decision, result.entry, result.stopLoss, result.takeProfit, future);
    trades.push({
      direction: result.decision,
      entry: result.entry,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      openedAt: timestamp,
      closedAt: outcome.closedAt,
      result: outcome.result,
      r: outcome.r,
      lifecycle: result.lifecycle,
    });
  }

  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const trade of trades) {
    equity += trade.r;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.min(maxDrawdownR, equity - peak);
  }

  const closed = trades.filter((trade) => trade.result !== "OPEN");
  const wins = closed.filter((trade) => trade.result === "WIN").length;
  const losses = closed.filter((trade) => trade.result === "LOSS").length;
  const totalR = closed.reduce((sum, trade) => sum + trade.r, 0);
  const setups = closed.length;

  return {
    setups,
    wins,
    losses,
    winRate: setups ? Number((wins / setups).toFixed(3)) : 0,
    averageR: setups ? Number((totalR / setups).toFixed(2)) : 0,
    expectancy: setups ? Number((totalR / setups).toFixed(2)) : 0,
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    buySetups: closed.filter((trade) => trade.direction === "BUY").length,
    sellSetups: closed.filter((trade) => trade.direction === "SELL").length,
    trades,
  };
}

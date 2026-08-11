import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedStrategy } from "../lib/unified-strategy/engine.ts";
import { backtestUnifiedStrategy } from "../lib/unified-strategy/backtest.ts";
import { calculateSupertrend } from "../lib/unified-strategy/supertrend.ts";

function candle(index, close, options = {}) {
  const date = new Date(Date.UTC(2026, 0, 5, 8, index * 5));
  const open = options.open ?? close - 0.8;
  return {
    timestamp: date.toISOString(),
    open,
    high: options.high ?? Math.max(open, close) + 1.2,
    low: options.low ?? Math.min(open, close) - 1.2,
    close,
    volume: options.volume ?? 10,
  };
}

function trendingCandles(length = 180, direction = 1) {
  return Array.from({ length }, (_, index) => {
    const wave = Math.sin(index / 5) * 7;
    const trend = direction * index * 0.45;
    return candle(index, Number((4300 + wave + trend).toFixed(2)), { volume: 8 + (index % 5) });
  });
}

function snapshot(overrides = {}) {
  const data = trendingCandles();
  return {
    symbol: "XAU/USD",
    provider: "Dukascopy Free Data Feed",
    currentPrice: data.at(-1).close,
    updatedAt: "2026-01-05T12:00:00.000Z",
    marketState: "OPEN",
    stale: false,
    series: ["5m", "15m", "30m", "1H", "4H", "1D"].map((timeframe) => ({
      timeframe,
      candles: data,
      latestClosedAt: data.at(-1).timestamp,
    })),
    ...overrides,
  };
}

test("returns DATA ERROR instead of manufacturing a setup when data is stale", () => {
  const result = buildUnifiedStrategy(snapshot({ stale: true }));
  assert.equal(result.status, "DATA ERROR");
  assert.equal(result.decision, "NO TRADE");
  assert.equal(result.entry, null);
});

test("calculates Supertrend from closed candles", () => {
  const points = calculateSupertrend(trendingCandles(), 10, 3);
  assert.ok(points.length > 50);
  assert.match(points.at(-1).direction, /BULLISH|BEARISH/);
  assert.ok(Number.isFinite(points.at(-1).value));
});

test("reports lifecycle and confluence score transparently", () => {
  const result = buildUnifiedStrategy(snapshot());
  assert.equal(result.strategy, "Unified Strategy");
  assert.ok(result.setupQuality.total >= 9);
  assert.ok(result.setupQuality.confirmed <= result.setupQuality.total);
  assert.match(result.lifecycle, /SEARCHING|LIQUIDITY_FOUND|SWEPT|BOS_CONFIRMED|RETEST_PENDING|RETEST_ACTIVE|CONFIRMATION_PENDING|READY|INVALIDATED|EXPIRED/);
  assert.notEqual(result.instruction.length, 0);
});

test("backtest uses the same unified strategy evaluator", () => {
  const summary = backtestUnifiedStrategy(snapshot());
  assert.ok(Array.isArray(summary.trades));
  assert.ok(summary.setups >= 0);
  assert.ok(summary.maxDrawdownR <= 0);
});

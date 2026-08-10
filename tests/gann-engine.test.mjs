import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGannSetup,
  calculateAtr,
  countBarsSincePivot,
  detectPivots,
  squareOfNineLevel,
} from "../lib/gann/engine.ts";

function candle(index, close) {
  const date = new Date(Date.UTC(2026, 0, 1, index));
  return {
    timestamp: date.toISOString(),
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
  };
}

function trendingCandles() {
  const prices = [
    4300, 4295, 4290, 4284, 4278, 4288, 4298, 4310, 4320, 4312,
    4304, 4298, 4308, 4322, 4334, 4344, 4338, 4330, 4324, 4336,
    4348, 4360, 4352, 4346, 4358, 4370, 4384, 4376, 4368, 4380,
    4392, 4405, 4398, 4390, 4402, 4414, 4426, 4418, 4410, 4422,
    4434, 4446, 4438, 4430, 4442, 4455, 4468, 4460, 4452, 4464,
    4476, 4488, 4480, 4472, 4484, 4498, 4510, 4502, 4494, 4506,
  ];
  return prices.map((price, index) => candle(index, price));
}

function snapshot(overrides = {}) {
  const candles = trendingCandles();
  return {
    symbol: "XAU/USD",
    provider: "Dukascopy Free Data Feed",
    currentPrice: candles.at(-1).close,
    updatedAt: "2026-01-03T12:00:00.000Z",
    marketState: "OPEN",
    stale: false,
    series: ["5m", "15m", "30m", "1H", "4H", "1D"].map((timeframe) => ({
      timeframe,
      candles,
      latestClosedAt: candles.at(-1).timestamp,
    })),
    ...overrides,
  };
}

test("calculates Square-of-Nine levels deterministically", () => {
  assert.equal(Number(squareOfNineLevel(4280, 90, 1).toFixed(2)), 4345.67);
  assert.equal(Number(squareOfNineLevel(4280, 90, -1).toFixed(2)), 4214.83);
});

test("detects confirmed non-repainting pivots and counts bars", () => {
  const candles = trendingCandles();
  const pivots = detectPivots(candles, "1H", 3);
  assert.ok(pivots.some((pivot) => pivot.kind === "low"));
  const pivot = pivots[0];
  assert.equal(countBarsSincePivot(candles, pivot), candles.length - 1 - pivot.index);
});

test("calculates ATR from closed candles", () => {
  const atr = calculateAtr(trendingCandles());
  assert.ok(atr);
  assert.ok(atr > 0);
});

test("returns a deterministic setup status with no fake data", () => {
  const result = buildGannSetup(snapshot());
  assert.notEqual(result.status, "SCANNING");
  assert.equal(result.symbol, "XAU/USD");
  assert.ok(result.reasons.length > 0);
  assert.ok(result.gannLevels.length === 8 || result.status === "NO SETUP");
});

test("returns MARKET CLOSED when the market snapshot is closed", () => {
  const result = buildGannSetup(snapshot({ marketState: "CLOSED" }));
  assert.equal(result.status, "MARKET CLOSED");
  assert.equal(result.direction, "NONE");
});

test("returns DATA ERROR when data is stale or unavailable", () => {
  const result = buildGannSetup(snapshot({ stale: true, currentPrice: null, series: [] }));
  assert.equal(result.status, "DATA ERROR");
  assert.equal(result.direction, "NONE");
});

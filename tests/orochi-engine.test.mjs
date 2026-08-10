import assert from "node:assert/strict";
import test from "node:test";
import { buildOrochiSetup } from "../lib/orochi/engine.ts";

function candle(index, close, volume = 10) {
  const date = new Date(Date.UTC(2026, 0, 5, 8, index * 5));
  return {
    timestamp: date.toISOString(),
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume,
  };
}

function candles() {
  const prices = Array.from({ length: 180 }, (_, index) => 4300 + Math.sin(index / 8) * 12 + index * 0.25);
  return prices.map((price, index) => candle(index, Number(price.toFixed(2)), 8 + (index % 9)));
}

function snapshot(overrides = {}) {
  const data = candles();
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

test("returns DATA ERROR when candles are stale", () => {
  const result = buildOrochiSetup(snapshot({ stale: true }));
  assert.equal(result.status, "DATA ERROR");
  assert.equal(result.decision, "NO TRADE");
});

test("does not validate a trade without order-flow and news data", () => {
  const result = buildOrochiSetup(snapshot());
  assert.notEqual(result.status, "VALID BUY");
  assert.notEqual(result.status, "VALID SELL");
  assert.equal(result.decision, "NO TRADE");
  assert.ok(result.missingInformation.some((item) => item.includes("CVD")));
});

test("builds deterministic auction evidence from OHLC candles", () => {
  const result = buildOrochiSetup(snapshot());
  assert.equal(result.strategy, "Orochi Auction Framework");
  assert.ok(result.auctionEvidence.length > 0);
  if (result.valueArea) {
    assert.ok(result.valueArea.vah >= result.valueArea.val);
    assert.ok(result.valueArea.poc > 0);
  }
});

import { getHistoricalRates } from "dukascopy-node";
import type { Candle, MarketDataResult, MarketSnapshot, MarketTimeframe, TimeframeSeries } from "./types";

const CACHE_TTL_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const MAX_REFRESHES_PER_WINDOW = 3;
const REQUIRED_FRAMES: MarketTimeframe[] = ["5m", "15m", "30m", "1H", "4H", "1D"];
type DukascopyTimeframe = "m5" | "m15" | "m30" | "h1" | "h4" | "d1";

const timeframeConfig: Record<MarketTimeframe, { dukascopyFrame: DukascopyTimeframe; lookbackDays: number; minCandles: number }> = {
  "5m": { dukascopyFrame: "m5", lookbackDays: 3, minCandles: 120 },
  "15m": { dukascopyFrame: "m15", lookbackDays: 7, minCandles: 120 },
  "30m": { dukascopyFrame: "m30", lookbackDays: 10, minCandles: 120 },
  "1H": { dukascopyFrame: "h1", lookbackDays: 14, minCandles: 120 },
  "4H": { dukascopyFrame: "h4", lookbackDays: 35, minCandles: 120 },
  "1D": { dukascopyFrame: "d1", lookbackDays: 220, minCandles: 120 },
};

type DukascopyCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type CacheEntry = {
  expiresAt: number;
  snapshot: MarketSnapshot;
};

let cache: CacheEntry | null = null;
let requestWindowStartedAt = 0;
let requestCount = 0;

function canRefresh(now: number) {
  if (now - requestWindowStartedAt > RATE_WINDOW_MS) {
    requestWindowStartedAt = now;
    requestCount = 0;
  }
  if (requestCount >= MAX_REFRESHES_PER_WINDOW) return false;
  requestCount += 1;
  return true;
}

function marketStateFromDate(now: Date): MarketSnapshot["marketState"] {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return "CLOSED";
  return "OPEN";
}

function normalizeCandles(values: DukascopyCandle[]): Candle[] {
  return values
    .map((value) => ({
      timestamp: new Date(value.timestamp).toISOString(),
      open: value.open,
      high: value.high,
      low: value.low,
      close: value.close,
    }))
    .filter((candle) => (
      Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close)
    ))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

async function fetchFrame(timeframe: MarketTimeframe): Promise<TimeframeSeries> {
  const config = timeframeConfig[timeframe];
  const to = new Date();
  const from = new Date(Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000);
  const values = await getHistoricalRates({
    instrument: "xauusd",
    dates: { from, to },
    timeframe: config.dukascopyFrame,
    format: "json",
    ignoreFlats: true,
  }) as DukascopyCandle[];

  const candles = normalizeCandles(values).slice(-160);
  if (candles.length < config.minCandles) {
    throw new Error(`Dukascopy returned insufficient ${timeframe} XAU/USD candles`);
  }

  return {
    timeframe,
    candles,
    latestClosedAt: candles.at(-1)?.timestamp ?? null,
  };
}

export async function getFreeXauUsdSnapshot(force = false): Promise<MarketDataResult> {
  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) {
    return { ok: true, snapshot: cache.snapshot, cache: "hit" };
  }

  if (!canRefresh(now)) {
    if (cache) return { ok: true, snapshot: { ...cache.snapshot, stale: true }, cache: "hit" };
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Market-data refresh is temporarily rate limited.",
      },
    };
  }

  try {
    const series = await Promise.all(REQUIRED_FRAMES.map((frame) => fetchFrame(frame)));
    const primary = series.find((item) => item.timeframe === "5m");
    const currentPrice = primary?.candles.at(-1)?.close ?? null;
    const latestTimestamp = primary?.candles.at(-1)?.timestamp;
    const marketState = marketStateFromDate(new Date());
    const staleThreshold = marketState === "CLOSED" ? 72 * 60_000 * 60 : 20 * 60_000;
    const stale = latestTimestamp ? now - new Date(latestTimestamp).getTime() > staleThreshold : true;

    const snapshot: MarketSnapshot = {
      symbol: "XAU/USD",
      provider: "Dukascopy Free Data Feed",
      currentPrice,
      updatedAt: new Date().toISOString(),
      marketState,
      stale,
      series,
    };

    cache = { expiresAt: now + CACHE_TTL_MS, snapshot };
    return { ok: true, snapshot, cache: "miss" };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: error instanceof Error ? error.message : "Free XAU/USD OHLC provider failed.",
      },
    };
  }
}

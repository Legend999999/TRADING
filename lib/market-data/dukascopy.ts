import { getHistoricalRates, getRealTimeRates } from "dukascopy-node";
import type { RealTimeRatesConfigJsonItem } from "dukascopy-node";
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
  volume?: number;
};

type RawDukascopyCandles = {
  timestamp: number;
  multiplier: number;
  open: number;
  high: number;
  low: number;
  close: number;
  shift: number;
  times: number[];
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes?: number[];
  error?: string;
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
      volume: value.volume,
    }))
    .filter((candle) => (
      Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close)
    ))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function mergeCandles(backfill: Candle[], latest: Candle[]) {
  const merged = [...backfill, ...latest]
    .reduce((map, candle) => map.set(candle.timestamp, candle), new Map<string, Candle>());
  return Array.from(merged.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function decimalScale(multiplier: number) {
  const text = multiplier.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  const decimals = text.split(".")[1];
  return decimals?.length ?? 0;
}

function formatRawPrice(units: number, multiplier: number) {
  return Number((units * multiplier).toFixed(decimalScale(multiplier)));
}

function normalizeRawCandles(data: RawDukascopyCandles): Candle[] {
  if (data.error) throw new Error(`Dukascopy direct feed error: ${data.error}`);
  if (!Array.isArray(data.times) || !data.times.length || !Number.isFinite(data.multiplier) || data.multiplier <= 0) {
    return [];
  }

  let timestamp = data.timestamp;
  let openUnits = Math.round(data.open / data.multiplier);
  let highUnits = Math.round(data.high / data.multiplier);
  let lowUnits = Math.round(data.low / data.multiplier);
  let closeUnits = Math.round(data.close / data.multiplier);

  return data.times.map((timeDelta, index) => {
    timestamp += timeDelta * data.shift;
    openUnits += data.opens[index];
    highUnits += data.highs[index];
    lowUnits += data.lows[index];
    closeUnits += data.closes[index];
    return {
      timestamp: new Date(timestamp).toISOString(),
      open: formatRawPrice(openUnits, data.multiplier),
      high: formatRawPrice(highUnits, data.multiplier),
      low: formatRawPrice(lowUnits, data.multiplier),
      close: formatRawPrice(closeUnits, data.multiplier),
      volume: data.volumes?.[index],
    };
  });
}

function bucketSize(timeframe: MarketTimeframe) {
  if (timeframe === "5m") return 5 * 60_000;
  if (timeframe === "15m") return 15 * 60_000;
  if (timeframe === "30m") return 30 * 60_000;
  if (timeframe === "1H") return 60 * 60_000;
  if (timeframe === "4H") return 4 * 60 * 60_000;
  return 24 * 60 * 60_000;
}

function aggregateCandles(candles: Candle[], timeframe: MarketTimeframe): Candle[] {
  const size = bucketSize(timeframe);
  const grouped = new Map<number, Candle[]>();
  candles.forEach((candle) => {
    const timestamp = new Date(candle.timestamp).getTime();
    const bucket = Math.floor(timestamp / size) * size;
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), candle]);
  });

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, items]) => ({
      timestamp: new Date(bucket).toISOString(),
      open: items[0].open,
      high: Math.max(...items.map((item) => item.high)),
      low: Math.min(...items.map((item) => item.low)),
      close: items.at(-1)!.close,
    }));
}

async function fetchDirectActiveCandles(timeframe: MarketTimeframe) {
  const source = timeframe === "1H" || timeframe === "4H" ? "hour" : timeframe === "1D" ? "day" : "minute";
  const from = Date.now() - bucketSize(timeframe) * 80;
  const url = new URL(`https://jetta.dukascopy.com/v1/candles/${source}/XAU-USD/BID`);
  url.searchParams.set("from", String(from));

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "GoldFramework/1.0",
    },
  });

  if (!response.ok) return [];
  const raw = await response.json() as RawDukascopyCandles;
  return aggregateCandles(normalizeRawCandles(raw), timeframe);
}

async function fetchFrame(timeframe: MarketTimeframe): Promise<TimeframeSeries> {
  const config = timeframeConfig[timeframe];
  const to = new Date();
  const from = new Date(Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000);
  const realTimeConfig: RealTimeRatesConfigJsonItem = {
    instrument: "xauusd",
    timeframe: config.dukascopyFrame,
    format: "json",
  };
  const [historicalValues, realTimeValues, directValues] = await Promise.all([
    getHistoricalRates({
      instrument: "xauusd",
      dates: { from, to },
      timeframe: config.dukascopyFrame,
      format: "json",
      ignoreFlats: true,
    }) as Promise<DukascopyCandle[]>,
    getRealTimeRates(realTimeConfig) as Promise<DukascopyCandle[]>,
    fetchDirectActiveCandles(timeframe),
  ]);

  const candles = mergeCandles(
    normalizeCandles(historicalValues),
    mergeCandles(normalizeCandles(realTimeValues), directValues),
  ).slice(-160);
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

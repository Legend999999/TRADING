import type { Candle, MarketDataResult, MarketSnapshot, MarketTimeframe, TimeframeSeries } from "./types";

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const BASE_URL = "https://api.twelvedata.com/time_series";
const CACHE_TTL_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 4;
const REQUIRED_FRAMES: MarketTimeframe[] = ["5m", "15m", "30m", "1H", "4H", "1D"];

const intervalByFrame: Record<MarketTimeframe, string> = {
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1H": "1h",
  "4H": "4h",
  "1D": "1day",
};

type CacheEntry = {
  expiresAt: number;
  snapshot: MarketSnapshot;
};

type TwelveDataValue = {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
};

type TwelveDataResponse = {
  status?: string;
  message?: string;
  values?: TwelveDataValue[];
};

let cache: CacheEntry | null = null;
let requestWindowStartedAt = 0;
let requestCount = 0;

function canUseQuota(now: number) {
  if (now - requestWindowStartedAt > RATE_WINDOW_MS) {
    requestWindowStartedAt = now;
    requestCount = 0;
  }
  if (requestCount >= MAX_REQUESTS_PER_WINDOW) return false;
  requestCount += 1;
  return true;
}

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCandles(values: TwelveDataValue[] | undefined): Candle[] {
  if (!values?.length) return [];
  const candles = values
    .map((value) => {
      const open = toNumber(value.open);
      const high = toNumber(value.high);
      const low = toNumber(value.low);
      const close = toNumber(value.close);
      if (open == null || high == null || low == null || close == null) return null;
      return {
        timestamp: new Date(`${value.datetime}Z`).toISOString(),
        open,
        high,
        low,
        close,
      };
    })
    .filter((candle): candle is Candle => candle != null)
    .reverse();

  return candles;
}

function marketStateFromDate(now: Date): MarketSnapshot["marketState"] {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return "CLOSED";
  return "OPEN";
}

async function fetchFrame(timeframe: MarketTimeframe): Promise<TimeframeSeries> {
  const url = new URL(BASE_URL);
  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", intervalByFrame[timeframe]);
  url.searchParams.set("outputsize", "160");
  url.searchParams.set("format", "JSON");

  const response = await fetch(url, {
    next: { revalidate: 60 },
    headers: {
      accept: "application/json",
      authorization: `apikey ${API_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Twelve Data returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as TwelveDataResponse;
  if (payload.status === "error") {
    throw new Error(payload.message || "Twelve Data returned an error");
  }

  const candles = normalizeCandles(payload.values);
  if (candles.length < 30) {
    throw new Error(`Twelve Data returned insufficient ${timeframe} candles`);
  }

  return {
    timeframe,
    candles,
    latestClosedAt: candles.at(-1)?.timestamp ?? null,
  };
}

export async function getTwelveDataSnapshot(force = false): Promise<MarketDataResult> {
  if (!API_KEY) {
    return {
      ok: false,
      error: {
        code: "MISSING_API_KEY",
        message: "TWELVE_DATA_API_KEY is not configured.",
      },
    };
  }

  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) {
    return { ok: true, snapshot: cache.snapshot, cache: "hit" };
  }

  if (!canUseQuota(now)) {
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
    const updatedAt = new Date().toISOString();
    const latestTimestamp = primary?.candles.at(-1)?.timestamp;
    const stale = latestTimestamp ? now - new Date(latestTimestamp).getTime() > 20 * 60_000 : true;

    const snapshot: MarketSnapshot = {
      symbol: "XAU/USD",
      provider: "Twelve Data",
      currentPrice,
      updatedAt,
      marketState: marketStateFromDate(new Date()),
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
        message: error instanceof Error ? error.message : "Market-data provider failed.",
      },
    };
  }
}

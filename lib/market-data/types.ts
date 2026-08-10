export type MarketTimeframe = "5m" | "15m" | "30m" | "1H" | "4H" | "1D";

export type Candle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TimeframeSeries = {
  timeframe: MarketTimeframe;
  candles: Candle[];
  latestClosedAt: string | null;
};

export type MarketSnapshot = {
  symbol: "XAU/USD";
  provider: string;
  currentPrice: number | null;
  updatedAt: string;
  marketState: "OPEN" | "CLOSED" | "UNKNOWN";
  stale: boolean;
  series: TimeframeSeries[];
};

export type MarketDataError = {
  code: "MISSING_API_KEY" | "RATE_LIMITED" | "PROVIDER_ERROR" | "INVALID_DATA";
  message: string;
};

export type MarketDataResult =
  | { ok: true; snapshot: MarketSnapshot; cache: "hit" | "miss" }
  | { ok: false; error: MarketDataError };


import type { Candle, MarketTimeframe } from "../market-data/types";

export type PivotKind = "high" | "low";

export type Pivot = {
  kind: PivotKind;
  price: number;
  timestamp: string;
  index: number;
  timeframe: MarketTimeframe;
  strength: "minor" | "major";
};

export type MarketStructure = "HH" | "HL" | "LH" | "LL" | "MIXED";

export type GannLevel = {
  degree: number;
  price: number;
};

export type SetupStatus =
  | "SCANNING"
  | "NO SETUP"
  | "PRICE NEAR"
  | "PENDING CONFIRMATION"
  | "VALID BUY SETUP"
  | "VALID SELL SETUP"
  | "MARKET CLOSED"
  | "DATA ERROR";

export type ProximityState = "far" | "approaching" | "in-zone";

export type GannSetupResult = {
  id: string;
  status: SetupStatus;
  direction: "BUY" | "SELL" | "NONE";
  symbol: "XAU/USD";
  currentPrice: number | null;
  dataTimestamp: string;
  anchorPivot: Pivot | null;
  supportingTimeframes: MarketTimeframe[];
  entryZone: [number, number] | null;
  stopLoss: number | null;
  targets: [number, number, number] | null;
  riskReward: [number, number, number] | null;
  invalidationLevel: number | null;
  distanceToEntry: number | null;
  proximityState: ProximityState;
  score: number;
  ruleBreakdown: string[];
  gannLevels: GannLevel[];
  timeCycle: {
    barsElapsed: number;
    cycleLength: number;
    barsToWindow: number;
    active: boolean;
  } | null;
  reasons: string[];
  marketStructure: MarketStructure;
  atr: number | null;
  marketOpen: boolean;
};

export type TimeframeAnalysis = {
  timeframe: MarketTimeframe;
  candles: Candle[];
  pivots: Pivot[];
  latestPivot: Pivot | null;
  structure: MarketStructure;
  atr: number | null;
};


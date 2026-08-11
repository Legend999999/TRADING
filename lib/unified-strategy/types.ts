import type { MarketTimeframe } from "../market-data/types";

export type UnifiedDirection = "BUY" | "SELL" | "NONE";

export type UnifiedStatus =
  | "SCANNING"
  | "NO TRADE"
  | "PRICE NEAR"
  | "PENDING"
  | "VALID BUY"
  | "VALID SELL"
  | "DATA ERROR"
  | "MARKET CLOSED";

export type UnifiedLifecycle =
  | "SEARCHING"
  | "LIQUIDITY_FOUND"
  | "SWEPT"
  | "BOS_CONFIRMED"
  | "RETEST_PENDING"
  | "RETEST_ACTIVE"
  | "CONFIRMATION_PENDING"
  | "READY"
  | "FILLED"
  | "INVALIDATED"
  | "EXPIRED";

export type UnifiedConditionName =
  | "marketStructure"
  | "supertrend"
  | "supportResistance"
  | "liquidity"
  | "liquiditySweep"
  | "bos"
  | "displacement"
  | "fvg"
  | "retest"
  | "confirmation";

export type UnifiedCondition = {
  key: UnifiedConditionName;
  label: string;
  state: "CONFIRMED" | "WAITING" | "MISSING" | "CONFLICT" | "OPTIONAL";
  detail: string;
};

export type PriceZone = {
  kind: "support" | "resistance" | "fvg" | "liquidity" | "bos";
  direction?: "bullish" | "bearish";
  low: number;
  high: number;
  level: number;
  strength: number;
  touches: number;
  timeframe: MarketTimeframe;
  createdAt: string;
};

export type UnifiedStrategyResult = {
  id: string;
  strategy: "Unified Strategy";
  status: UnifiedStatus;
  lifecycle: UnifiedLifecycle;
  decision: "BUY" | "SELL" | "NO TRADE";
  direction: UnifiedDirection;
  instruction: string;
  htfBias: "BULLISH" | "BEARISH" | "MIXED";
  marketStructure: string;
  supertrend: "BULLISH" | "BEARISH" | "UNKNOWN";
  supportZones: PriceZone[];
  resistanceZones: PriceZone[];
  liquidityPools: PriceZone[];
  liquiditySweep: PriceZone | null;
  bos: PriceZone | null;
  displacement: {
    confirmed: boolean;
    candleTimestamp: string | null;
    rangeToAtr: number | null;
  };
  fvg: PriceZone | null;
  retestZone: PriceZone | null;
  confirmation: {
    confirmed: boolean;
    candleTimestamp: string | null;
    detail: string;
  };
  entryZone: [number, number] | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  invalidationLevel: number | null;
  setupQuality: {
    confirmed: number;
    total: number;
    items: UnifiedCondition[];
  };
  reasonsFor: string[];
  reasonsAgainst: string[];
  dataTimestamp: string;
  candleTimeframe: MarketTimeframe | null;
  currentPrice: number | null;
  atr: number | null;
};

export type UnifiedStrategyConfig = {
  biasFrames: MarketTimeframe[];
  setupFrame: MarketTimeframe;
  confirmationFrame: MarketTimeframe;
  pivotWing: number;
  supertrendAtrLength: number;
  supertrendMultiplier: number;
  liquidityToleranceAtr: number;
  zoneToleranceAtr: number;
  sweepLookback: number;
  maxBarsSweepToBos: number;
  maxBarsBosToRetest: number;
  displacementAtr: number;
  confirmationBodyAtr: number;
  requireFvg: boolean;
};

export type BacktestTrade = {
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: string;
  closedAt: string | null;
  result: "WIN" | "LOSS" | "OPEN";
  r: number;
  lifecycle: UnifiedLifecycle;
};

export type BacktestSummary = {
  setups: number;
  wins: number;
  losses: number;
  winRate: number;
  averageR: number;
  expectancy: number;
  maxDrawdownR: number;
  buySetups: number;
  sellSetups: number;
  trades: BacktestTrade[];
};

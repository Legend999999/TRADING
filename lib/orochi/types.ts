import type { MarketTimeframe } from "../market-data/types";

export type OrochiStatus =
  | "SCANNING"
  | "NO SETUP"
  | "PRICE NEAR"
  | "PENDING"
  | "VALID BUY"
  | "VALID SELL"
  | "DATA ERROR"
  | "MARKET CLOSED";

export type OrochiDecision = "BUY" | "SELL" | "NO TRADE";
export type AuctionCondition = "Balance" | "Imbalance" | "Transition";

export type OrochiResult = {
  id: string;
  strategy: "Orochi Auction Framework";
  status: OrochiStatus;
  decision: OrochiDecision;
  direction: "BUY" | "SELL" | "NONE";
  frameworkSetup: string;
  marketCondition: AuctionCondition;
  entryType: "Limit" | "Confirmation" | "Market" | "None";
  entryZone: [number, number] | null;
  stopLoss: number | null;
  targets: [number, number, number] | null;
  riskReward: [number, number, number] | null;
  invalidationLevel: number | null;
  confidence: number;
  score: number;
  structure: string;
  confluences: string[];
  auctionEvidence: string[];
  orderFlowEvidence: string[];
  missingInformation: string[];
  newsRisk: string;
  dataTimestamp: string;
  candleTimeframe: MarketTimeframe;
  valueArea: {
    vah: number;
    val: number;
    poc: number;
    vwap: number;
    upperBand: number;
    lowerBand: number;
  } | null;
};

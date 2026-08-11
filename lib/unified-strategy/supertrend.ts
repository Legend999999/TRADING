import type { Candle } from "../market-data/types";
import { calculateAtr } from "../gann/engine";

export type SupertrendPoint = {
  timestamp: string;
  upperBand: number;
  lowerBand: number;
  value: number;
  direction: "BULLISH" | "BEARISH";
};

export function calculateSupertrend(candles: Candle[], atrLength = 10, multiplier = 3): SupertrendPoint[] {
  if (candles.length < atrLength + 2) return [];

  const points: SupertrendPoint[] = [];
  let previousUpper = 0;
  let previousLower = 0;
  let previousDirection: "BULLISH" | "BEARISH" = "BEARISH";
  let previousValue = 0;

  for (let index = atrLength; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const atr = calculateAtr(candles.slice(0, index + 1), atrLength);
    if (!atr) continue;

    const hl2 = (candle.high + candle.low) / 2;
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;
    const upperBand = points.length === 0 || basicUpper < previousUpper || previous.close > previousUpper ? basicUpper : previousUpper;
    const lowerBand = points.length === 0 || basicLower > previousLower || previous.close < previousLower ? basicLower : previousLower;
    const direction = points.length === 0
      ? "BEARISH"
      : previousValue === previousUpper
        ? candle.close > upperBand ? "BULLISH" : "BEARISH"
        : candle.close < lowerBand ? "BEARISH" : "BULLISH";
    const value = direction === "BULLISH" ? lowerBand : upperBand;

    previousUpper = upperBand;
    previousLower = lowerBand;
    previousDirection = direction;
    previousValue = value;
    points.push({
      timestamp: candle.timestamp,
      upperBand,
      lowerBand,
      value,
      direction: previousDirection,
    });
  }

  return points;
}

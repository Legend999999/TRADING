import { NextResponse } from "next/server";
import { buildGannSetup } from "../../../../lib/gann/engine";
import { getFreeXauUsdSnapshot } from "../../../../lib/market-data/dukascopy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const force = searchParams.get("refresh") === "1";
  const result = await getFreeXauUsdSnapshot(force);

  if (!result.ok) {
    return NextResponse.json(
      {
        provider: "Dukascopy Free Data Feed",
        status: "DATA ERROR",
        error: result.error.message,
        dataTimestamp: new Date().toISOString(),
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const setup = buildGannSetup(result.snapshot);
  return NextResponse.json(
    {
      provider: result.snapshot.provider,
      cache: result.cache,
      market: {
        symbol: result.snapshot.symbol,
        currentPrice: result.snapshot.currentPrice,
        updatedAt: result.snapshot.updatedAt,
        state: result.snapshot.marketState,
        stale: result.snapshot.stale,
        timeframes: result.snapshot.series.map((item) => ({
          timeframe: item.timeframe,
          candles: item.candles.length,
          latestClosedAt: item.latestClosedAt,
        })),
      },
      setup,
    },
    {
      headers: {
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
      },
    },
  );
}

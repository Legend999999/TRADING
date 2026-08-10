import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the Gold Framework trading UI source intact", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const dukascopy = await readFile(new URL("../lib/market-data/dukascopy.ts", import.meta.url), "utf8");
  const orochi = await readFile(new URL("../lib/orochi/engine.ts", import.meta.url), "utf8");

  assert.match(page, /OANDA:XAUUSD/);
  assert.match(page, /GANN Workbench/);
  assert.match(page, /Square 9/);
  assert.match(page, /Auto Setup/);
  assert.match(page, /Strategy Setup Center/);
  assert.match(page, /Orochi/);
  assert.match(page, /free spot XAU\/USD OHLC candles/);
  assert.match(page, /Manual \/ Research calculator/);
  assert.match(page, /BUY LIMIT|SELL LIMIT/);
  assert.match(styles, /\.gann-panel/);
  assert.match(styles, /\.timeframe-bar/);
  assert.match(styles, /\.strategy-center-button/);
  assert.match(dukascopy, /instrument: "xauusd"/);
  assert.match(dukascopy, /Dukascopy Free Data Feed/);
  assert.doesNotMatch(dukascopy, /process\.env/);
  assert.doesNotMatch(dukascopy, /apikey|authorization/i);
  assert.match(orochi, /Orochi Auction Framework/);
  assert.match(orochi, /NO TRADE/);
  assert.match(orochi, /CVD \/ footprint delta/);
});

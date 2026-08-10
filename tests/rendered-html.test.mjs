import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the Gold Framework trading UI source intact", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /OANDA:XAUUSD/);
  assert.match(page, /GANN Workbench/);
  assert.match(page, /Square 9/);
  assert.match(page, /Auto Setup/);
  assert.match(page, /TWELVE_DATA_API_KEY/);
  assert.match(page, /Manual \/ Research calculator/);
  assert.match(page, /BUY LIMIT|SELL LIMIT/);
  assert.match(styles, /\.gann-panel/);
  assert.match(styles, /\.timeframe-bar/);
});

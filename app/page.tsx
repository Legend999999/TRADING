"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const timeframes = [
  { label: "1m", value: "1" }, { label: "3m", value: "3" },
  { label: "5m", value: "5" }, { label: "15m", value: "15" },
  { label: "30m", value: "30" }, { label: "45m", value: "45" },
  { label: "1H", value: "60" }, { label: "2H", value: "120" },
  { label: "3H", value: "180" }, { label: "4H", value: "240" },
  { label: "1D", value: "D" }, { label: "1W", value: "W" },
  { label: "1M", value: "M" },
];

const degrees = [45, 90, 135, 180, 225, 270, 315, 360];

type Setup = {
  side: "BUY LIMIT" | "SELL LIMIT";
  entry: number;
  stop: number;
  targets: number[];
  nearestDegree: number;
  timeBars: number;
  nextWindow: number;
  score: number;
  rules: string[];
};

type AutoStatus =
  | "SCANNING"
  | "NO SETUP"
  | "PRICE NEAR"
  | "PENDING CONFIRMATION"
  | "VALID BUY SETUP"
  | "VALID SELL SETUP"
  | "MARKET CLOSED"
  | "DATA ERROR";

type AutoSetup = {
  id: string;
  status: AutoStatus;
  direction: "BUY" | "SELL" | "NONE";
  currentPrice: number | null;
  dataTimestamp: string;
  anchorPivot: { kind: "high" | "low"; price: number; timestamp: string; timeframe: string; strength: string } | null;
  supportingTimeframes: string[];
  entryZone: [number, number] | null;
  stopLoss: number | null;
  targets: [number, number, number] | null;
  riskReward: [number, number, number] | null;
  invalidationLevel: number | null;
  distanceToEntry: number | null;
  proximityState: string;
  score: number;
  ruleBreakdown: string[];
  gannLevels: { degree: number; price: number }[];
  timeCycle: { barsElapsed: number; cycleLength: number; barsToWindow: number; active: boolean } | null;
  reasons: string[];
  marketStructure: string;
  atr: number | null;
  marketOpen: boolean;
};

type AutoScanPayload = {
  provider?: string;
  cache?: string;
  status?: AutoStatus;
  error?: string;
  market?: {
    currentPrice: number | null;
    updatedAt: string;
    state: string;
    stale: boolean;
    timeframes: { timeframe: string; candles: number; latestClosedAt: string | null }[];
  };
  setup?: AutoSetup;
  dataTimestamp?: string;
};

function priceLevel(pivot: number, degree: number, direction: 1 | -1) {
  const root = Math.sqrt(pivot);
  const moved = root + direction * (degree / 180);
  return Math.max(0, moved * moved);
}

function fmt(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusTone(status: AutoStatus | "IDLE") {
  if (status === "SCANNING") return "scanning";
  if (status === "PRICE NEAR") return "near";
  if (status === "PENDING CONFIRMATION") return "pending";
  if (status === "VALID BUY SETUP") return "buy";
  if (status === "VALID SELL SETUP") return "sell";
  if (status === "DATA ERROR") return "error";
  return "idle";
}

function shortTime(value?: string | null) {
  if (!value) return "No data";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function TradingViewChart({ interval }: { interval: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    host.innerHTML = "";

    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.text = JSON.stringify({
      autosize: true,
      symbol: "OANDA:XAUUSD",
      interval,
      timezone: "Asia/Baghdad",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "rgba(7, 9, 12, 1)",
      gridColor: "rgba(255, 255, 255, 0.045)",
      allow_symbol_change: false,
      calendar: false,
      details: false,
      hide_side_toolbar: false,
      hide_top_toolbar: false,
      save_image: true,
      withdateranges: true,
      support_host: "https://www.tradingview.com",
    });

    host.appendChild(widget);
    host.appendChild(script);
    return () => { host.innerHTML = ""; };
  }, [interval]);

  return (
    <div className="chart-stage">
      <div className="chart-loading" aria-hidden="true">
        <span className="loading-mark">AU</span><p>Loading gold market…</p>
      </div>
      <div ref={container} className="tradingview-widget-container" aria-label="Live XAU/USD chart with Gann drawing tools" />
    </div>
  );
}

function GannWorkbench({
  activeFrame,
  scanNonce,
  onAutoResult,
}: {
  activeFrame: string;
  scanNonce: number;
  onAutoResult: (setup: AutoSetup | null, status: AutoStatus | "IDLE", summary: string) => void;
}) {
  const [tab, setTab] = useState<"setup" | "levels" | "rules">("setup");
  const [pivotType, setPivotType] = useState<"low" | "high">("low");
  const [pivotInput, setPivotInput] = useState("");
  const [currentInput, setCurrentInput] = useState("");
  const [barsInput, setBarsInput] = useState("");
  const [bufferInput, setBufferInput] = useState("3");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [message, setMessage] = useState("Enter a confirmed pivot and current price.");
  const [autoSetup, setAutoSetup] = useState<AutoSetup | null>(null);
  const [marketMeta, setMarketMeta] = useState<AutoScanPayload["market"] | null>(null);
  const [autoStatus, setAutoStatus] = useState<AutoStatus | "IDLE">("IDLE");
  const [scanProgress, setScanProgress] = useState("Idle");
  const [scanError, setScanError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const lastNotificationId = useRef("");

  const pivot = Number(pivotInput);
  const current = Number(currentInput);
  const bars = Math.max(0, Number(barsInput) || 0);
  const buffer = Math.max(0.1, Number(bufferInput) || 3);

  const calculatedLevels = useMemo(() => {
    if (!pivot || pivot <= 0) return [];
    const direction = pivotType === "low" ? 1 : -1;
    return degrees.map((degree) => ({ degree, price: priceLevel(pivot, degree, direction) }));
  }, [pivot, pivotType]);

  const scanMarket = useCallback(async (force = false) => {
    setTab("setup");
    setAutoStatus("SCANNING");
    setScanProgress("Scanning 5m, 15m, 30m, 1H, 4H and 1D closed candles...");
    setScanError("");
    onAutoResult(null, "SCANNING", "Scanning market data");

    try {
      const response = await fetch(`/api/market/scan${force ? "?refresh=1" : ""}`, { cache: "no-store" });
      const payload = (await response.json()) as AutoScanPayload;
      if (!response.ok || !payload.setup) {
        const timestamp = payload.dataTimestamp ?? new Date().toISOString();
        const dataError: AutoSetup = {
          id: `XAU/USD:DATA ERROR:${timestamp}`,
          status: "DATA ERROR",
          direction: "NONE",
          currentPrice: null,
          dataTimestamp: timestamp,
          anchorPivot: null,
          supportingTimeframes: [],
          entryZone: null,
          stopLoss: null,
          targets: null,
          riskReward: null,
          invalidationLevel: null,
          distanceToEntry: null,
          proximityState: "far",
          score: 0,
          ruleBreakdown: [],
          gannLevels: [],
          timeCycle: null,
          reasons: [payload.error ?? "Market data is unavailable."],
          marketStructure: "MIXED",
          atr: null,
          marketOpen: false,
        };
        setAutoSetup(dataError);
        setAutoStatus("DATA ERROR");
        setScanError(payload.error ?? "Market data is unavailable.");
        setScanProgress("Data unavailable");
        onAutoResult(dataError, "DATA ERROR", "DATA ERROR");
        return;
      }

      setAutoSetup(payload.setup);
      setAutoStatus(payload.setup.status);
      setMarketMeta(payload.market ?? null);
      setScanProgress(`Updated ${shortTime(payload.market?.updatedAt ?? payload.setup.dataTimestamp)}`);
      onAutoResult(payload.setup, payload.setup.status, `${payload.setup.status} · ${payload.setup.direction}`);
    } catch {
      setAutoStatus("DATA ERROR");
      setScanError("Market scan failed before data could be validated.");
      setScanProgress("Data unavailable");
      onAutoResult(null, "DATA ERROR", "DATA ERROR");
    }
  }, [onAutoResult]);

  useEffect(() => {
    if (scanNonce <= 0) return;
    const timer = window.setTimeout(() => void scanMarket(true), 0);
    return () => window.clearTimeout(timer);
  }, [scanMarket, scanNonce]);

  useEffect(() => {
    if (!autoSetup) return;
    if (!["PRICE NEAR", "PENDING CONFIRMATION", "VALID BUY SETUP", "VALID SELL SETUP"].includes(autoSetup.status)) return;
    if (lastNotificationId.current === autoSetup.id) return;
    lastNotificationId.current = autoSetup.id;
  }, [autoSetup]);

  const generateSetup = () => {
    if (!pivot || !current || pivot <= 0 || current <= 0) {
      setSetup(null);
      setMessage("Add valid pivot and current prices first.");
      return;
    }
    if ((pivotType === "low" && current <= pivot) || (pivotType === "high" && current >= pivot)) {
      setSetup(null);
      setMessage(`No setup: price has not confirmed away from the pivot ${pivotType}.`);
      return;
    }

    const direction = pivotType === "low" ? 1 : -1;
    const raw = degrees.map((degree) => ({ degree, price: priceLevel(pivot, degree, direction) }));
    const ordered = raw.sort((a, b) => a.price - b.price);
    let entryIndex: number;

    if (pivotType === "low") {
      entryIndex = ordered.findLastIndex((level) => level.price <= current);
      entryIndex = Math.max(0, Math.min(entryIndex, ordered.length - 4));
    } else {
      entryIndex = ordered.findIndex((level) => level.price >= current);
      entryIndex = Math.max(3, entryIndex < 0 ? ordered.length - 1 : entryIndex);
    }

    const entryLevel = ordered[entryIndex];
    const side = pivotType === "low" ? "BUY LIMIT" : "SELL LIMIT";
    const stop = pivotType === "low"
      ? Math.max(0, (ordered[entryIndex - 1]?.price ?? pivot) - buffer)
      : (ordered[entryIndex + 1]?.price ?? pivot) + buffer;
    const targets = pivotType === "low"
      ? [1, 2, 3].map((step) => ordered[entryIndex + step].price)
      : [1, 2, 3].map((step) => ordered[entryIndex - step].price);

    const timeBars = Math.max(1, Math.round(Math.sqrt(pivot)));
    const remainder = bars % timeBars;
    const nextWindow = remainder === 0 && bars > 0 ? 0 : timeBars - remainder;
    const proximity = Math.abs(current - entryLevel.price) / current;
    const timeConfluence = nextWindow <= 2 || nextWindow >= timeBars - 2;
    const score = Math.min(88, 58 + (proximity < 0.003 ? 12 : 4) + (timeConfluence ? 10 : 0) + (entryLevel.degree % 90 === 0 ? 8 : 3));

    setSetup({
      side,
      entry: entryLevel.price,
      stop,
      targets,
      nearestDegree: entryLevel.degree,
      timeBars,
      nextWindow,
      score,
      rules: [
        `${entryLevel.degree}° Square-of-Nine level from confirmed pivot ${pivotType}`,
        pivotType === "low" ? "Price remains above the anchor low" : "Price remains below the anchor high",
        timeConfluence ? "Price/time window is within two bars" : `Next time-square window in ${nextWindow} bars`,
        "Order protected beyond the adjacent Gann level",
      ],
    });
    setMessage("");
  };

  return (
    <aside className="gann-panel" aria-label="Gann rules workbench">
      <div className="gann-head">
        <div><span>RULES ENGINE</span><strong>GANN Workbench</strong></div>
        <span className="books-badge">12 books</span>
      </div>

      <div className="gann-tabs" role="tablist" aria-label="Gann tools">
        {(["setup", "levels", "rules"] as const).map((item) => (
          <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "setup" ? "Setup" : item === "levels" ? "Square 9" : "Rules"}
          </button>
        ))}
      </div>

      <div className="gann-scroll">
        {tab === "setup" && (
          <div className="setup-pane">
            <div className="engine-note"><span>◆</span><p>Deterministic calculation from your Gann rulebooks. It does not guess direction.</p></div>

            <div className="auto-status-card">
              <div className="auto-status-head">
                <div>
                  <span>AUTO SETUP</span>
                  <strong className={`auto-status-text ${statusTone(autoStatus)}`}>{autoStatus === "IDLE" ? "READY" : autoStatus}</strong>
                </div>
                <span className={`auto-dot ${statusTone(autoStatus)}`} />
              </div>
              <div className="market-data-grid">
                <div><span>PRICE</span><strong>{autoSetup?.currentPrice ? fmt(autoSetup.currentPrice) : autoStatus === "IDLE" ? "No data" : "DATA ERROR"}</strong></div>
                <div><span>UPDATED</span><strong>{shortTime(marketMeta?.updatedAt ?? autoSetup?.dataTimestamp)}</strong></div>
                <div><span>MARKET</span><strong>{marketMeta?.state ?? (autoSetup?.marketOpen ? "OPEN" : "UNKNOWN")}</strong></div>
                <div><span>SCAN</span><strong>{marketMeta?.stale ? "STALE DATA" : scanProgress}</strong></div>
              </div>
              {scanError && <p className="data-error">DATA ERROR: {scanError}</p>}
              <button className="generate-button" type="button" onClick={() => void scanMarket(true)} disabled={autoStatus === "SCANNING"}>
                {autoStatus === "SCANNING" ? "Scanning market data" : "Refresh automatic scan"} <span>→</span>
              </button>
            </div>

            {!autoSetup && autoStatus !== "SCANNING" && (
              <div className="empty-result">
                <span className="compass">◇</span>
                <strong>Automatic scanner ready</strong>
                <p>Press Auto Setup on the chart or refresh here after TWELVE_DATA_API_KEY is configured.</p>
              </div>
            )}

            {autoSetup && (
              <div className="setup-result auto-result">
                <div className="result-head">
                  <div><span>LIVE RULE STATUS</span><strong className={autoSetup.direction === "BUY" ? "buy-text" : autoSetup.direction === "SELL" ? "sell-text" : ""}>{autoSetup.status}</strong></div>
                  <div className="score"><strong>{autoSetup.score}</strong><span>/100</span></div>
                </div>
                {autoSetup.status === "DATA ERROR" ? (
                  <p className="setup-warning">DATA ERROR. Live provider data is unavailable, so no trade setup is generated.</p>
                ) : (
                  <>
                    <div className="order-grid">
                      <div><span>DIRECTION</span><strong>{autoSetup.direction}</strong></div>
                      <div><span>CURRENT</span><strong>{autoSetup.currentPrice ? fmt(autoSetup.currentPrice) : "DATA ERROR"}</strong></div>
                      <div><span>ENTRY ZONE</span><strong>{autoSetup.entryZone ? `${fmt(autoSetup.entryZone[0])} - ${fmt(autoSetup.entryZone[1])}` : "NO SETUP"}</strong></div>
                      <div><span>STOP LOSS</span><strong className="sell-text">{autoSetup.stopLoss ? fmt(autoSetup.stopLoss) : "NO SETUP"}</strong></div>
                      {autoSetup.targets?.map((target, index) => <div key={target}><span>TP {index + 1} / RR {autoSetup.riskReward?.[index] ?? "-"}</span><strong className="buy-text">{fmt(target)}</strong></div>)}
                      <div><span>INVALIDATION</span><strong>{autoSetup.invalidationLevel ? fmt(autoSetup.invalidationLevel) : "NO SETUP"}</strong></div>
                      <div><span>DISTANCE</span><strong>{autoSetup.distanceToEntry != null ? fmt(autoSetup.distanceToEntry) : "NO SETUP"}</strong></div>
                    </div>
                    <div className="time-window">
                      <span>TIME CYCLE</span>
                      <strong>{autoSetup.timeCycle ? `${autoSetup.timeCycle.barsElapsed}/${autoSetup.timeCycle.cycleLength} bars` : "NO SETUP"}</strong>
                      <p>{autoSetup.timeCycle?.active ? "Cycle window is active now" : autoSetup.timeCycle ? `Next window in ${autoSetup.timeCycle.barsToWindow} bars` : "Waiting for enough confirmed candles."}</p>
                    </div>
                    <div className="auto-meta">
                      <span>ANCHOR</span>
                      <strong>{autoSetup.anchorPivot ? `${autoSetup.anchorPivot.strength} ${autoSetup.anchorPivot.kind} ${fmt(autoSetup.anchorPivot.price)} on ${autoSetup.anchorPivot.timeframe}` : "No confirmed pivot"}</strong>
                      <p>{autoSetup.marketStructure} structure / ATR {autoSetup.atr ? fmt(autoSetup.atr) : "n/a"} / {autoSetup.proximityState} / TFs {autoSetup.supportingTimeframes.length ? autoSetup.supportingTimeframes.join(", ") : "none"}</p>
                    </div>
                    <div className="compact-levels">
                      {autoSetup.gannLevels.map((level) => <div key={level.degree}><span>{level.degree}°</span><strong>{fmt(level.price)}</strong></div>)}
                    </div>
                    <ul className="rule-checks">{[...autoSetup.reasons, ...autoSetup.ruleBreakdown].map((rule) => <li key={rule}><span>✓</span>{rule}</li>)}</ul>
                    <p className="setup-warning">Rule-based planning only. Confirm structure and closing price before placing any order.</p>
                  </>
                )}
              </div>
            )}

            <details className="manual-research" open={manualOpen} onToggle={(event) => setManualOpen(event.currentTarget.open)}>
            <summary>Manual / Research calculator</summary>
            <label className="field-label">CONFIRMED PIVOT</label>
            <div className="segmented">
              <button type="button" className={pivotType === "low" ? "active buy" : ""} onClick={() => { setPivotType("low"); setSetup(null); }}>Pivot low</button>
              <button type="button" className={pivotType === "high" ? "active sell" : ""} onClick={() => { setPivotType("high"); setSetup(null); }}>Pivot high</button>
            </div>

            <div className="input-grid">
              <label>Pivot price<input inputMode="decimal" value={pivotInput} onChange={(event) => setPivotInput(event.target.value)} placeholder="e.g. 4280.00" /></label>
              <label>Current price<input inputMode="decimal" value={currentInput} onChange={(event) => setCurrentInput(event.target.value)} placeholder="from chart" /></label>
              <label>Bars since pivot<input inputMode="numeric" value={barsInput} onChange={(event) => setBarsInput(event.target.value)} placeholder="e.g. 42" /></label>
              <label>Stop buffer<input inputMode="decimal" value={bufferInput} onChange={(event) => setBufferInput(event.target.value)} /></label>
            </div>

            <div className="context-row"><span>MARKET</span><strong>XAU/USD · {activeFrame}</strong></div>
            <button className="generate-button" type="button" onClick={generateSetup}>Calculate Gann setup <span>→</span></button>

            {!setup && <div className="empty-result"><span className="compass">✦</span><strong>Waiting for confluence</strong><p>{message}</p></div>}

            {setup && (
              <div className="setup-result">
                <div className="result-head">
                  <div><span>RULE-BASED PLAN</span><strong className={setup.side.startsWith("BUY") ? "buy-text" : "sell-text"}>{setup.side}</strong></div>
                  <div className="score"><strong>{setup.score}</strong><span>/100</span></div>
                </div>
                <div className="order-grid">
                  <div><span>ENTRY · {setup.nearestDegree}°</span><strong>{fmt(setup.entry)}</strong></div>
                  <div><span>STOP LOSS</span><strong className="sell-text">{fmt(setup.stop)}</strong></div>
                  {setup.targets.map((target, index) => <div key={target}><span>TP {index + 1}</span><strong className="buy-text">{fmt(target)}</strong></div>)}
                </div>
                <div className="time-window"><span>TIME SQUARE</span><strong>{setup.timeBars} bars</strong><p>{setup.nextWindow === 0 ? "Cycle window is active now" : `Next window in ${setup.nextWindow} bars`}</p></div>
                <ul className="rule-checks">{setup.rules.map((rule) => <li key={rule}><span>✓</span>{rule}</li>)}</ul>
                <p className="setup-warning">Planning calculation only. Confirm structure and closing price before placing any order.</p>
              </div>
            )}
            </details>
          </div>
        )}

        {tab === "levels" && (
          <div className="levels-pane">
            <p className="pane-intro">Levels use (√price ± degree/180)² from the selected pivot.</p>
            {!pivot || pivot <= 0 ? <div className="empty-result compact"><span className="compass">⌗</span><strong>Add a pivot price</strong><p>Return to Setup and enter the confirmed swing point.</p></div> : (
              <div className="levels-list">
                <div className="level-row anchor"><span>ANCHOR</span><strong>{fmt(pivot)}</strong></div>
                {calculatedLevels.map((level) => <div className="level-row" key={level.degree}><span>{level.degree}°</span><strong>{fmt(level.price)}</strong><small>{level.degree % 90 === 0 ? "major" : "minor"}</small></div>)}
              </div>
            )}
            <div className="formula-card"><span>CORE FACTORS</span><p>45° = 0.25 · 90° = 0.50 · 180° = 1.00 · 360° = 2.00</p></div>
          </div>
        )}

        {tab === "rules" && (
          <div className="rules-pane">
            <p className="pane-intro">The engine only releases a plan after these checks.</p>
            {[
              ["01", "Pivot first", "Anchor from a confirmed extreme high/low, never a random candle."],
              ["02", "45° and 90°", "Use Square-of-Nine rotations as reaction zones, not exact guarantees."],
              ["03", "Closing confirmation", "A close above an old high or below an old low carries more weight."],
              ["04", "1×1 trend rule", "Above the rising 1×1 is strength; below the falling 1×1 is weakness."],
              ["05", "Price × time", "Watch √pivot bar intervals and confluence within one or two bars."],
              ["06", "Protect capital", "Place the stop with the trade beyond structure; never average a loss."],
            ].map(([number, title, body]) => <article className="rule-card" key={number}><span>{number}</span><div><strong>{title}</strong><p>{body}</p></div></article>)}
            <div className="source-card"><span>KNOWLEDGE BASE</span><strong>12 Gann references loaded</strong><p>Master course · Basis of Forecasting · Square of Nine · Overnight Chart · calculators and unpublished material</p></div>
          </div>
        )}
      </div>
    </aside>
  );
}

export default function Home() {
  const [interval, setIntervalValue] = useState("60");
  const [scanNonce, setScanNonce] = useState(0);
  const [autoStatus, setHomeAutoStatus] = useState<AutoStatus | "IDLE">("IDLE");
  const [autoSummary, setAutoSummary] = useState("Automatic scan ready");
  const [notice, setNotice] = useState("");
  const workspace = useRef<HTMLElement>(null);
  const notifiedSetup = useRef("");
  const activeFrame = timeframes.find((timeframe) => timeframe.value === interval)?.label ?? "1H";

  const handleAutoResult = useCallback((setup: AutoSetup | null, status: AutoStatus | "IDLE", summary: string) => {
    setHomeAutoStatus(status);
    setAutoSummary(summary);
    if (!setup || !["PRICE NEAR", "PENDING CONFIRMATION", "VALID BUY SETUP", "VALID SELL SETUP"].includes(setup.status)) return;
    if (notifiedSetup.current === setup.id) return;
    notifiedSetup.current = setup.id;
    const message = `${setup.status} on XAU/USD${setup.entryZone ? ` near ${fmt(setup.entryZone[0])}-${fmt(setup.entryZone[1])}` : ""}`;
    setNotice(message);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Gold Framework Auto Setup", { body: message });
    }
  }, []);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) await workspace.current?.requestFullscreen();
    else await document.exitFullscreen();
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Gold Framework"><span className="brand-mark">GF</span><span className="brand-name">Gold Framework</span></div>
        <div className="market-identity"><span className="asset-badge">Au</span><div><div className="symbol-line"><strong>XAU/USD</strong><span>Gold Spot</span></div><p>Gold / U.S. Dollar</p></div></div>
        <button className="fullscreen-button" onClick={toggleFullscreen} type="button"><span className="fullscreen-icon" aria-hidden="true">↗</span><span>Fullscreen</span></button>
      </header>

      <section className="workspace" ref={workspace}>
        <div className="timeframe-bar" aria-label="Chart timeframe">
          <div className="timeframe-label"><span>TIMEFRAME</span><strong>{activeFrame}</strong></div>
          <div className="timeframe-scroll">{timeframes.map((timeframe) => <button key={timeframe.value} type="button" className={interval === timeframe.value ? "active" : ""} aria-pressed={interval === timeframe.value} onClick={() => setIntervalValue(timeframe.value)}>{timeframe.label}</button>)}</div>
          <div className="gann-live"><span>◆</span> GANN RULES ACTIVE</div>
        </div>
        <div className="chart-card">
          <button className="auto-setup-button" type="button" onClick={() => setScanNonce((value) => value + 1)} aria-label="Run automatic Gann setup scan">
            <span className={`auto-dot ${statusTone(autoStatus)}`} />
            <span className="gann-icon">◇</span>
            <span>Auto Setup</span>
            <small>{autoSummary}</small>
          </button>
          <TradingViewChart interval={interval} />
        </div>
        <GannWorkbench activeFrame={activeFrame} scanNonce={scanNonce} onAutoResult={handleAutoResult} />
      </section>

      {notice && (
        <div className="setup-toast" role="status">
          <span className="auto-dot near" />
          <p>{notice}</p>
          <button type="button" aria-label="Dismiss setup alert" onClick={() => setNotice("")}>×</button>
        </div>
      )}

      <footer className="statusbar"><div><span className="status-dot" /> XAU/USD workspace</div><p>Rule-based planning only — verify every setup before trading</p></footer>
    </main>
  );
}

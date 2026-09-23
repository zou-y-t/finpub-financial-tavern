import { useEffect, useMemo, useRef, useState } from 'react';
import { exportMarketData } from './exportData';
import {
  INSTRUMENTS, accountMetrics, advanceTick, createMarket, defaultConfig, displayTime, estimateMarketOrder,
  clearAccumulatedData, formatPnl, formatPrice, getBookLevels, getQuotes, queuePlayerOrder, requestCancel, roundCurrency,
} from './market';
import type { Account, BookLevel, Market, MarketConfig, Side } from './types';

type Language = 'en' | 'zh';
type BottomTab = 'trades' | 'orders' | 'positions' | 'events' | 'npcs';

const copy = {
  en: {
    start: 'Launch market', reset: 'Reset defaults', setup: 'Market initialization', fees: 'Fees & account settings',
    cash: 'Starting cash', inventory: 'Starting inventory / instrument', prices: 'Initial market prices',
    npc: 'NPC count', seed: 'Random seed', maker: 'Maker fee', taker: 'Taker fee', enableFees: 'Enable fees',
    startTime: 'Simulation start time', running: 'RUNNING', paused: 'PAUSED', pause: 'Pause', resume: 'Resume',
    restart: 'Restart market', export: 'Export CSV', next: 'Next auction', bid: 'Bid / Buy', ask: 'Ask / Sell',
    limit: 'Limit', market: 'Market', quantity: 'Quantity', submitBuy: 'Queue buy order', submitSell: 'Queue sell order',
    account: 'Your account', totalCash: 'Total cash', availableCash: 'Available cash', frozenCash: 'Frozen cash',
    holdings: 'Holdings value', assets: 'Total assets', realized: 'Realized P&L', unrealized: 'Unrealized P&L',
    feesPaid: 'Total fees', orderBook: 'Order book · top 5', trades: 'Trades', orders: 'My orders', positions: 'My positions',
    events: 'Event timeline', npcs: 'NPC statistics', selected: 'Selected', last: 'Last', change: 'Change', volume: 'Volume', clearCache: 'Clear cache',
  },
  zh: {
    start: '启动市场', reset: '恢复默认', setup: '市场初始化', fees: '费用与账户设置', cash: '玩家初始现金', inventory: '每种酒初始持仓', prices: '初始市场价格',
    npc: 'NPC 数量', seed: '随机种子', maker: 'Maker 手续费', taker: 'Taker 手续费', enableFees: '启用手续费',
    startTime: '模拟开始时间', running: '运行中', paused: '已暂停', pause: '暂停', resume: '继续',
    restart: '重开市场', export: '导出 CSV', next: '下一次撮合', bid: '买入 Bid', ask: '卖出 Ask',
    limit: '限价', market: '市价', quantity: '数量', submitBuy: '提交买单', submitSell: '提交卖单',
    account: '我的账户', totalCash: '总现金', availableCash: '可用现金', frozenCash: '冻结现金',
    holdings: '总持仓市值', assets: '总资产', realized: '已实现盈亏', unrealized: '未实现盈亏',
    feesPaid: '累计手续费', orderBook: '订单簿 · 五档', trades: '逐笔成交', orders: '我的挂单', positions: '我的持仓',
    events: '事件时间线', npcs: 'NPC 统计', selected: '当前标的', last: '最新', change: '涨跌', volume: '成交量', clearCache: '清除缓存',
  },
} as const;

function money(value: number): string { return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 酒币`; }
function pct(value: number): string { return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`; }
function statusLabel(status: string): string { return status.replaceAll('_', ' '); }

function Sparkline({ points }: { points: Array<{ tick: number; price: number }> }) {
  if (points.length < 2) return <span className="waiting-line">Awaiting trades</span>;
  const recent = points.slice(-28);
  const low = Math.min(...recent.map((point) => point.price));
  const high = Math.max(...recent.map((point) => point.price));
  const range = high - low || 1;
  const coordinates = recent.map((point, index) => `${(index / (recent.length - 1)) * 100},${28 - ((point.price - low) / range) * 26}`).join(' ');
  const rising = recent.at(-1)!.price >= recent[0].price;
  return <svg className={`spark ${rising ? 'up' : 'down'}`} viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points={coordinates} /></svg>;
}

function TradeChart({ market, symbol }: { market: Market; symbol: string }) {
  const points = market.assets[symbol].priceHistory.slice(-90);
  if (points.length < 2) return <div className="empty-chart">No completed trades yet. This chart is populated only by executions.</div>;
  const low = Math.min(...points.map((point) => point.price));
  const high = Math.max(...points.map((point) => point.price));
  const range = high - low || market.assets[symbol].definition.tickSize;
  const svgPoints = points.map((point, index) => `${(index / (points.length - 1)) * 1000},${220 - ((point.price - low) / range) * 195}`).join(' ');
  return <div className="chart-wrap"><div className="chart-range"><span>{high.toFixed(1)}</span><span>Executed price · last {points.length} prints</span><span>{low.toFixed(1)}</span></div><svg className="trade-chart" viewBox="0 0 1000 230" preserveAspectRatio="none"><line x1="0" y1="220" x2="1000" y2="220" /><polyline points={svgPoints} /></svg></div>;
}

function BookRows({ levels, side, onSelect }: { levels: BookLevel[]; side: Side; onSelect: (price: number) => void }) {
  const rendered = side === 'sell' ? [...levels].reverse() : levels;
  return <div className={`book-half ${side}`}>{rendered.length === 0 ? <div className="empty-book">No confirmed {side === 'buy' ? 'bids' : 'asks'}</div> : rendered.map((level, index) => (
    <button className={`book-row ${level.hasPlayerOrder ? 'own' : ''}`} onClick={() => onSelect(level.price)} key={`${side}-${level.price}`} title="Prefill limit price">
      <span>{side === 'buy' ? `B${index + 1}` : `A${rendered.length - index}`}</span><strong>{level.price.toFixed(1)}</strong><span>{level.quantity}</span><span>{level.orderCount} order{level.orderCount === 1 ? '' : 's'}</span>{level.hasPlayerOrder && <i>You</i>}
    </button>
  ))}</div>;
}

function Setup({ config, setConfig, onLaunch, language, setLanguage }: { config: MarketConfig; setConfig: (value: MarketConfig) => void; onLaunch: () => void; language: Language; setLanguage: (value: Language) => void }) {
  const t = copy[language];
  const [feeUnit, setFeeUnit] = useState<'percent' | 'bps'>('percent');
  const feeToInput = (rate: number) => feeUnit === 'percent' ? rate * 100 : rate * 10_000;
  const update = <K extends keyof MarketConfig>(key: K, value: MarketConfig[K]) => setConfig({ ...config, [key]: value });
  const updateFee = (key: 'makerFeeRate' | 'takerFeeRate', value: number) => update(key, Math.max(0, feeUnit === 'percent' ? value / 100 : value / 10_000));
  return <main className="setup-page">
    <section className="setup-card">
      <header className="setup-brand"><div className="brand-mark">F</div><div><h1>FINPUB <span>｜金融酒馆</span></h1><p>Local discrete-time exchange simulator · all matching is in this browser</p></div><select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en">English</option><option value="zh">中文</option></select></header>
      <div className="setup-title"><div><span className="eyebrow">PRE-MARKET</span><h2>{t.setup}</h2><p>These values are locked once the exchange starts. Re-open this screen to create a new market.</p></div><button className="ghost" onClick={() => setConfig(defaultConfig())}>{t.reset}</button></div>
      <div className="config-grid">
        <section><h3>{t.fees}</h3><label>{t.cash}<input min="0" step="100" type="number" value={config.playerCash} onChange={(e) => update('playerCash', Number(e.target.value))} /></label><label>{t.npc}<input min="20" max="200" type="number" value={config.npcCount} onChange={(e) => update('npcCount', Number(e.target.value))} /></label><label>{t.seed}<input min="1" type="number" value={config.seed} onChange={(e) => update('seed', Number(e.target.value))} /></label><label>{t.startTime}<input type="datetime-local" value={config.startTime} onChange={(e) => update('startTime', e.target.value)} /></label></section>
        <section><div className="fee-heading"><h3>Trading fees</h3><select value={feeUnit} onChange={(e) => setFeeUnit(e.target.value as 'percent' | 'bps')}><option value="percent">Percent (%)</option><option value="bps">Basis points (bp)</option></select></div><label>{t.maker}<input min="0" step="0.01" type="number" value={feeToInput(config.makerFeeRate)} onChange={(e) => updateFee('makerFeeRate', Number(e.target.value))} /><small>{(config.makerFeeRate * 100).toFixed(4)}% · {(config.makerFeeRate * 10_000).toFixed(2)} bp</small></label><label>{t.taker}<input min="0" step="0.01" type="number" value={feeToInput(config.takerFeeRate)} onChange={(e) => updateFee('takerFeeRate', Number(e.target.value))} /><small>{(config.takerFeeRate * 100).toFixed(4)}% · {(config.takerFeeRate * 10_000).toFixed(2)} bp</small></label><label className="check"><input type="checkbox" checked={config.feesEnabled} onChange={(e) => update('feesEnabled', e.target.checked)} /> {t.enableFees}</label><aside className="hint">Maker is a resting order. Any order that takes existing book liquidity is charged the Taker rate—even if it is a limit order.</aside></section>
      </div>
      <section className="instrument-setup"><h3>{t.inventory} &amp; {t.prices}</h3><div className="instrument-form">{INSTRUMENTS.map((item) => <div className="instrument-input" key={item.symbol}><b>{item.symbol}</b><span>{item.name}</span><label>Position<input min="0" step="1" type="number" value={config.playerPositions[item.symbol]} onChange={(e) => setConfig({ ...config, playerPositions: { ...config.playerPositions, [item.symbol]: Math.max(0, Math.floor(Number(e.target.value))) } })} /></label><label>Price<input min={item.tickSize} step={item.tickSize} type="number" value={config.initialPrices[item.symbol]} onChange={(e) => setConfig({ ...config, initialPrices: { ...config.initialPrices, [item.symbol]: Math.max(item.tickSize, Number(e.target.value)) } })} /></label></div>)}</div></section>
      <footer className="setup-footer"><p>NPCs have unlimited virtual cash and inventory for quoting, while their virtual ledger still marks every fill, fee, P&amp;L and position.</p><button className="primary launch" onClick={onLaunch}>{t.start} <span>→</span></button></footer>
    </section>
  </main>;
}

function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [draft, setDraft] = useState<MarketConfig>(() => defaultConfig());
  const [market, setMarket] = useState<Market | null>(null);
  const [running, setRunning] = useState(true);
  const [selectedSymbol, setSelectedSymbol] = useState('BDX');
  const [side, setSide] = useState<Side>('buy');
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [quantity, setQuantity] = useState(5);
  const [selectedPrice, setSelectedPrice] = useState<number | undefined>();
  const [feedback, setFeedback] = useState('Choose a visible price, then queue an order for the next auction.');
  const [tab, setTab] = useState<BottomTab>('trades');
  const [selectedNpc, setSelectedNpc] = useState<string | null>(null);
  const clockRef = useRef(performance.now());
  const [frame, setFrame] = useState(performance.now());
  const marketRef = useRef<Market | null>(null);
  const t = copy[language];

  useEffect(() => { marketRef.current = market; }, [market]);
  useEffect(() => {
    if (!market || !running) return undefined;
    clockRef.current = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now - clockRef.current >= 1000 && marketRef.current) {
        const elapsedTicks = Math.floor((now - clockRef.current) / 1000);
        for (let count = 0; count < elapsedTicks; count += 1) advanceTick(marketRef.current);
        clockRef.current += elapsedTicks * 1000;
        setMarket({ ...marketRef.current });
      }
      setFrame(now);
    }, 60);
    return () => window.clearInterval(timer);
  }, [market, running]);

  const launch = () => { const next = createMarket(draft); marketRef.current = next; setMarket(next); setRunning(true); setSelectedSymbol('BDX'); setFeedback('Market opened. The first auction occurs in one second.'); };
  if (!market) return <Setup config={draft} setConfig={setDraft} onLaunch={launch} language={language} setLanguage={setLanguage} />;

  const asset = market.assets[selectedSymbol];
  const player = market.accounts.player;
  const bids = getBookLevels(market, selectedSymbol, 'buy');
  const asks = getBookLevels(market, selectedSymbol, 'sell');
  const quotes = getQuotes(market, selectedSymbol);
  const playerMetrics = accountMetrics(market, player);
  const position = player.positions[selectedSymbol];
  const selectedMarket = estimateMarketOrder(market, selectedSymbol, side, Math.max(0, Math.floor(quantity) || 0));
  const feeRate = market.config.feesEnabled ? Math.max(market.config.makerFeeRate, market.config.takerFeeRate) : 0;
  const limitGross = roundCurrency((selectedPrice ?? 0) * Math.max(0, quantity));
  const estimateGross = orderType === 'market' ? selectedMarket.gross : limitGross;
  const estimateFee = orderType === 'market' ? selectedMarket.fee : roundCurrency(limitGross * feeRate);
  const estimateTotal = side === 'buy' ? estimateGross + estimateFee : estimateGross - estimateFee;
  const nextMs = running ? Math.max(0, 1000 - (frame - clockRef.current)) : 0;
  const userPending = market.pendingOrderIds.filter((id) => market.orders[id]?.participantId === 'player').length;
  const userOrders = Object.values(market.orders).filter((order) => order.participantId === 'player').sort((a, b) => b.sequence - a.sequence);
  const npcRows = Object.values(market.accounts).filter((account) => account.type === 'npc').map((account) => ({ account, metrics: accountMetrics(market, account) })).sort((left, right) => right.metrics.totalPnl - left.metrics.totalPnl);
  const visibleNpc = selectedNpc ? market.accounts[selectedNpc] : npcRows[0]?.account;
  const cachedRecordCount = market.trades.length + market.snapshots.length + market.participantSnapshots.length + market.events.length
    + Object.keys(market.orders).length + Object.values(market.assets).reduce((total, current) => total + current.priceHistory.length, 0);

  const choosePrice = (price: number) => { setOrderType('limit'); setSelectedPrice(price); setFeedback(`Limit price prefilled at ${price.toFixed(1)}. Review quantity before queueing.`); };
  const submitOrder = () => {
    const result = queuePlayerOrder(market, { symbol: selectedSymbol, side, type: orderType, quantity, limitPrice: selectedPrice });
    setFeedback(result.message);
    setMarket({ ...market });
  };
  const cancel = (id: string) => { const result = requestCancel(market, id); setFeedback(result.message); setMarket({ ...market }); };
  const clearCache = () => {
    const confirmed = window.confirm('Clear accumulated trades, completed orders, snapshots, event timeline and chart history? Current balances, positions, active orders and live order books will be preserved. Exported CSV files will contain only records collected after this cleanup.');
    if (!confirmed) return;
    const result = clearAccumulatedData(market);
    setFeedback(`Cache cleared: ${result.recordsRemoved.toLocaleString()} history records and ${result.ordersRemoved.toLocaleString()} completed orders removed.`);
    setMarket({ ...market });
  };
  const changePct = asset.previousClose ? (asset.lastPrice - asset.previousClose) / asset.previousClose : 0;
  const pnlClass = (value: number) => value >= 0 ? 'positive' : 'negative';

  return <main className="terminal">
    <header className="topbar">
      <div className="wordmark"><div className="brand-mark">F</div><div><b>FINPUB</b><span>金融酒馆 · Local Exchange</span></div></div>
      <div className={`status ${running ? 'live' : 'halted'}`}><i />{running ? t.running : t.paused}</div>
      <div className="top-stat"><span>SIMULATION TIME</span><b>{displayTime(market)}</b></div>
      <div className="top-stat countdown"><span>{t.next}</span><b>{running ? `${(nextMs / 1000).toFixed(2)}s` : 'Paused'}</b></div>
      <div className="top-stat"><span>NPCs</span><b>{market.config.npcCount}</b></div>
      <div className="top-stat"><span>SEED</span><b>{market.config.seed}</b></div>
      <div className="top-actions"><button onClick={() => setRunning(!running)}>{running ? t.pause : t.resume}</button><button onClick={() => { const restarted = createMarket(market.config); marketRef.current = restarted; setMarket(restarted); setRunning(true); setFeedback('Market restarted from the locked initialization settings.'); }}>{t.restart}</button><button onClick={() => { setDraft(market.config); setMarket(null); }}>Reconfigure</button><button className="danger-action" onClick={clearCache} title={`${cachedRecordCount.toLocaleString()} in-memory records`}>{t.clearCache}</button><button className="accent" onClick={() => exportMarketData(market)}>{t.export}</button><select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en">EN</option><option value="zh">中文</option></select></div>
    </header>
    {market.latestEvent && <section className={`event-banner ${market.latestEvent.direction}`}><span className="event-kicker">LATEST EVENT · T{market.latestEvent.tick}</span><b>{market.latestEvent.title}</b><span>{market.latestEvent.direction === 'bullish' ? '▲ BULLISH' : '▼ BEARISH'} · {market.latestEvent.symbols.join(', ')}</span><small>{market.latestEvent.description}</small></section>}
    <div className="workspace">
      <aside className="instrument-list panel"><div className="panel-title"><span>INSTRUMENTS</span><small>6 listed wines &amp; spirits</small></div>{INSTRUMENTS.map((item) => { const state = market.assets[item.symbol]; const pctChange = (state.lastPrice - state.previousClose) / state.previousClose; const flagged = market.latestEvent?.symbols.includes(item.symbol); return <button key={item.symbol} className={`instrument ${selectedSymbol === item.symbol ? 'selected' : ''}`} onClick={() => { setSelectedSymbol(item.symbol); setSelectedPrice(undefined); }}><div><span className="symbol">{item.symbol}{flagged && <i className="event-dot" />}</span><strong>{state.lastPrice.toFixed(1)}</strong></div><div><span>{item.name}</span><em className={pnlClass(pctChange)}>{pct(pctChange)}</em></div><Sparkline points={state.priceHistory} /><small>Vol {state.volume.toLocaleString()}</small></button>; })}</aside>
      <section className="market-center">
        <section className="instrument-header panel"><div><span className="eyebrow">{asset.definition.category.toUpperCase()} · {asset.definition.symbol}</span><h1>{asset.definition.name}</h1></div><div className="last-price"><b>{asset.lastPrice.toFixed(1)}</b><span className={pnlClass(changePct)}>{pct(changePct)} vs initial</span></div><div className="quote-grid"><div><span>BEST BID</span><b className="positive">{formatPrice(quotes.bestBid)}</b></div><div><span>BEST ASK</span><b className="negative">{formatPrice(quotes.bestAsk)}</b></div><div><span>MID</span><b>{formatPrice(quotes.mid)}</b></div><div><span>SPREAD</span><b>{formatPrice(quotes.spread)}</b></div></div></section>
        <section className="panel chart-panel"><div className="panel-title"><span>EXECUTED PRICE HISTORY</span><small>actual fills only · Fair value {asset.fairValue.toFixed(1)}</small></div><TradeChart market={market} symbol={selectedSymbol} /></section>
        <section className="book-panel panel"><div className="panel-title"><span>{t.orderBook}</span><small>{market.pendingOrderIds.length} queued · {userPending} yours waiting</small></div><div className="book-label"><span>LEVEL / PRICE</span><span>QUANTITY / ORDERS</span></div><BookRows levels={asks} side="sell" onSelect={choosePrice} /><div className="mid-strip">MID {formatPrice(quotes.mid)} · SPREAD {formatPrice(quotes.spread)} <small>Click a level to prefill only</small></div><BookRows levels={bids} side="buy" onSelect={choosePrice} /></section>
      </section>
      <aside className="right-rail">
        <section className="order-panel panel"><div className="panel-title"><span>ORDER ENTRY</span><small>{asset.definition.symbol} · tick {asset.definition.tickSize}</small></div><div className="switch"><button className={side === 'buy' ? 'active buy' : ''} onClick={() => setSide('buy')}>{t.bid}</button><button className={side === 'sell' ? 'active sell' : ''} onClick={() => setSide('sell')}>{t.ask}</button></div><div className="switch compact"><button className={orderType === 'limit' ? 'active' : ''} onClick={() => setOrderType('limit')}>{t.limit}</button><button className={orderType === 'market' ? 'active' : ''} onClick={() => setOrderType('market')}>{t.market}</button></div>{orderType === 'limit' ? <div className="price-picker"><label>Price — select from visible top five</label><div>{[...bids, ...asks].map((level) => <button onClick={() => choosePrice(level.price)} className={selectedPrice === level.price ? 'chosen' : ''} key={level.price}>{level.price.toFixed(1)}</button>)}</div><strong>{selectedPrice ? `${selectedPrice.toFixed(1)} 酒币 selected` : 'No price selected'}</strong></div> : <div className="market-estimate"><span>Market order estimate</span><b>{selectedMarket.firstPrice ? `Starting from ${selectedMarket.firstPrice.toFixed(1)}` : 'No opposing quote'}</b><small>Unfilled quantity cancels at auction close.</small></div>}<label className="qty-label">{t.quantity}<input min="1" step="1" type="number" value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))} /></label><div className="order-summary"><div><span>Estimated gross</span><b>{money(estimateGross)}</b></div><div><span>Estimated fee</span><b>{money(estimateFee)}</b></div><div><span>{side === 'buy' ? 'Maximum outlay' : 'Estimated net receipt'}</span><b>{money(estimateTotal)}</b></div><small>Possible rate: maker {(market.config.feesEnabled ? market.config.makerFeeRate * 100 : 0).toFixed(3)}% / taker {(market.config.feesEnabled ? market.config.takerFeeRate * 100 : 0).toFixed(3)}%</small><small>{side === 'buy' ? `Available cash: ${money(player.cash - player.reservedCash)}` : `Available ${selectedSymbol}: ${position.quantity - position.reserved}`}</small></div><button className={`primary submit ${side}`} disabled={!running} onClick={submitOrder}>{side === 'buy' ? t.submitBuy : t.submitSell}</button><p className="feedback">{feedback}</p></section>
        <section className="account-panel panel"><div className="panel-title"><span>{t.account}</span><small>{selectedSymbol} {position.quantity} held · {position.reserved} frozen</small></div><div className="account-grid"><div><span>{t.totalCash}</span><b>{money(player.cash)}</b></div><div><span>{t.availableCash}</span><b>{money(player.cash - player.reservedCash)}</b></div><div><span>{t.frozenCash}</span><b>{money(player.reservedCash)}</b></div><div><span>{t.holdings}</span><b>{money(playerMetrics.positionValue)}</b></div><div><span>{t.assets}</span><b>{money(playerMetrics.totalAsset)}</b></div><div><span>{t.realized}</span><b className={pnlClass(player.realizedPnl)}>{formatPnl(player.realizedPnl)}</b></div><div><span>{t.unrealized}</span><b className={pnlClass(playerMetrics.unrealized)}>{formatPnl(playerMetrics.unrealized)}</b></div><div><span>{t.feesPaid}</span><b>{money(player.makerFees + player.takerFees)}</b></div></div><p className="fee-detail">Maker {money(player.makerFees)} · Taker {money(player.takerFees)}</p></section>
      </aside>
    </div>
    <section className="bottom panel"><div className="tabs">{(['trades', 'orders', 'positions', 'events', 'npcs'] as BottomTab[]).map((name) => <button className={tab === name ? 'active' : ''} onClick={() => setTab(name)} key={name}>{({ trades: t.trades, orders: t.orders, positions: t.positions, events: t.events, npcs: t.npcs })[name]}</button>)}</div>{tab === 'trades' && <div className="table-wrap"><table><thead><tr><th>Time</th><th>Symbol</th><th>Price</th><th>Qty</th><th>Aggressor</th><th>Your role</th><th>Rate</th><th>Gross</th><th>Your fee</th><th>Your net cash</th></tr></thead><tbody>{market.trades.slice(0, 30).map((trade) => { const playerSide = trade.buyerId === 'player' ? 'buy' : trade.sellerId === 'player' ? 'sell' : null; const role = trade.makerId === 'player' ? 'Maker' : trade.takerId === 'player' ? 'Taker' : '—'; const playerRate = role === 'Maker' ? market.config.makerFeeRate : role === 'Taker' ? market.config.takerFeeRate : null; const fee = trade.buyerId === 'player' ? trade.buyerFee : trade.sellerId === 'player' ? trade.sellerFee : 0; const cashChange = trade.buyerId === 'player' ? trade.buyerCashChange : trade.sellerId === 'player' ? trade.sellerCashChange : 0; return <tr key={trade.id}><td>{new Date(trade.simTime).toLocaleTimeString()}</td><td>{trade.symbol}</td><td>{trade.price.toFixed(1)}</td><td>{trade.quantity}</td><td className={trade.aggressorSide === 'buy' ? 'positive' : 'negative'}>{trade.aggressorSide.toUpperCase()}</td><td>{role}{playerSide && ` · ${playerSide}`}</td><td>{playerRate === null ? '—' : `${(playerRate * 100).toFixed(3)}%`}</td><td>{money(trade.grossAmount)}</td><td>{playerSide ? money(fee) : '—'}</td><td className={cashChange >= 0 ? 'positive' : 'negative'}>{playerSide ? formatPnl(cashChange) : '—'}</td></tr>; })}{market.trades.length === 0 && <tr><td colSpan={10} className="empty-row">No executions yet. NPC liquidity is confirmed in the book; transactions appear here after auctions.</td></tr>}</tbody></table></div>}{tab === 'orders' && <div className="table-wrap"><table><thead><tr><th>ID</th><th>Symbol</th><th>Side</th><th>Type</th><th>Limit</th><th>Original</th><th>Remaining</th><th>Status</th><th /></tr></thead><tbody>{userOrders.map((order) => <tr key={order.id}><td>{order.id}</td><td>{order.symbol}</td><td className={order.side === 'buy' ? 'positive' : 'negative'}>{order.side.toUpperCase()}</td><td>{order.type}</td><td>{formatPrice(order.limitPrice)}</td><td>{order.quantity}</td><td>{order.remaining}</td><td><span className={`order-status ${order.status}`}>{statusLabel(order.status)}</span></td><td>{['queued', 'open', 'partial'].includes(order.status) && <button className="cancel" onClick={() => cancel(order.id)}>Cancel</button>}</td></tr>)}{userOrders.length === 0 && <tr><td colSpan={9} className="empty-row">Your queued and confirmed orders will appear here.</td></tr>}</tbody></table></div>}{tab === 'positions' && <div className="table-wrap"><table><thead><tr><th>Symbol</th><th>Position</th><th>Available</th><th>Average cost</th><th>Last</th><th>Market value</th><th>Unrealized P&amp;L</th></tr></thead><tbody>{INSTRUMENTS.map((item) => { const holding = player.positions[item.symbol]; const last = market.assets[item.symbol].lastPrice; const upnl = holding.quantity * (last - holding.averageCost); return <tr key={item.symbol}><td><b>{item.symbol}</b> <small>{item.name}</small></td><td>{holding.quantity}</td><td>{holding.quantity - holding.reserved}</td><td>{holding.averageCost.toFixed(1)}</td><td>{last.toFixed(1)}</td><td>{money(holding.quantity * last)}</td><td className={pnlClass(upnl)}>{formatPnl(upnl)} · {upnl >= 0 ? 'Profit' : 'Loss'}</td></tr>; })}</tbody></table></div>}{tab === 'events' && <div className="timeline">{market.events.map((event) => <article className={event.direction} key={event.id}><time>T{event.tick} · {new Date(event.simTime).toLocaleTimeString()}</time><div><b>{event.title}</b><p>{event.description}</p><span>{event.symbols.join(', ')} · {event.direction === 'bullish' ? '▲ Bullish' : '▼ Bearish'} · initial impact {(event.impact * 100).toFixed(1)}%</span></div></article>)}{market.events.length === 0 && <div className="empty-row">The next deterministic event is scheduled for T{market.nextEventTick}. Events affect valuation and decisions, never last price directly.</div>}</div>}{tab === 'npcs' && <div className="npc-layout"><div className="table-wrap npc-table"><table><thead><tr><th>NPC</th><th>Style</th><th>Total P&amp;L</th><th>Realized</th><th>Unrealized</th><th>Fees</th><th>Trades</th><th>Net pos.</th></tr></thead><tbody>{npcRows.map(({ account, metrics }) => <tr className={selectedNpc === account.id ? 'selected-row' : ''} onClick={() => setSelectedNpc(account.id)} key={account.id}><td>{account.name}</td><td>{account.style?.replace('_', ' ')}</td><td className={pnlClass(metrics.totalPnl)}>{formatPnl(metrics.totalPnl)} · {metrics.totalPnl >= 0 ? 'Profit' : 'Loss'}</td><td className={pnlClass(account.realizedPnl)}>{formatPnl(account.realizedPnl)}</td><td className={pnlClass(metrics.unrealized)}>{formatPnl(metrics.unrealized)}</td><td>{money(account.makerFees + account.takerFees)}</td><td>{account.tradeCount}</td><td>{metrics.netPosition >= 0 ? '+' : ''}{metrics.netPosition}</td></tr>)}</tbody></table></div>{visibleNpc && <aside className="npc-detail"><span className="eyebrow">VIRTUAL LEDGER</span><h3>{visibleNpc.name}</h3><p>{visibleNpc.style?.replace('_', ' ')} · unlimited quoting capacity</p><div><span>Cash balance</span><b>{money(visibleNpc.cash)}</b></div><div><span>Total assets</span><b>{money(accountMetrics(market, visibleNpc).totalAsset)}</b></div><div><span>Maker / Taker fees</span><b>{money(visibleNpc.makerFees)} / {money(visibleNpc.takerFees)}</b></div><h4>Positions</h4>{INSTRUMENTS.map((item) => <div key={item.symbol}><span>{item.symbol}</span><b>{visibleNpc.positions[item.symbol].quantity >= 0 ? '+' : ''}{visibleNpc.positions[item.symbol].quantity} @ {visibleNpc.positions[item.symbol].averageCost.toFixed(1)}</b></div>)}<h4>Recent trades</h4>{market.trades.filter((trade) => trade.buyerId === visibleNpc.id || trade.sellerId === visibleNpc.id).slice(0, 5).map((trade) => <p className="npc-trade" key={trade.id}>{trade.symbol} {trade.buyerId === visibleNpc.id ? 'bought' : 'sold'} {trade.quantity} @ {trade.price.toFixed(1)} · {trade.makerId === visibleNpc.id ? 'Maker' : 'Taker'}</p>)}</aside>}</div>}</section>
    <footer className="terminal-footer"><span>Discrete 1-second auction · price/time priority · full depth held internally, five levels displayed</span><span className="maintenance">In-memory cache: {cachedRecordCount.toLocaleString()} records · <button onClick={clearCache}>{t.clearCache}</button> · <button onClick={() => exportMarketData(market)}>Download all CSV data</button></span></footer>
  </main>;
}

export default App;

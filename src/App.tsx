import { useEffect, useRef, useState } from 'react';
import { exportMarketData } from './exportData';
import { downloadStrategyPackage } from './pythonPackage';
import { WikiPage } from './Wiki';
import { DEFAULT_STRATEGY_CODE, MODEL_VERSION, STRATEGY_BAR_TICKS, buildStrategyContext, createStrategySession, expandStrategyIntents, normalizeStrategyIntents, validateStrategyAction } from './strategy';
import { PythonStrategyRunner } from './strategyRuntime';
import {
  INSTRUMENTS, accountMetrics, advanceTick, createMarket, defaultConfig, estimateMarketOrder,
  clearAccumulatedData, formatPnl, formatPrice, getBookLevels, getQuotes, queuePlayerOrder, requestCancel, roundCurrency,
} from './market';
import type { Account, BookLevel, Market, MarketConfig, Side } from './types';
import type { StrategyAction, StrategySession } from './strategy';

type Language = 'en' | 'zh';
type BottomTab = 'trades' | 'orders' | 'positions' | 'portfolio' | 'strategy' | 'events' | 'npcs';

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
    portfolio: 'Portfolio history', strategy: 'Automated strategy', accelerate: 'Fast-forward ×25', events: 'Event timeline', npcs: 'NPC statistics', selected: 'Selected', last: 'Last', change: 'Change', volume: 'Volume', clearCache: 'Clear cache',
  },
  zh: {
    start: '启动市场', reset: '恢复默认', setup: '市场初始化', fees: '费用与账户设置', cash: '玩家初始现金', inventory: '每种酒初始持仓', prices: '初始市场价格',
    npc: '交易者数量', seed: '随机种子', maker: '挂单方手续费', taker: '吃单方手续费', enableFees: '启用手续费',
    startTime: '模拟开始时间', running: '运行中', paused: '已暂停', pause: '暂停', resume: '继续',
    restart: '重新开始', export: '导出数据', next: '下一次撮合', bid: '买入', ask: '卖出',
    limit: '限价', market: '市价', quantity: '数量', submitBuy: '提交买单', submitSell: '提交卖单',
    account: '我的账户', totalCash: '总现金', availableCash: '可用现金', frozenCash: '冻结现金',
    holdings: '总持仓市值', assets: '总资产', realized: '已实现盈亏', unrealized: '未实现盈亏',
    feesPaid: '累计手续费', orderBook: '订单簿 · 五档', trades: '逐笔成交', orders: '我的挂单', positions: '我的持仓',
    portfolio: '资产历史', strategy: '自动策略', accelerate: '加速推进 ×25', events: '事件时间线', npcs: '交易者统计', selected: '当前标的', last: '最新', change: '涨跌', volume: '成交量', clearCache: '清除缓存',
  },
} as const;

function pct(value: number): string { return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`; }
function formatMoney(value: number, language: Language): string { return `${value.toLocaleString(locale(language), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${text(language, 'coins', '酒币')}`; }
function text(language: Language, english: string, chinese: string): string { return language === 'zh' ? chinese : english; }
function locale(language: Language): string { return language === 'zh' ? 'zh-CN' : 'en-US'; }
function instrumentName(symbol: string, language: Language): string {
  const names: Record<string, string> = { BDX: '波尔多珍藏', ISL: '艾雷岛单一麦芽威士忌', JDG: '大吟酿', CRM: '加勒比陈年朗姆酒', CHM: '年份香槟', OCR: '果园苹果酒' };
  return language === 'zh' ? names[symbol] ?? symbol : INSTRUMENTS.find((item) => item.symbol === symbol)?.name ?? symbol;
}
function instrumentCategory(symbol: string, language: Language): string {
  const categories: Record<string, string> = { BDX: '葡萄酒', ISL: '威士忌', JDG: '清酒', CRM: '朗姆酒', CHM: '香槟', OCR: '苹果酒' };
  return language === 'zh' ? categories[symbol] ?? '' : INSTRUMENTS.find((item) => item.symbol === symbol)?.category ?? '';
}
function styleLabel(style: Account['style'], language: Language): string {
  const chinese: Record<string, string> = { market_maker: '做市', value: '价值', trend: '趋势', news: '新闻', noise: '随机' };
  return style ? (language === 'zh' ? chinese[style] : style.replace('_', ' ')) : '';
}
function statusLabel(status: string, language: Language): string {
  const chinese: Record<string, string> = { queued: '待撮合', open: '挂单中', partial: '部分成交', filled: '已成交', pending_cancel: '待撤销', cancelled: '已撤销', rejected: '已拒绝' };
  return language === 'zh' ? chinese[status] ?? status : status.replaceAll('_', ' ');
}
function strategyRunStatusLabel(status: 'ok' | 'error' | 'disabled', language: Language): string {
  return text(language, status === 'ok' ? 'OK' : status === 'error' ? 'Error' : 'Disabled', status === 'ok' ? '成功' : status === 'error' ? '错误' : '已关闭');
}
function strategyOrderModeLabel(mode: 'dry_run' | 'queued' | 'cancel_requested' | 'rejected', language: Language): string {
  return text(language, mode === 'dry_run' ? 'Dry run' : mode === 'queued' ? 'Queued' : mode === 'cancel_requested' ? 'Cancel queued' : 'Rejected', mode === 'dry_run' ? '模拟执行' : mode === 'queued' ? '已提交' : mode === 'cancel_requested' ? '撤单已提交' : '已拒绝');
}
function accountName(account: Account, language: Language): string {
  if (account.type === 'player') return text(language, 'You', '我');
  return text(language, `NPC ${account.id.slice(-3)}`, `交易者 ${account.id.slice(-3)}`);
}
function eventTitle(title: string, language: Language): string {
  if (language === 'en') return title;
  const symbols: Record<string, string> = { 'Bordeaux Reserve': '波尔多珍藏', 'Islay Single Malt': '艾雷岛单一麦芽威士忌', Daiginjo: '大吟酿', 'Caribbean Aged Rum': '加勒比陈年朗姆酒', 'Vintage Champagne': '年份香槟', 'Orchard Cider': '果园苹果酒' };
  const name = Object.entries(symbols).find(([english]) => title.includes(english))?.[1] ?? '';
  if (title.startsWith('Critics award')) return `评论家为${name}给出罕见的窖藏高分。`;
  if (title.startsWith('A frost report')) return `霜冻报告收紧了${name}的供应预期。`;
  if (title.startsWith('A prominent bar')) return `知名酒吧合作提升了${name}的近期需求。`;
  if (title.startsWith('A storage quality')) return `仓储质量预警打压了${name}。`;
  if (title.startsWith('Transport delays')) return `运输延误增加了${name}的不确定性。`;
  return `税收和替代品消息压制了${name}。`;
}
function eventDescription(direction: 'bullish' | 'bearish', language: Language): string {
  return text(language, `${direction === 'bullish' ? 'Bullish' : 'Bearish'} expectation shock; valuations adjust through trader decisions, not a price override.`, `${direction === 'bullish' ? '利好' : '利空'}预期冲击；估值会通过交易者决策调整，不会直接改写价格。`);
}
function feedbackText(message: string, language: Language): string {
  if (language === 'en') return message;
  if (message === 'Quantity must be a positive integer.') return '委托数量必须是正整数。';
  if (message === 'Unknown instrument.') return '未知交易品种。';
  if (message === 'Choose a price from the visible order book.') return '限价单请选择可见订单簿中的价格。';
  if (message === 'No opposing liquidity is currently available.') return '当前没有可成交的对手方流动性。';
  if (message === 'Insufficient available inventory.') return '可用持仓不足。';
  if (message === 'Order not found.') return '未找到该委托。';
  if (message === 'This order can no longer be cancelled.') return '该委托已无法撤销。';
  const queued = message.match(/^(O-\d+) queued/);
  if (queued) return `${queued[1]} 已提交，将在下一次撮合中处理。`;
  const cancelled = message.match(/^(O-\d+) cancellation queued/);
  if (cancelled) return `${cancelled[1]} 的撤单申请已提交，将在下一次撮合中处理。`;
  const insufficientCash = message.match(/^Insufficient available cash\. Need (.+)$/);
  if (insufficientCash) return `可用现金不足，需要 ${insufficientCash[1]}`;
  return message;
}

function Sparkline({ points, language }: { points: Array<{ tick: number; price: number }>; language: Language }) {
  if (points.length < 2) return <span className="waiting-line">{text(language, 'Awaiting trades', '等待成交')}</span>;
  const recent = points.slice(-28);
  const low = Math.min(...recent.map((point) => point.price));
  const high = Math.max(...recent.map((point) => point.price));
  const range = high - low || 1;
  const coordinates = recent.map((point, index) => `${(index / (recent.length - 1)) * 100},${28 - ((point.price - low) / range) * 26}`).join(' ');
  const rising = recent.at(-1)!.price >= recent[0].price;
  return <svg className={`spark ${rising ? 'up' : 'down'}`} viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points={coordinates} /></svg>;
}

function TradeChart({ market, symbol, language }: { market: Market; symbol: string; language: Language }) {
  const points = market.assets[symbol].priceHistory.slice(-90);
  if (points.length < 2) return <div className="empty-chart">{text(language, 'No completed trades yet. This chart is populated only by executions.', '暂未产生已完成的成交。该图表仅显示实际成交价格。')}</div>;
  const low = Math.min(...points.map((point) => point.price));
  const high = Math.max(...points.map((point) => point.price));
  const range = high - low || market.assets[symbol].definition.tickSize;
  const svgPoints = points.map((point, index) => `${(index / (points.length - 1)) * 1000},${220 - ((point.price - low) / range) * 195}`).join(' ');
  return <div className="chart-wrap"><div className="chart-range"><span>{high.toFixed(1)}</span><span>{text(language, `Executed price · last ${points.length} prints`, `成交价格 · 最近 ${points.length} 笔`)}</span><span>{low.toFixed(1)}</span></div><svg className="trade-chart" viewBox="0 0 1000 230" preserveAspectRatio="none"><line x1="0" y1="220" x2="1000" y2="220" /><polyline points={svgPoints} /></svg></div>;
}

const portfolioColors = ['#d99b35', '#74b689', '#6ea5db', '#e07878', '#b28ddb', '#d7d36b', '#8e9297'];

function PortfolioHistory({ market, language }: { market: Market; language: Language }) {
  const snapshots = market.portfolioSnapshots;
  if (snapshots.length < 2) return <div className="empty-row">{text(language, 'Advance the simulation to collect portfolio history.', '请推进模拟，以收集资产历史数据。')}</div>;
  const first = snapshots[0];
  const latest = snapshots.at(-1)!;
  const totals = snapshots.map((snapshot) => snapshot.totalAsset);
  const low = Math.min(...totals);
  const high = Math.max(...totals);
  const range = high - low || Math.max(1, high * 0.01);
  const totalLine = snapshots.map((snapshot, index) => `${(index / (snapshots.length - 1)) * 1000},${200 - ((snapshot.totalAsset - low) / range) * 180}`).join(' ');
  const weightSeries = [
    { key: 'cash', label: text(language, 'Cash', '现金'), color: portfolioColors[0], value: (snapshot: typeof latest) => snapshot.cashWeight },
    ...INSTRUMENTS.map((instrument, index) => ({ key: instrument.symbol, label: instrument.symbol, color: portfolioColors[index + 1], value: (snapshot: typeof latest) => snapshot.positionWeights[instrument.symbol] ?? 0 })),
  ];
  return <div className="portfolio-history">
    <section className="portfolio-card">
      <div className="panel-title"><span>{text(language, 'TOTAL ASSETS', '总资产变化')}</span><small>{text(language, 'one snapshot per auction tick', '每轮撮合记录一次')}</small></div>
      <div className="portfolio-summary"><div><span>{text(language, 'Latest', '最新')}</span><b>{formatMoney(latest.totalAsset, language)}</b></div><div><span>{text(language, 'Change', '变化')}</span><b className={latest.totalAsset - first.totalAsset >= 0 ? 'positive' : 'negative'}>{formatPnl(latest.totalAsset - first.totalAsset)}</b></div><div><span>{text(language, 'Range', '区间')}</span><b>{formatMoney(low, language)} — {formatMoney(high, language)}</b></div></div>
      <div className="history-chart-wrap"><div className="history-scale"><span>{formatMoney(high, language)}</span><span>{formatMoney(low, language)}</span></div><svg className="history-chart total-assets-chart" viewBox="0 0 1000 220" preserveAspectRatio="none"><line x1="0" y1="200" x2="1000" y2="200" /><polyline points={totalLine} /></svg></div>
    </section>
    <section className="portfolio-card">
      <div className="panel-title"><span>{text(language, 'PORTFOLIO WEIGHTS', '持仓权重变化')}</span><small>{text(language, 'holding market value ÷ total assets; cash included', '持仓市值 ÷ 总资产；包含现金权重')}</small></div>
      <div className="portfolio-legend">{weightSeries.map((series) => <span key={series.key}><i style={{ backgroundColor: series.color }} />{series.label} {(series.value(latest) * 100).toFixed(1)}%</span>)}</div>
      <div className="history-chart-wrap"><div className="history-scale"><span>100%</span><span>0%</span></div><svg className="history-chart weight-chart" viewBox="0 0 1000 220" preserveAspectRatio="none"><line x1="0" y1="200" x2="1000" y2="200" />{weightSeries.map((series) => <polyline key={series.key} style={{ stroke: series.color }} points={snapshots.map((snapshot, index) => `${(index / (snapshots.length - 1)) * 1000},${200 - Math.min(1, Math.max(0, series.value(snapshot))) * 180}`).join(' ')} />)}</svg></div>
    </section>
  </div>;
}

function StrategyPanel({ language, code, onCodeChange, onReset, enabled, setEnabled, dryRun, setDryRun, status, session, onDownloadPackage }: {
  language: Language; code: string; onCodeChange: (value: string) => void; onReset: () => void;
  enabled: boolean; setEnabled: (value: boolean) => void; dryRun: boolean; setDryRun: (value: boolean) => void;
  status: string; session: StrategySession; onDownloadPackage: () => void;
}) {
  const latest = session.runs.at(-1);
  return <div className="strategy-layout">
    <section className="strategy-editor panel">
      <div className="panel-title"><span>{text(language, 'PYTHON STRATEGY', 'Python 策略')}</span><small>{text(language, `on_bar runs every ${STRATEGY_BAR_TICKS} ticks`, `每 ${STRATEGY_BAR_TICKS} 轮调用一次 on_bar`)}</small></div>
      <div className="strategy-toolbar"><button className={enabled ? 'strategy-live' : ''} onClick={() => setEnabled(!enabled)}>{enabled ? text(language, 'Strategy enabled', '策略已启用') : text(language, 'Enable strategy', '启用策略')}</button><label><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} /> {text(language, 'Dry run', '模拟执行')}</label><button onClick={onReset}>{text(language, 'Reset template', '恢复默认策略')}</button><button onClick={onDownloadPackage}>{text(language, 'Download Python package', '下载 Python 回放包')}</button><span>{status}</span></div>
      <textarea className="strategy-code" spellCheck={false} aria-label="Python strategy code" value={code} onChange={(event) => onCodeChange(event.target.value)} />
      <div className="strategy-note">{text(language, 'Return buy(symbol, quantity, price) / sell(symbol, quantity, price) for limit orders; omit price for a market order. Use cancel(order_id), or cancel_all(symbol=None, side=None), to request cancellation at the next auction. All actions are checked against current balances, holdings and visible prices. Dry run validates them without changing the book.', '返回 buy(symbol, quantity, price) / sell(symbol, quantity, price) 可提交限价单；省略 price 则为市价单。可用 cancel(order_id) 或 cancel_all(symbol=None, side=None) 在下一轮申请撤单。所有操作仍会校验当前余额、可用持仓和可见价格；模拟执行只校验，不会改变订单簿。')}</div>
    </section>
    <aside className="strategy-side panel">
      <div className="panel-title"><span>{text(language, 'RUNTIME', '运行状态')}</span><small>{MODEL_VERSION}</small></div>
      <div className="strategy-metrics"><div><span>{text(language, 'Mode', '模式')}</span><b>{dryRun ? text(language, 'Dry run', '模拟执行') : text(language, 'Live simulation', '真实模拟')}</b></div><div><span>{text(language, 'Bars run', '执行 Bar 数')}</span><b>{session.runs.length}</b></div><div><span>{text(language, 'Latest', '最近一次')}</span><b>{latest ? `${strategyRunStatusLabel(latest.status, language)} · ${latest.durationMs}ms` : '—'}</b></div><div><span>{text(language, 'Orders', '策略委托')}</span><b>{session.orders.length}</b></div></div>
      <h4>{text(language, 'Context variables', '可用变量')}</h4><ul className="strategy-vars"><li><code>ctx["tick"]</code> {text(language, 'current auction tick', '当前撮合轮次')}</li><li><code>ctx["assets"]["BDX"]</code> {text(language, 'bars, book, fair value, position and model', 'Bar、订单簿、公允价、持仓与模型')}</li><li><code>ctx["account"]</code> {text(language, 'cash, available/frozen funds and account metrics', '现金、可用/冻结资金与账户指标')}</li><li><code>ctx["open_orders"]</code> {text(language, 'all of your queued and resting orders; use id with cancel(id)', '自己所有待处理和挂簿订单；使用 id 调用 cancel(id)')}</li><li><code>ctx["event"]</code> {text(language, 'latest visible event or None', '最新可见事件或 None')}</li></ul>
      <p className="strategy-model">{text(language, 'signal_v1 combines momentum, fair-value gap, top-five imbalance, spread and event signal into an up probability.', 'signal_v1 将动量、公允价偏离、五档失衡、价差与事件信号组合为上涨概率。')}</p>
    </aside>
    <section className="strategy-results panel">
      <div className="panel-title"><span>{text(language, 'STRATEGY LOG', '策略日志')}</span><small>{text(language, 'latest 20 execution records', '最近 20 条执行记录')}</small></div>
      <div className="table-wrap"><table><thead><tr><th>{text(language, 'Tick', '轮次')}</th><th>{text(language, 'Status', '状态')}</th><th>{text(language, 'Duration', '耗时')}</th><th>{text(language, 'Orders', '委托数')}</th><th>{text(language, 'Message', '信息')}</th></tr></thead><tbody>{session.runs.slice(-20).reverse().map((run) => <tr key={`${run.tick}-${run.durationMs}`}><td>{run.tick}</td><td className={run.status === 'ok' ? 'positive' : 'negative'}>{strategyRunStatusLabel(run.status, language)}</td><td>{run.durationMs}ms</td><td>{run.orderCount}</td><td>{run.message}</td></tr>)}{session.runs.length === 0 && <tr><td colSpan={5} className="empty-row">{text(language, 'Enable the strategy and advance five ticks to run on_bar.', '启用策略后推进五轮，即可运行 on_bar。')}</td></tr>}</tbody></table></div>
      <div className="table-wrap"><table><thead><tr><th>{text(language, 'Tick', '轮次')}</th><th>{text(language, 'Mode', '模式')}</th><th>{text(language, 'Action', '操作')}</th><th>{text(language, 'Type / price', '类型 / 价格')}</th><th>{text(language, 'Result', '结果')}</th></tr></thead><tbody>{session.orders.slice(-20).reverse().map((order, index) => <tr key={`${order.tick}-${index}`}><td>{order.tick}</td><td>{strategyOrderModeLabel(order.mode, language)}</td><td>{order.action === 'cancel' ? text(language, `Cancel ${order.orderId}`, `撤销 ${order.orderId}`) : `${text(language, order.side === 'buy' ? 'Buy' : 'Sell', order.side === 'buy' ? '买入' : '卖出')} ${order.quantity} ${order.symbol}`}</td><td>{order.action === 'cancel' ? '—' : order.orderType === 'market' ? text(language, 'Market', '市价') : `${text(language, 'Limit', '限价')} ${order.price?.toFixed(1) ?? '—'}`}</td><td>{order.message}</td></tr>)}{session.orders.length === 0 && <tr><td colSpan={5} className="empty-row">{text(language, 'Strategy actions will appear here.', '策略产生的操作将显示在这里。')}</td></tr>}</tbody></table></div>
    </section>
  </div>;
}

function BookRows({ levels, side, onSelect, language }: { levels: BookLevel[]; side: Side; onSelect: (price: number) => void; language: Language }) {
  const rendered = side === 'sell' ? [...levels].reverse() : levels;
  return <div className={`book-half ${side}`}>{rendered.length === 0 ? <div className="empty-book">{text(language, `No confirmed ${side === 'buy' ? 'bids' : 'asks'}`, `暂无已确认${side === 'buy' ? '买单' : '卖单'}`)}</div> : rendered.map((level, index) => (
    <button className={`book-row ${level.hasPlayerOrder ? 'own' : ''}`} onClick={() => onSelect(level.price)} key={`${side}-${level.price}`} title={text(language, 'Prefill limit price', '填入限价')}>
      <span>{language === 'zh' ? `${side === 'buy' ? '买' : '卖'}${side === 'buy' ? index + 1 : rendered.length - index}` : side === 'buy' ? `B${index + 1}` : `A${rendered.length - index}`}</span><strong>{level.price.toFixed(1)}</strong><span>{level.quantity}</span><span>{language === 'zh' ? `${level.orderCount} 笔委托` : `${level.orderCount} order${level.orderCount === 1 ? '' : 's'}`}</span>{level.hasPlayerOrder && <i>{text(language, 'You', '我')}</i>}
    </button>
  ))}</div>;
}

function Setup({ config, setConfig, onLaunch, onWiki, language, setLanguage }: { config: MarketConfig; setConfig: (value: MarketConfig) => void; onLaunch: () => void; onWiki: () => void; language: Language; setLanguage: (value: Language) => void }) {
  const t = copy[language];
  const [feeUnit, setFeeUnit] = useState<'percent' | 'bps'>('percent');
  const feeToInput = (rate: number) => feeUnit === 'percent' ? rate * 100 : rate * 10_000;
  const update = <K extends keyof MarketConfig>(key: K, value: MarketConfig[K]) => setConfig({ ...config, [key]: value });
  const updateFee = (key: 'makerFeeRate' | 'takerFeeRate', value: number) => update(key, Math.max(0, feeUnit === 'percent' ? value / 100 : value / 10_000));
  return <main className="setup-page">
    <section className="setup-card">
      <header className="setup-brand"><div className="brand-mark" role="img" aria-label={text(language, 'Market chart', '行情图表')}>📈</div><div><h1>FinPub <span>｜金融酒馆</span></h1><p>{text(language, 'Local discrete-time exchange simulator · all matching happens in this browser', '本地离散时间交易所模拟器 · 所有撮合均在当前浏览器中完成')}</p></div><button className="ghost setup-wiki" onClick={onWiki}>{text(language, 'Wiki', '知识库')}</button><select aria-label={text(language, 'Language', '语言')} value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en">{text(language, 'English', '英文')}</option><option value="zh">中文</option></select></header>
      <div className="setup-title"><div><span className="eyebrow">{text(language, 'PRE-MARKET', '开市前')}</span><h2>{t.setup}</h2><p>{text(language, 'These values are locked once the exchange starts. Re-open this screen to create a new market.', '市场启动后将锁定这些参数。如需重新设置，请返回此页面创建一个新市场。')}</p></div><button className="ghost" onClick={() => setConfig(defaultConfig())}>{t.reset}</button></div>
      <div className="config-grid">
        <section><h3>{t.fees}</h3><label>{t.cash}<input min="0" step="100" type="number" value={config.playerCash} onChange={(e) => update('playerCash', Number(e.target.value))} /></label><label>{t.npc}<input min="20" max="200" type="number" value={config.npcCount} onChange={(e) => update('npcCount', Number(e.target.value))} /></label><label>{t.seed}<input min="1" type="number" value={config.seed} onChange={(e) => update('seed', Number(e.target.value))} /></label><label>{t.startTime}<input type="datetime-local" value={config.startTime} onChange={(e) => update('startTime', e.target.value)} /></label></section>
        <section><div className="fee-heading"><h3>{text(language, 'Trading fees', '交易手续费')}</h3><select value={feeUnit} onChange={(e) => setFeeUnit(e.target.value as 'percent' | 'bps')}><option value="percent">{text(language, 'Percent (%)', '百分比 (%)')}</option><option value="bps">{text(language, 'Basis points (bp)', '基点')}</option></select></div><label>{t.maker}<input min="0" step="0.01" type="number" value={feeToInput(config.makerFeeRate)} onChange={(e) => updateFee('makerFeeRate', Number(e.target.value))} /><small>{(config.makerFeeRate * 100).toFixed(4)}% · {(config.makerFeeRate * 10_000).toFixed(2)} {text(language, 'bp', '个基点')}</small></label><label>{t.taker}<input min="0" step="0.01" type="number" value={feeToInput(config.takerFeeRate)} onChange={(e) => updateFee('takerFeeRate', Number(e.target.value))} /><small>{(config.takerFeeRate * 100).toFixed(4)}% · {(config.takerFeeRate * 10_000).toFixed(2)} {text(language, 'bp', '个基点')}</small></label><label className="check"><input type="checkbox" checked={config.feesEnabled} onChange={(e) => update('feesEnabled', e.target.checked)} /> {t.enableFees}</label><aside className="hint">{text(language, 'A maker order rests in the book. Any order that takes existing liquidity is charged the taker rate, including a limit order.', '挂单方委托会留在订单簿中。任何吃掉现有流动性的委托都会按吃单方费率收费，包括限价单。')}</aside></section>
      </div>
      <section className="instrument-setup"><h3>{t.inventory} &amp; {t.prices}</h3><div className="instrument-form">{INSTRUMENTS.map((item) => <div className="instrument-input" key={item.symbol}><b>{item.symbol}</b><span>{instrumentName(item.symbol, language)}</span><label>{text(language, 'Position', '持仓')}<input min="0" step="1" type="number" value={config.playerPositions[item.symbol]} onChange={(e) => setConfig({ ...config, playerPositions: { ...config.playerPositions, [item.symbol]: Math.max(0, Math.floor(Number(e.target.value))) } })} /></label><label>{text(language, 'Price', '价格')}<input min={item.tickSize} step={item.tickSize} type="number" value={config.initialPrices[item.symbol]} onChange={(e) => setConfig({ ...config, initialPrices: { ...config.initialPrices, [item.symbol]: Math.max(item.tickSize, Number(e.target.value)) } })} /></label></div>)}</div></section>
      <footer className="setup-footer"><p>{text(language, 'NPCs have unlimited virtual cash and inventory for quoting, while their virtual ledger still marks every fill, fee, P&L and position.', '交易者拥有无限的虚拟现金和库存以提供报价；其虚拟账本仍会记录每一笔成交、手续费、盈亏和持仓。')}</p><button className="primary launch" onClick={onLaunch}>{t.start} <span>→</span></button></footer>
    </section>
  </main>;
}

function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [page, setPage] = useState<'exchange' | 'wiki'>(() => window.location.hash === '#wiki' ? 'wiki' : 'exchange');
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
  const [strategyCode, setStrategyCode] = useState(DEFAULT_STRATEGY_CODE);
  const [strategyEnabled, setStrategyEnabled] = useState(false);
  const [strategyDryRun, setStrategyDryRun] = useState(true);
  const [strategyStatus, setStrategyStatus] = useState(text('en', 'Ready', '已就绪'));
  const [, setStrategyVersion] = useState(0);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const clockRef = useRef(performance.now());
  const [frame, setFrame] = useState(performance.now());
  const marketRef = useRef<Market | null>(null);
  const strategySessionRef = useRef<StrategySession>(createStrategySession());
  const strategyRunnerRef = useRef<PythonStrategyRunner | null>(null);
  const advancingRef = useRef(false);
  const strategyCodeRef = useRef(strategyCode);
  const strategySettingsRef = useRef({ enabled: strategyEnabled, dryRun: strategyDryRun });
  const languageRef = useRef(language);
  const t = copy[language];
  const money = (value: number): string => formatMoney(value, language);

  const openWiki = () => { window.location.hash = 'wiki'; setPage('wiki'); };
  const closeWiki = () => { window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`); setPage('exchange'); };

  useEffect(() => { marketRef.current = market; }, [market]);
  useEffect(() => { const syncPage = () => setPage(window.location.hash === '#wiki' ? 'wiki' : 'exchange'); window.addEventListener('hashchange', syncPage); return () => window.removeEventListener('hashchange', syncPage); }, []);
  useEffect(() => { strategyCodeRef.current = strategyCode; }, [strategyCode]);
  useEffect(() => { strategySettingsRef.current = { enabled: strategyEnabled, dryRun: strategyDryRun }; }, [strategyEnabled, strategyDryRun]);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => () => strategyRunnerRef.current?.dispose(), []);
  useEffect(() => { setFeedback(text(language, 'Choose a visible price, then queue an order for the next auction.', '请选择可见订单簿中的价格，再提交委托到下一次撮合。')); }, [language]);

  const resetStrategySession = (activeMarket?: Market) => {
    const session = createStrategySession();
    if (activeMarket) {
      for (const instrument of INSTRUMENTS) session.lastVolume[instrument.symbol] = activeMarket.assets[instrument.symbol].volume;
    }
    strategySessionRef.current = session;
    setStrategyVersion((version) => version + 1);
    setStrategyStatus(text(languageRef.current, 'Ready', '已就绪'));
  };

  const runStrategyBar = async (activeMarket: Market) => {
    const session = strategySessionRef.current;
    const context = buildStrategyContext(activeMarket, session);
    const started = performance.now();
    const currentLanguage = languageRef.current;
    setStrategyStatus(text(currentLanguage, 'Running Python strategy…', '正在运行 Python 策略…'));
    try {
      if (!strategyRunnerRef.current) strategyRunnerRef.current = new PythonStrategyRunner();
      const response = await strategyRunnerRef.current.run(strategyCodeRef.current, context);
      if (!response.ok) {
        session.runs.push({ simTime: context.sim_time, tick: context.tick, barIndex: context.bar_index, modelVersion: MODEL_VERSION, status: 'error', durationMs: response.durationMs, orderCount: 0, message: response.error, intentsJson: '[]' });
        setStrategyStatus(text(currentLanguage, 'Strategy error', '策略执行出错'));
        return;
      }
      const normalized = normalizeStrategyIntents(response.result);
      if (normalized.error) {
        session.runs.push({ simTime: context.sim_time, tick: context.tick, barIndex: context.bar_index, modelVersion: MODEL_VERSION, status: 'error', durationMs: response.durationMs, orderCount: 0, message: normalized.error, intentsJson: JSON.stringify(response.result) });
        setStrategyStatus(text(currentLanguage, 'Strategy output rejected', '策略输出被拒绝'));
        return;
      }
      const actions = expandStrategyIntents(activeMarket, normalized.intents);
      const recordAction = (action: StrategyAction, mode: 'dry_run' | 'queued' | 'cancel_requested' | 'rejected', message: string) => {
        if (action.action === 'cancel') {
          session.orders.push({ simTime: context.sim_time, tick: context.tick, barIndex: context.bar_index, mode, action: 'cancel', orderId: action.orderId, message });
          return;
        }
        session.orders.push({ simTime: context.sim_time, tick: context.tick, barIndex: context.bar_index, mode, action: 'order', side: action.side, symbol: action.symbol, orderType: action.type, quantity: action.quantity, price: action.price ?? null, message });
      };
      for (const action of actions) {
        const validationError = validateStrategyAction(activeMarket, action);
        if (validationError) {
          recordAction(action, 'rejected', validationError);
          continue;
        }
        if (strategySettingsRef.current.dryRun) {
          recordAction(action, 'dry_run', action.action === 'cancel' ? 'Validated only; no cancellation was requested.' : 'Validated only; no market order was queued.');
          continue;
        }
        if (action.action === 'cancel') {
          const cancelled = requestCancel(activeMarket, action.orderId);
          recordAction(action, cancelled.ok ? 'cancel_requested' : 'rejected', cancelled.message);
          continue;
        }
        const queued = queuePlayerOrder(activeMarket, { symbol: action.symbol, side: action.side, type: action.type, quantity: action.quantity, limitPrice: action.price });
        recordAction(action, queued.ok ? 'queued' : 'rejected', queued.message);
      }
      const requestedCancelAll = normalized.intents.filter((intent) => intent.action === 'cancel_all').length;
      const dryRunMessage = actions.length === 0 && requestedCancelAll > 0 ? 'Validated cancel_all; no matching open orders.' : `Validated ${actions.length} action${actions.length === 1 ? '' : 's'} in dry-run mode.`;
      const liveMessage = actions.length === 0 && requestedCancelAll > 0 ? 'cancel_all found no matching open orders.' : `${actions.length} action${actions.length === 1 ? '' : 's'} queued for the next auction.`;
      session.runs.push({ simTime: context.sim_time, tick: context.tick, barIndex: context.bar_index, modelVersion: MODEL_VERSION, status: 'ok', durationMs: response.durationMs, orderCount: actions.length, message: strategySettingsRef.current.dryRun ? dryRunMessage : liveMessage, intentsJson: JSON.stringify(normalized.intents) });
      setStrategyStatus(text(currentLanguage, `Last run: T${context.tick}`, `最近执行：第 ${context.tick} 轮`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.runs.push({ simTime: context.sim_time, tick: context.tick, barIndex: context.bar_index, modelVersion: MODEL_VERSION, status: 'error', durationMs: Math.round(performance.now() - started), orderCount: 0, message, intentsJson: '[]' });
      setStrategyStatus(text(currentLanguage, 'Strategy error', '策略执行出错'));
    } finally {
      setStrategyVersion((version) => version + 1);
    }
  };

  const advanceSimulation = async (ticks: number) => {
    const activeMarket = marketRef.current;
    if (!activeMarket || advancingRef.current || ticks <= 0) return;
    advancingRef.current = true;
    setIsAdvancing(true);
    try {
      for (let count = 0; count < ticks; count += 1) {
        advanceTick(activeMarket);
        if (strategySettingsRef.current.enabled && activeMarket.tick % STRATEGY_BAR_TICKS === 0) await runStrategyBar(activeMarket);
      }
      setMarket({ ...activeMarket });
    } finally {
      clockRef.current = performance.now();
      advancingRef.current = false;
      setIsAdvancing(false);
      setFrame(performance.now());
    }
  };

  useEffect(() => {
    if (!market || !running) return undefined;
    clockRef.current = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now - clockRef.current >= 1000 && marketRef.current && !advancingRef.current) {
        const elapsedTicks = Math.floor((now - clockRef.current) / 1000);
        clockRef.current += elapsedTicks * 1000;
        void advanceSimulation(elapsedTicks);
      }
      setFrame(now);
    }, 60);
    return () => window.clearInterval(timer);
  }, [market, running]);

  const launch = () => { const next = createMarket(draft); marketRef.current = next; resetStrategySession(next); setMarket(next); setRunning(true); setSelectedSymbol('BDX'); setFeedback(text(language, 'Market opened. The first auction occurs in one second.', '市场已启动，首次撮合将在一秒后进行。')); };
  if (page === 'wiki') return <WikiPage language={language} setLanguage={setLanguage} onBack={closeWiki} />;
  if (!market) return <Setup config={draft} setConfig={setDraft} onLaunch={launch} onWiki={openWiki} language={language} setLanguage={setLanguage} />;

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
  const cachedRecordCount = market.trades.length + market.snapshots.length + market.participantSnapshots.length + market.portfolioSnapshots.length + market.events.length
    + Object.keys(market.orders).length + Object.values(market.assets).reduce((total, current) => total + current.priceHistory.length, 0);

  const choosePrice = (price: number) => { setOrderType('limit'); setSelectedPrice(price); setFeedback(text(language, `Limit price prefilled at ${price.toFixed(1)}. Review quantity before queueing.`, `已填入限价 ${price.toFixed(1)}。提交前请确认数量。`)); };
  const submitOrder = () => {
    const result = queuePlayerOrder(market, { symbol: selectedSymbol, side, type: orderType, quantity, limitPrice: selectedPrice });
    setFeedback(feedbackText(result.message, language));
    setMarket({ ...market });
  };
  const cancel = (id: string) => { const result = requestCancel(market, id); setFeedback(feedbackText(result.message, language)); setMarket({ ...market }); };
  const clearCache = () => {
    const confirmed = window.confirm(text(language, 'Clear accumulated trades, completed orders, snapshots, event timeline and chart history? Current balances, positions, active orders and live order books will be preserved. Exported CSV files will contain only records collected after this cleanup.', '确定清除累计成交、已完成委托、快照、事件时间线和图表历史吗？当前余额、持仓、有效委托和实时订单簿将被保留。之后导出的数据只包含本次清理后的记录。'));
    if (!confirmed) return;
    const result = clearAccumulatedData(market);
    resetStrategySession(market);
    setFeedback(text(language, `Cache cleared: ${result.recordsRemoved.toLocaleString()} history records and ${result.ordersRemoved.toLocaleString()} completed orders removed.`, `缓存已清除：${result.recordsRemoved.toLocaleString(locale(language))} 条历史记录，以及 ${result.ordersRemoved.toLocaleString(locale(language))} 笔已完成委托。`));
    setMarket({ ...market });
  };
  const downloadPythonReplay = () => {
    downloadStrategyPackage({ config: market.config, simStartMs: market.simStartMs, code: strategyCode, dryRun: strategyDryRun, ticks: Math.max(100, market.tick) });
    setFeedback(text(language, 'Python replay package downloaded. Run python run.py inside the extracted folder.', 'Python 回放包已下载。解压后在目录内执行 python run.py。'));
  };
  const changePct = asset.previousClose ? (asset.lastPrice - asset.previousClose) / asset.previousClose : 0;
  const pnlClass = (value: number) => value >= 0 ? 'positive' : 'negative';

  return <main className="terminal">
    <header className="topbar">
      <div className="wordmark"><div className="brand-mark" role="img" aria-label={text(language, 'Market chart', '行情图表')}>📈</div><div><b>FinPub</b><span>金融酒馆 · {text(language, 'Local Exchange', '本地交易所')}</span></div></div>
      <div className={`status ${running ? 'live' : 'halted'}`}><i />{running ? t.running : t.paused}</div>
      <div className="top-stat"><span>{text(language, 'SIMULATION TIME', '模拟时间')}</span><b>{new Date(market.simStartMs + market.tick * 1000).toLocaleString(locale(language))}</b></div>
      <div className="top-stat countdown"><span>{t.next}</span><b>{running ? `${(nextMs / 1000).toFixed(2)}s` : text(language, 'Paused', '已暂停')}</b></div>
      <div className="top-stat"><span>{text(language, 'NPCs', '交易者')}</span><b>{market.config.npcCount}</b></div>
      <div className="top-stat"><span>{text(language, 'SEED', '种子')}</span><b>{market.config.seed}</b></div>
      <div className="top-actions"><button onClick={openWiki}>{text(language, 'Wiki', '知识库')}</button><button onClick={() => setRunning(!running)}>{running ? t.pause : t.resume}</button><button disabled={isAdvancing} onClick={() => void advanceSimulation(25)}>{isAdvancing ? text(language, 'Advancing…', '正在加速…') : t.accelerate}</button><button onClick={() => { const restarted = createMarket(market.config); marketRef.current = restarted; resetStrategySession(restarted); setMarket(restarted); setRunning(true); setFeedback(text(language, 'Market restarted from the locked initialization settings.', '市场已按锁定的初始化参数重新开始。')); }}>{t.restart}</button><button onClick={() => { resetStrategySession(); setDraft(market.config); setMarket(null); }}>{text(language, 'Reconfigure', '重新配置')}</button><button className="danger-action" onClick={clearCache} title={text(language, `${cachedRecordCount.toLocaleString()} in-memory records`, `${cachedRecordCount.toLocaleString(locale(language))} 条内存记录`)}>{t.clearCache}</button><button className="accent" onClick={() => exportMarketData(market, strategySessionRef.current)}>{t.export}</button><select aria-label={text(language, 'Language', '语言')} value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en">{text(language, 'English', '英文')}</option><option value="zh">中文</option></select></div>
    </header>
    {market.latestEvent && <section className={`event-banner ${market.latestEvent.direction}`}><span className="event-kicker">{text(language, `LATEST EVENT · T${market.latestEvent.tick}`, `最新事件 · 第 ${market.latestEvent.tick} 轮`)}</span><b>{eventTitle(market.latestEvent.title, language)}</b><span>{market.latestEvent.direction === 'bullish' ? '▲' : '▼'} {text(language, market.latestEvent.direction === 'bullish' ? 'BULLISH' : 'BEARISH', market.latestEvent.direction === 'bullish' ? '利好' : '利空')} · {market.latestEvent.symbols.join(', ')}</span><small>{eventDescription(market.latestEvent.direction, language)}</small></section>}
    <div className="workspace">
      <aside className="instrument-list panel"><div className="panel-title"><span>{text(language, 'INSTRUMENTS', '交易品种')}</span><small>{text(language, '6 listed wines & spirits', '6 种已上市酒类')}</small></div>{INSTRUMENTS.map((item) => { const state = market.assets[item.symbol]; const pctChange = (state.lastPrice - state.previousClose) / state.previousClose; const flagged = market.latestEvent?.symbols.includes(item.symbol); return <button key={item.symbol} className={`instrument ${selectedSymbol === item.symbol ? 'selected' : ''}`} onClick={() => { setSelectedSymbol(item.symbol); setSelectedPrice(undefined); }}><div><span className="symbol">{item.symbol}{flagged && <i className="event-dot" />}</span><strong>{state.lastPrice.toFixed(1)}</strong></div><div><span>{instrumentName(item.symbol, language)}</span><em className={pnlClass(pctChange)}>{pct(pctChange)}</em></div><Sparkline points={state.priceHistory} language={language} /><small>{text(language, `Vol ${state.volume.toLocaleString()}`, `成交量 ${state.volume.toLocaleString(locale(language))}`)}</small></button>; })}</aside>
      <section className="market-center">
        <section className="instrument-header panel"><div><span className="eyebrow">{instrumentCategory(selectedSymbol, language).toUpperCase()} · {asset.definition.symbol}</span><h1>{instrumentName(selectedSymbol, language)}</h1></div><div className="last-price"><b>{asset.lastPrice.toFixed(1)}</b><span className={pnlClass(changePct)}>{pct(changePct)} {text(language, 'vs initial', '相对初始价')}</span></div><div className="quote-grid"><div><span>{text(language, 'BEST BID', '最优买价')}</span><b className="positive">{formatPrice(quotes.bestBid)}</b></div><div><span>{text(language, 'BEST ASK', '最优卖价')}</span><b className="negative">{formatPrice(quotes.bestAsk)}</b></div><div><span>{text(language, 'MID', '中间价')}</span><b>{formatPrice(quotes.mid)}</b></div><div><span>{text(language, 'SPREAD', '价差')}</span><b>{formatPrice(quotes.spread)}</b></div></div></section>
        <section className="panel chart-panel"><div className="panel-title"><span>{text(language, 'EXECUTED PRICE HISTORY', '成交价格走势')}</span><small>{text(language, `actual fills only · Fair value ${asset.fairValue.toFixed(1)}`, `仅实际成交 · 公允价值 ${asset.fairValue.toFixed(1)}`)}</small></div><TradeChart market={market} symbol={selectedSymbol} language={language} /></section>
        <section className="book-panel panel"><div className="panel-title"><span>{t.orderBook}</span><small>{text(language, `${market.pendingOrderIds.length} queued · ${userPending} yours waiting`, `${market.pendingOrderIds.length} 笔待撮合 · ${userPending} 笔为你的待处理委托`)}</small></div><div className="book-label"><span>{text(language, 'LEVEL / PRICE', '档位 / 价格')}</span><span>{text(language, 'QUANTITY / ORDERS', '数量 / 委托数')}</span></div><BookRows levels={asks} side="sell" onSelect={choosePrice} language={language} /><div className="mid-strip">{text(language, 'MID', '中间价')} {formatPrice(quotes.mid)} · {text(language, 'SPREAD', '价差')} {formatPrice(quotes.spread)} <small>{text(language, 'Click a level to prefill only', '点击档位仅填入价格')}</small></div><BookRows levels={bids} side="buy" onSelect={choosePrice} language={language} /></section>
      </section>
      <aside className="right-rail">
        <section className="order-panel panel"><div className="panel-title"><span>{text(language, 'ORDER ENTRY', '委托下单')}</span><small>{asset.definition.symbol} · {text(language, 'tick', '最小变动单位')} {asset.definition.tickSize}</small></div><div className="switch"><button className={side === 'buy' ? 'active buy' : ''} onClick={() => setSide('buy')}>{t.bid}</button><button className={side === 'sell' ? 'active sell' : ''} onClick={() => setSide('sell')}>{t.ask}</button></div><div className="switch compact"><button className={orderType === 'limit' ? 'active' : ''} onClick={() => setOrderType('limit')}>{t.limit}</button><button className={orderType === 'market' ? 'active' : ''} onClick={() => setOrderType('market')}>{t.market}</button></div>{orderType === 'limit' ? <div className="price-picker"><label>{text(language, 'Price — select from visible top five', '价格 — 请从可见的五档报价中选择')}</label><div>{[...bids, ...asks].map((level) => <button onClick={() => choosePrice(level.price)} className={selectedPrice === level.price ? 'chosen' : ''} key={level.price}>{level.price.toFixed(1)}</button>)}</div><strong>{selectedPrice ? text(language, `${selectedPrice.toFixed(1)} 酒币 selected`, `${selectedPrice.toFixed(1)} 酒币已选择`) : text(language, 'No price selected', '尚未选择价格')}</strong></div> : <div className="market-estimate"><span>{text(language, 'Market order estimate', '市价单估算')}</span><b>{selectedMarket.firstPrice ? text(language, `Starting from ${selectedMarket.firstPrice.toFixed(1)}`, `起始价格 ${selectedMarket.firstPrice.toFixed(1)}`) : text(language, 'No opposing quote', '暂无对手方报价')}</b><small>{text(language, 'Unfilled quantity cancels at auction close.', '未成交的剩余数量将在本轮撮合结束时撤销。')}</small></div>}<label className="qty-label">{t.quantity}<input min="1" step="1" type="number" value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))} /></label><div className="order-summary"><div><span>{text(language, 'Estimated gross', '预计成交额')}</span><b>{money(estimateGross)}</b></div><div><span>{text(language, 'Estimated fee', '预计手续费')}</span><b>{money(estimateFee)}</b></div><div><span>{side === 'buy' ? text(language, 'Maximum outlay', '最高支出') : text(language, 'Estimated net receipt', '预计净收入')}</span><b>{money(estimateTotal)}</b></div><small>{text(language, `Possible rate: maker ${(market.config.feesEnabled ? market.config.makerFeeRate * 100 : 0).toFixed(3)}% / taker ${(market.config.feesEnabled ? market.config.takerFeeRate * 100 : 0).toFixed(3)}%`, `可能采用的费率：挂单方 ${(market.config.feesEnabled ? market.config.makerFeeRate * 100 : 0).toFixed(3)}% / 吃单方 ${(market.config.feesEnabled ? market.config.takerFeeRate * 100 : 0).toFixed(3)}%`)}</small><small>{side === 'buy' ? text(language, `Available cash: ${money(player.cash - player.reservedCash)}`, `可用现金：${money(player.cash - player.reservedCash)}`) : text(language, `Available ${selectedSymbol}: ${position.quantity - position.reserved}`, `可用 ${selectedSymbol}：${position.quantity - position.reserved}`)}</small></div><button className={`primary submit ${side}`} disabled={!running} onClick={submitOrder}>{side === 'buy' ? t.submitBuy : t.submitSell}</button><p className="feedback">{feedback}</p></section>
        <section className="account-panel panel"><div className="panel-title"><span>{t.account}</span><small>{text(language, `${selectedSymbol} ${position.quantity} held · ${position.reserved} frozen`, `${selectedSymbol} 持有 ${position.quantity} · 冻结 ${position.reserved}`)}</small></div><div className="account-grid"><div><span>{t.totalCash}</span><b>{money(player.cash)}</b></div><div><span>{t.availableCash}</span><b>{money(player.cash - player.reservedCash)}</b></div><div><span>{t.frozenCash}</span><b>{money(player.reservedCash)}</b></div><div><span>{t.holdings}</span><b>{money(playerMetrics.positionValue)}</b></div><div><span>{t.assets}</span><b>{money(playerMetrics.totalAsset)}</b></div><div><span>{t.realized}</span><b className={pnlClass(player.realizedPnl)}>{formatPnl(player.realizedPnl)}</b></div><div><span>{t.unrealized}</span><b className={pnlClass(playerMetrics.unrealized)}>{formatPnl(playerMetrics.unrealized)}</b></div><div><span>{t.feesPaid}</span><b>{money(player.makerFees + player.takerFees)}</b></div></div><p className="fee-detail">{t.maker} {money(player.makerFees)} · {t.taker} {money(player.takerFees)}</p></section>
      </aside>
    </div>
    <section className="bottom panel">
      <div className="tabs">{(['trades', 'orders', 'positions', 'portfolio', 'strategy', 'events', 'npcs'] as BottomTab[]).map((name) => <button className={tab === name ? 'active' : ''} onClick={() => setTab(name)} key={name}>{({ trades: t.trades, orders: t.orders, positions: t.positions, portfolio: t.portfolio, strategy: t.strategy, events: t.events, npcs: t.npcs })[name]}</button>)}</div>
      {tab === 'trades' && <div className="table-wrap"><table><thead><tr><th>{text(language, 'Time', '时间')}</th><th>{text(language, 'Symbol', '代码')}</th><th>{text(language, 'Price', '价格')}</th><th>{text(language, 'Qty', '数量')}</th><th>{text(language, 'Aggressor', '主动方')}</th><th>{text(language, 'Your role', '我的角色')}</th><th>{text(language, 'Rate', '费率')}</th><th>{text(language, 'Gross', '成交额')}</th><th>{text(language, 'Your fee', '我的手续费')}</th><th>{text(language, 'Your net cash', '我的净现金变动')}</th></tr></thead><tbody>{market.trades.slice(0, 30).map((trade) => { const playerSide = trade.buyerId === 'player' ? 'buy' : trade.sellerId === 'player' ? 'sell' : null; const role = trade.makerId === 'player' ? 'maker' : trade.takerId === 'player' ? 'taker' : null; const playerRate = role === 'maker' ? market.config.makerFeeRate : role === 'taker' ? market.config.takerFeeRate : null; const fee = trade.buyerId === 'player' ? trade.buyerFee : trade.sellerId === 'player' ? trade.sellerFee : 0; const cashChange = trade.buyerId === 'player' ? trade.buyerCashChange : trade.sellerId === 'player' ? trade.sellerCashChange : 0; return <tr key={trade.id}><td>{new Date(trade.simTime).toLocaleTimeString(locale(language))}</td><td>{trade.symbol}</td><td>{trade.price.toFixed(1)}</td><td>{trade.quantity}</td><td className={trade.aggressorSide === 'buy' ? 'positive' : 'negative'}>{text(language, trade.aggressorSide.toUpperCase(), trade.aggressorSide === 'buy' ? '买入' : '卖出')}</td><td>{role ? text(language, role === 'maker' ? 'Maker' : 'Taker', role === 'maker' ? '挂单方' : '吃单方') : '—'}{playerSide && ` · ${text(language, playerSide, playerSide === 'buy' ? '买入' : '卖出')}`}</td><td>{playerRate === null ? '—' : `${(playerRate * 100).toFixed(3)}%`}</td><td>{money(trade.grossAmount)}</td><td>{playerSide ? money(fee) : '—'}</td><td className={cashChange >= 0 ? 'positive' : 'negative'}>{playerSide ? formatPnl(cashChange) : '—'}</td></tr>; })}{market.trades.length === 0 && <tr><td colSpan={10} className="empty-row">{text(language, 'No executions yet. NPC liquidity is confirmed in the book; transactions appear here after auctions.', '暂未成交。交易者流动性已在订单簿中确认，成交将在撮合后显示在这里。')}</td></tr>}</tbody></table></div>}
      {tab === 'orders' && <div className="table-wrap"><table><thead><tr><th>{text(language, 'ID', '编号')}</th><th>{text(language, 'Symbol', '代码')}</th><th>{text(language, 'Side', '方向')}</th><th>{text(language, 'Type', '类型')}</th><th>{t.limit}</th><th>{text(language, 'Original', '原始数量')}</th><th>{text(language, 'Remaining', '剩余数量')}</th><th>{text(language, 'Status', '状态')}</th><th /></tr></thead><tbody>{userOrders.map((order) => <tr key={order.id}><td>{order.id}</td><td>{order.symbol}</td><td className={order.side === 'buy' ? 'positive' : 'negative'}>{text(language, order.side.toUpperCase(), order.side === 'buy' ? '买入' : '卖出')}</td><td>{order.type === 'limit' ? t.limit : t.market}</td><td>{formatPrice(order.limitPrice)}</td><td>{order.quantity}</td><td>{order.remaining}</td><td><span className={`order-status ${order.status}`}>{statusLabel(order.status, language)}</span></td><td>{['queued', 'open', 'partial'].includes(order.status) && <button className="cancel" onClick={() => cancel(order.id)}>{text(language, 'Cancel', '撤单')}</button>}</td></tr>)}{userOrders.length === 0 && <tr><td colSpan={9} className="empty-row">{text(language, 'Your queued and confirmed orders will appear here.', '你提交和已确认的委托将显示在这里。')}</td></tr>}</tbody></table></div>}
      {tab === 'positions' && <div className="table-wrap"><table><thead><tr><th>{text(language, 'Symbol', '代码')}</th><th>{text(language, 'Position', '持仓')}</th><th>{text(language, 'Available', '可用数量')}</th><th>{text(language, 'Average cost', '平均成本')}</th><th>{text(language, 'Last', '最新价')}</th><th>{text(language, 'Market value', '市值')}</th><th>{text(language, 'Unrealized P&L', '未实现盈亏')}</th></tr></thead><tbody>{INSTRUMENTS.map((item) => { const holding = player.positions[item.symbol]; const last = market.assets[item.symbol].lastPrice; const upnl = holding.quantity * (last - holding.averageCost); return <tr key={item.symbol}><td><b>{item.symbol}</b> <small>{instrumentName(item.symbol, language)}</small></td><td>{holding.quantity}</td><td>{holding.quantity - holding.reserved}</td><td>{holding.averageCost.toFixed(1)}</td><td>{last.toFixed(1)}</td><td>{money(holding.quantity * last)}</td><td className={pnlClass(upnl)}>{formatPnl(upnl)} · {text(language, upnl >= 0 ? 'Profit' : 'Loss', upnl >= 0 ? '盈利' : '亏损')}</td></tr>; })}</tbody></table></div>}
      {tab === 'portfolio' && <PortfolioHistory market={market} language={language} />}
      {tab === 'strategy' && <StrategyPanel language={language} code={strategyCode} onCodeChange={setStrategyCode} onReset={() => setStrategyCode(DEFAULT_STRATEGY_CODE)} enabled={strategyEnabled} setEnabled={setStrategyEnabled} dryRun={strategyDryRun} setDryRun={setStrategyDryRun} status={strategyStatus} session={strategySessionRef.current} onDownloadPackage={downloadPythonReplay} />}
      {tab === 'events' && <div className="timeline">{market.events.map((event) => <article className={event.direction} key={event.id}><time>{text(language, `T${event.tick}`, `第 ${event.tick} 轮`)} · {new Date(event.simTime).toLocaleTimeString(locale(language))}</time><div><b>{eventTitle(event.title, language)}</b><p>{eventDescription(event.direction, language)}</p><span>{event.symbols.join(', ')} · {event.direction === 'bullish' ? '▲' : '▼'} {text(language, event.direction === 'bullish' ? 'Bullish' : 'Bearish', event.direction === 'bullish' ? '利好' : '利空')} · {text(language, `initial impact ${(event.impact * 100).toFixed(1)}%`, `初始影响 ${(event.impact * 100).toFixed(1)}%`)}</span></div></article>)}{market.events.length === 0 && <div className="empty-row">{text(language, `The next deterministic event is scheduled for T${market.nextEventTick}. Events affect valuation and decisions, never last price directly.`, `下一条确定性事件将在第 ${market.nextEventTick} 轮触发。事件只影响估值和交易者决策，不会直接修改最新成交价。`)}</div>}</div>}
      {tab === 'npcs' && <div className="npc-layout"><div className="table-wrap npc-table"><table><thead><tr><th>{text(language, 'NPC', '交易者')}</th><th>{text(language, 'Style', '策略')}</th><th>{text(language, 'Total P&L', '总盈亏')}</th><th>{text(language, 'Realized', '已实现')}</th><th>{text(language, 'Unrealized', '未实现')}</th><th>{text(language, 'Fees', '手续费')}</th><th>{text(language, 'Trades', '成交笔数')}</th><th>{text(language, 'Net pos.', '净持仓')}</th></tr></thead><tbody>{npcRows.map(({ account, metrics }) => <tr className={selectedNpc === account.id ? 'selected-row' : ''} onClick={() => setSelectedNpc(account.id)} key={account.id}><td>{accountName(account, language)}</td><td>{styleLabel(account.style, language)}</td><td className={pnlClass(metrics.totalPnl)}>{formatPnl(metrics.totalPnl)} · {text(language, metrics.totalPnl >= 0 ? 'Profit' : 'Loss', metrics.totalPnl >= 0 ? '盈利' : '亏损')}</td><td className={pnlClass(account.realizedPnl)}>{formatPnl(account.realizedPnl)}</td><td className={pnlClass(metrics.unrealized)}>{formatPnl(metrics.unrealized)}</td><td>{money(account.makerFees + account.takerFees)}</td><td>{account.tradeCount}</td><td>{metrics.netPosition >= 0 ? '+' : ''}{metrics.netPosition}</td></tr>)}</tbody></table></div>{visibleNpc && <aside className="npc-detail"><span className="eyebrow">{text(language, 'VIRTUAL LEDGER', '虚拟账本')}</span><h3>{accountName(visibleNpc, language)}</h3><p>{styleLabel(visibleNpc.style, language)} · {text(language, 'unlimited quoting capacity', '无限报价能力')}</p><div><span>{text(language, 'Cash balance', '现金余额')}</span><b>{money(visibleNpc.cash)}</b></div><div><span>{text(language, 'Total assets', '总资产')}</span><b>{money(accountMetrics(market, visibleNpc).totalAsset)}</b></div><div><span>{text(language, 'Maker / Taker fees', '挂单方 / 吃单方手续费')}</span><b>{money(visibleNpc.makerFees)} / {money(visibleNpc.takerFees)}</b></div><h4>{text(language, 'Positions', '持仓')}</h4>{INSTRUMENTS.map((item) => <div key={item.symbol}><span>{item.symbol}</span><b>{visibleNpc.positions[item.symbol].quantity >= 0 ? '+' : ''}{visibleNpc.positions[item.symbol].quantity} @ {visibleNpc.positions[item.symbol].averageCost.toFixed(1)}</b></div>)}<h4>{text(language, 'Recent trades', '最近成交')}</h4>{market.trades.filter((trade) => trade.buyerId === visibleNpc.id || trade.sellerId === visibleNpc.id).slice(0, 5).map((trade) => <p className="npc-trade" key={trade.id}>{trade.symbol} {text(language, trade.buyerId === visibleNpc.id ? 'bought' : 'sold', trade.buyerId === visibleNpc.id ? '买入' : '卖出')} {trade.quantity} @ {trade.price.toFixed(1)} · {text(language, trade.makerId === visibleNpc.id ? 'Maker' : 'Taker', trade.makerId === visibleNpc.id ? '挂单方' : '吃单方')}</p>)}</aside>}</div>}
    </section>
    <footer className="terminal-footer"><span>{text(language, 'Discrete 1-second auction · price/time priority · full depth held internally, five levels displayed', '每秒离散撮合 · 价格优先、时间优先 · 内部保留完整深度，界面仅展示五档')}</span><span className="maintenance">{text(language, `In-memory cache: ${cachedRecordCount.toLocaleString()} records`, `内存缓存：${cachedRecordCount.toLocaleString(locale(language))} 条记录`)} · <button onClick={clearCache}>{t.clearCache}</button> · <button onClick={() => exportMarketData(market, strategySessionRef.current)}>{text(language, 'Download all CSV data', '下载全部数据')}</button></span></footer>
  </main>;
}

export default App;

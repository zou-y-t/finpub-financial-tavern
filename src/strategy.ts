import { INSTRUMENTS, accountMetrics, estimateMarketOrder, getBookLevels, getQuotes } from './market.ts';
import type { Market, Side } from './types.ts';

export const STRATEGY_BAR_TICKS = 5;
export const STRATEGY_ORDERBOOK_HISTORY_TICKS = 50;
export const STRATEGY_MAX_ORDERS_PER_BAR = 3;
export const STRATEGY_MAX_ACTIONS_PER_BAR = 6;
export const STRATEGY_MAX_QUANTITY = 25;
export const MODEL_VERSION = 'signal_v1';

export const DEFAULT_STRATEGY_CODE = `# FinPub strategy API: return a list of actions from on_bar(ctx).
# buy/sell with a price submits a limit order; omit price for a market order.
# cancel(order_id) requests cancellation on the next auction. Dry run is on by default.
# This default strategy trades BDX only when the tiny signal model is confident.

def on_bar(ctx):
    bdx = ctx["assets"]["BDX"]
    prediction = bdx["model"]["up_probability"]
    ask = bdx["book"]["best_ask"]
    bid = bdx["book"]["best_bid"]
    available = bdx["position"]["available"]

    if prediction >= 0.62 and ask is not None:
        return [buy("BDX", quantity=1, price=ask)]

    if prediction <= 0.38 and available >= 1 and bid is not None:
        return [sell("BDX", quantity=1, price=bid)]

    return []
`;

export interface StrategyOrderIntent {
  action: 'order';
  side: Side;
  symbol: string;
  quantity: number;
  type: 'limit' | 'market';
  price?: number;
}

export interface StrategyCancelIntent {
  action: 'cancel';
  orderId: string;
}

export interface StrategyCancelAllIntent {
  action: 'cancel_all';
  symbol?: string;
  side?: Side;
}

export type StrategyIntent = StrategyOrderIntent | StrategyCancelIntent | StrategyCancelAllIntent;
export type StrategyAction = StrategyOrderIntent | StrategyCancelIntent;

export interface StrategyBookLevel {
  level: number;
  price: number | null;
  volume: number;
}

export interface StrategyLiveBookLevel extends StrategyBookLevel {
  order_count: number;
  oldest_order_age_ticks: number | null;
  newest_order_age_ticks: number | null;
  average_order_age_ticks: number | null;
}

export interface StrategyOrderBookTick {
  sim_time: string;
  tick: number;
  bids: StrategyBookLevel[];
  asks: StrategyBookLevel[];
  aggressive_buy_volume: number;
  aggressive_sell_volume: number;
  aggressive_buy_trades: number;
  aggressive_sell_trades: number;
}

export interface StrategyOrderFlowWindow {
  aggressive_buy_volume: number;
  aggressive_sell_volume: number;
  aggressive_buy_trades: number;
  aggressive_sell_trades: number;
}

export interface StrategyBarSnapshot {
  simTime: string;
  tick: number;
  barIndex: number;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  bidQuantity: number;
  askQuantity: number;
  fairValue: number;
  fairValueGap: number;
  momentum1: number;
  momentum5: number;
  bookImbalance: number;
  spreadBps: number;
  eventSignal: number;
  upProbability: number;
  expectedReturn: number;
  positionQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  averageCost: number;
  accountCash: number;
  accountAvailableCash: number;
  accountFrozenCash: number;
  accountTotalAsset: number;
  accountPositionValue: number;
  accountUnrealizedPnl: number;
  eventTick: number | null;
  eventDirection: 'bullish' | 'bearish' | null;
  eventSymbols: string;
  eventImpact: number | null;
  eventPermanentShare: number | null;
  aggressiveBuyVolume5: number;
  aggressiveSellVolume5: number;
  aggressiveBuyVolume20: number;
  aggressiveSellVolume20: number;
  aggressiveBuyVolume50: number;
  aggressiveSellVolume50: number;
  orderbookHistoryJson: string;
  openOrdersJson: string;
}

export interface StrategyRunRecord {
  simTime: string;
  tick: number;
  barIndex: number;
  modelVersion: string;
  status: 'ok' | 'error' | 'disabled';
  durationMs: number;
  orderCount: number;
  message: string;
  intentsJson: string;
}

export interface StrategyOrderRecord {
  simTime: string;
  tick: number;
  barIndex: number;
  mode: 'dry_run' | 'queued' | 'cancel_requested' | 'rejected';
  action: 'order' | 'cancel';
  side?: Side;
  symbol?: string;
  orderType?: 'limit' | 'market';
  quantity?: number;
  price?: number | null;
  orderId?: string;
  message: string;
}

export interface StrategySession {
  bars: StrategyBarSnapshot[];
  runs: StrategyRunRecord[];
  orders: StrategyOrderRecord[];
  lastVolume: Record<string, number>;
}

export interface StrategyContext {
  tick: number;
  sim_time: string;
  bar_index: number;
  bar_ticks: number;
  model_version: string;
  account: {
    cash: number;
    available_cash: number;
    frozen_cash: number;
    total_asset: number;
    position_value: number;
    unrealized_pnl: number;
  };
  open_orders: Array<{
    id: string;
    symbol: string;
    side: Side;
    type: 'limit' | 'market';
    price: number | null;
    quantity: number;
    remaining: number;
    status: 'queued' | 'open' | 'partial' | 'pending_cancel';
    submitted_tick: number;
    reserved_cash: number;
    reserved_quantity: number;
    order_age_ticks: number;
    queue_ahead_volume: number | null;
    queue_ahead_order_count: number | null;
    queue_rank: number | null;
    level_total_volume: number | null;
    level_total_order_count: number | null;
  }>;
  event: null | { tick: number; direction: 'bullish' | 'bearish'; symbols: string[]; impact: number; permanent_share: number };
  assets: Record<string, {
    bars: Array<Pick<StrategyBarSnapshot, 'tick' | 'open' | 'high' | 'low' | 'close' | 'volume'>>;
    bar: Pick<StrategyBarSnapshot, 'tick' | 'open' | 'high' | 'low' | 'close' | 'volume'>;
    book: {
      best_bid: number | null; best_ask: number | null; mid: number | null; spread: number | null; bid_quantity: number; ask_quantity: number;
      bids: StrategyLiveBookLevel[]; asks: StrategyLiveBookLevel[];
    };
    order_flow: {
      last_5_ticks: StrategyOrderFlowWindow;
      last_20_ticks: StrategyOrderFlowWindow;
      last_50_ticks: StrategyOrderFlowWindow;
    };
    orderbook_history: StrategyOrderBookTick[];
    fair_value: number;
    position: { quantity: number; available: number; reserved: number; average_cost: number };
    model: { version: string; up_probability: number; expected_return: number; momentum_1: number; momentum_5: number; fair_value_gap: number; book_imbalance: number; spread_bps: number; event_signal: number };
  }>;
}

export function createStrategySession(): StrategySession {
  return { bars: [], runs: [], orders: [], lastVolume: {} };
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-12, Math.min(12, value))));
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function eventSignal(market: Market, symbol: string): number {
  const event = market.latestEvent;
  if (!event || !event.symbols.includes(symbol)) return 0;
  return (event.direction === 'bullish' ? 1 : -1) * event.impact * (1 - event.permanentShare);
}

function emptyBookLevel(level: number): StrategyBookLevel {
  return { level, price: null, volume: 0 };
}

function liveBookLevels(market: Market, symbol: string, side: Side, depth = 5): StrategyLiveBookLevel[] {
  const raw = side === 'buy' ? market.books[symbol].bids : market.books[symbol].asks;
  const levels: Array<StrategyLiveBookLevel & { totalAge: number }> = [];
  for (const order of raw) {
    let current = levels.find((level) => level.price === order.limitPrice);
    if (!current) {
      if (levels.length >= depth) continue;
      current = {
        level: levels.length + 1, price: order.limitPrice ?? null, volume: 0, order_count: 0,
        oldest_order_age_ticks: null, newest_order_age_ticks: null, average_order_age_ticks: null, totalAge: 0,
      };
      levels.push(current);
    }
    const age = Math.max(0, market.tick - order.submittedTick);
    current.volume += order.remaining;
    current.order_count += 1;
    current.totalAge += age;
    current.oldest_order_age_ticks = Math.max(current.oldest_order_age_ticks ?? age, age);
    current.newest_order_age_ticks = Math.min(current.newest_order_age_ticks ?? age, age);
  }
  return Array.from({ length: depth }, (_, index) => {
    const current = levels[index];
    if (!current) return { ...emptyBookLevel(index + 1), order_count: 0, oldest_order_age_ticks: null, newest_order_age_ticks: null, average_order_age_ticks: null };
    const { totalAge, ...level } = current;
    return { ...level, average_order_age_ticks: round(totalAge / current.order_count, 3) };
  });
}

function buildOrderbookHistory(market: Market): Record<string, StrategyOrderBookTick[]> {
  const ticks = [...new Set(market.snapshots.map((snapshot) => snapshot.tick))].sort((left, right) => left - right).slice(-STRATEGY_ORDERBOOK_HISTORY_TICKS);
  const tickSet = new Set(ticks);
  const history = Object.fromEntries(INSTRUMENTS.map((instrument) => [instrument.symbol, new Map<number, StrategyOrderBookTick>()])) as Record<string, Map<number, StrategyOrderBookTick>>;
  for (const snapshot of market.snapshots) {
    if (!tickSet.has(snapshot.tick)) continue;
    const byTick = history[snapshot.symbol];
    const current = byTick.get(snapshot.tick) ?? {
      sim_time: snapshot.simTime, tick: snapshot.tick, bids: [], asks: [],
      aggressive_buy_volume: 0, aggressive_sell_volume: 0, aggressive_buy_trades: 0, aggressive_sell_trades: 0,
    };
    const side = snapshot.side === 'buy' ? current.bids : current.asks;
    side.push({ level: snapshot.level, price: snapshot.price, volume: snapshot.quantity });
    byTick.set(snapshot.tick, current);
  }
  for (const trade of market.trades) {
    if (!tickSet.has(trade.tick)) continue;
    const current = history[trade.symbol].get(trade.tick);
    if (!current) continue;
    if (trade.aggressorSide === 'buy') {
      current.aggressive_buy_volume += trade.quantity;
      current.aggressive_buy_trades += 1;
    } else {
      current.aggressive_sell_volume += trade.quantity;
      current.aggressive_sell_trades += 1;
    }
  }
  return Object.fromEntries(INSTRUMENTS.map((instrument) => [instrument.symbol, ticks.flatMap((tick) => {
    const snapshot = history[instrument.symbol].get(tick);
    if (!snapshot) return [];
    const normalize = (levels: StrategyBookLevel[]) => Array.from({ length: 5 }, (_, index) => levels.find((level) => level.level === index + 1) ?? emptyBookLevel(index + 1));
    return [{ ...snapshot, bids: normalize(snapshot.bids), asks: normalize(snapshot.asks) }];
  })])) as Record<string, StrategyOrderBookTick[]>;
}

function orderFlow(history: StrategyOrderBookTick[], ticks: number): StrategyOrderFlowWindow {
  return history.slice(-ticks).reduce<StrategyOrderFlowWindow>((total, snapshot) => ({
    aggressive_buy_volume: total.aggressive_buy_volume + snapshot.aggressive_buy_volume,
    aggressive_sell_volume: total.aggressive_sell_volume + snapshot.aggressive_sell_volume,
    aggressive_buy_trades: total.aggressive_buy_trades + snapshot.aggressive_buy_trades,
    aggressive_sell_trades: total.aggressive_sell_trades + snapshot.aggressive_sell_trades,
  }), { aggressive_buy_volume: 0, aggressive_sell_volume: 0, aggressive_buy_trades: 0, aggressive_sell_trades: 0 });
}

function queueMetrics(market: Market, order: Market['orders'][string]) {
  const unavailable = { queue_ahead_volume: null, queue_ahead_order_count: null, queue_rank: null, level_total_volume: null, level_total_order_count: null };
  if (order.type !== 'limit' || !['open', 'partial'].includes(order.status) || order.limitPrice === undefined) return unavailable;
  const raw = order.side === 'buy' ? market.books[order.symbol].bids : market.books[order.symbol].asks;
  const samePrice = raw.filter((candidate) => candidate.limitPrice === order.limitPrice);
  const index = samePrice.findIndex((candidate) => candidate.id === order.id);
  if (index < 0) return unavailable;
  const ahead = samePrice.slice(0, index);
  return {
    queue_ahead_volume: ahead.reduce((total, candidate) => total + candidate.remaining, 0),
    queue_ahead_order_count: ahead.length,
    queue_rank: index + 1,
    level_total_volume: samePrice.reduce((total, candidate) => total + candidate.remaining, 0),
    level_total_order_count: samePrice.length,
  };
}

export function buildStrategyContext(market: Market, session: StrategySession): StrategyContext {
  const player = market.accounts.player;
  const metrics = accountMetrics(market, player);
  const barIndex = Math.floor(market.tick / STRATEGY_BAR_TICKS);
  const assets: StrategyContext['assets'] = {};
  const event = market.latestEvent;
  const orderbookHistory = buildOrderbookHistory(market);
  const openOrders = Object.values(market.orders)
    .filter((order) => order.participantId === 'player' && ['queued', 'open', 'partial', 'pending_cancel'].includes(order.status))
    .sort((left, right) => left.sequence - right.sequence)
    .map((order) => ({
      id: order.id, symbol: order.symbol, side: order.side, type: order.type, price: order.limitPrice ?? null,
      quantity: order.quantity, remaining: order.remaining, status: order.status as 'queued' | 'open' | 'partial' | 'pending_cancel',
      submitted_tick: order.submittedTick, reserved_cash: order.reservedCash, reserved_quantity: order.reservedQuantity,
      order_age_ticks: Math.max(0, market.tick - order.submittedTick), ...queueMetrics(market, order),
    }));

  for (const instrument of INSTRUMENTS) {
    const symbol = instrument.symbol;
    const asset = market.assets[symbol];
    const recentPrices = asset.priceHistory.filter((point) => point.tick > market.tick - STRATEGY_BAR_TICKS).map((point) => point.price);
    const prices = recentPrices.length ? recentPrices : [asset.lastPrice];
    const prior = asset.priceHistory.filter((point) => point.tick < market.tick).at(-1)?.price ?? asset.previousClose;
    const fiveBack = asset.priceHistory.filter((point) => point.tick <= market.tick - STRATEGY_BAR_TICKS).at(-1)?.price ?? asset.previousClose;
    const bidLevels = getBookLevels(market, symbol, 'buy');
    const askLevels = getBookLevels(market, symbol, 'sell');
    const liveBids = liveBookLevels(market, symbol, 'buy');
    const liveAsks = liveBookLevels(market, symbol, 'sell');
    const instrumentOrderbookHistory = orderbookHistory[symbol];
    const flow5 = orderFlow(instrumentOrderbookHistory, 5);
    const flow20 = orderFlow(instrumentOrderbookHistory, 20);
    const flow50 = orderFlow(instrumentOrderbookHistory, 50);
    const quote = getQuotes(market, symbol);
    const bidQuantity = bidLevels.reduce((total, level) => total + level.quantity, 0);
    const askQuantity = askLevels.reduce((total, level) => total + level.quantity, 0);
    const imbalance = (bidQuantity - askQuantity) / Math.max(1, bidQuantity + askQuantity);
    const momentum1 = prior > 0 ? (asset.lastPrice - prior) / prior : 0;
    const momentum5 = fiveBack > 0 ? (asset.lastPrice - fiveBack) / fiveBack : 0;
    const fairValueGap = asset.lastPrice > 0 ? (asset.fairValue - asset.lastPrice) / asset.lastPrice : 0;
    const spreadBps = quote.mid && quote.spread !== null ? (quote.spread / quote.mid) * 10_000 : 0;
    const newsSignal = eventSignal(market, symbol);
    const expectedReturn = round(0.45 * momentum1 + 0.7 * momentum5 + 0.85 * fairValueGap + 0.42 * imbalance + 0.55 * newsSignal - 0.03 * spreadBps / 100, 6);
    const upProbability = round(sigmoid(expectedReturn * 18), 6);
    const previousVolume = session.lastVolume[symbol] ?? 0;
    const position = player.positions[symbol];
    const snapshot: StrategyBarSnapshot = {
      simTime: new Date(market.simStartMs + market.tick * 1000).toISOString(), tick: market.tick, barIndex, symbol,
      open: prices[0], high: Math.max(...prices), low: Math.min(...prices), close: asset.lastPrice, volume: asset.volume - previousVolume,
      bestBid: quote.bestBid, bestAsk: quote.bestAsk, mid: quote.mid, spread: quote.spread, bidQuantity, askQuantity,
      fairValue: asset.fairValue, fairValueGap, momentum1, momentum5, bookImbalance: imbalance, spreadBps, eventSignal: newsSignal,
      upProbability, expectedReturn, positionQuantity: position.quantity, availableQuantity: position.quantity - position.reserved,
      reservedQuantity: position.reserved, averageCost: position.averageCost,
      accountCash: player.cash, accountAvailableCash: player.cash - player.reservedCash, accountFrozenCash: player.reservedCash,
      accountTotalAsset: metrics.totalAsset, accountPositionValue: metrics.positionValue, accountUnrealizedPnl: metrics.unrealized,
      eventTick: event?.tick ?? null, eventDirection: event?.direction ?? null, eventSymbols: event?.symbols.join('|') ?? '',
      eventImpact: event?.impact ?? null, eventPermanentShare: event?.permanentShare ?? null,
      aggressiveBuyVolume5: flow5.aggressive_buy_volume, aggressiveSellVolume5: flow5.aggressive_sell_volume,
      aggressiveBuyVolume20: flow20.aggressive_buy_volume, aggressiveSellVolume20: flow20.aggressive_sell_volume,
      aggressiveBuyVolume50: flow50.aggressive_buy_volume, aggressiveSellVolume50: flow50.aggressive_sell_volume,
      orderbookHistoryJson: JSON.stringify(instrumentOrderbookHistory),
      openOrdersJson: JSON.stringify(openOrders),
    };
    session.lastVolume[symbol] = asset.volume;
    session.bars.push(snapshot);
    const priorBars = session.bars.filter((bar) => bar.symbol === symbol).slice(-60).map((bar) => ({ tick: bar.tick, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }));
    assets[symbol] = {
      bars: priorBars,
      bar: { tick: snapshot.tick, open: snapshot.open, high: snapshot.high, low: snapshot.low, close: snapshot.close, volume: snapshot.volume },
      book: { best_bid: quote.bestBid, best_ask: quote.bestAsk, mid: quote.mid, spread: quote.spread, bid_quantity: bidQuantity, ask_quantity: askQuantity, bids: liveBids, asks: liveAsks },
      order_flow: { last_5_ticks: flow5, last_20_ticks: flow20, last_50_ticks: flow50 },
      orderbook_history: instrumentOrderbookHistory,
      fair_value: asset.fairValue,
      position: { quantity: position.quantity, available: position.quantity - position.reserved, reserved: position.reserved, average_cost: position.averageCost },
      model: { version: MODEL_VERSION, up_probability: upProbability, expected_return: expectedReturn, momentum_1: momentum1, momentum_5: momentum5, fair_value_gap: fairValueGap, book_imbalance: imbalance, spread_bps: spreadBps, event_signal: newsSignal },
    };
  }

  return {
    tick: market.tick, sim_time: new Date(market.simStartMs + market.tick * 1000).toISOString(), bar_index: barIndex, bar_ticks: STRATEGY_BAR_TICKS, model_version: MODEL_VERSION,
    account: { cash: player.cash, available_cash: player.cash - player.reservedCash, frozen_cash: player.reservedCash, total_asset: metrics.totalAsset, position_value: metrics.positionValue, unrealized_pnl: metrics.unrealized },
    open_orders: openOrders,
    event: event ? { tick: event.tick, direction: event.direction, symbols: event.symbols, impact: event.impact, permanent_share: event.permanentShare } : null,
    assets,
  };
}

export function normalizeStrategyIntents(value: unknown): { intents: StrategyIntent[]; error?: string } {
  if (!Array.isArray(value)) return { intents: [], error: 'on_bar must return a list of order or cancellation actions.' };
  if (value.length > STRATEGY_MAX_ACTIONS_PER_BAR) return { intents: [], error: `At most ${STRATEGY_MAX_ACTIONS_PER_BAR} actions are allowed per bar.` };
  const intents: StrategyIntent[] = [];
  let orderCount = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') return { intents: [], error: 'Each strategy action must be an object.' };
    const candidate = item as Record<string, unknown>;
    const action = candidate.action ?? 'order';
    if (action === 'cancel') {
      if (typeof candidate.order_id !== 'string' || !candidate.order_id) return { intents: [], error: 'cancel(order_id) needs a non-empty order id.' };
      intents.push({ action, orderId: candidate.order_id });
      continue;
    }
    if (action === 'cancel_all') {
      const side = candidate.side;
      if ((candidate.symbol !== undefined && typeof candidate.symbol !== 'string') || (side !== undefined && side !== 'buy' && side !== 'sell')) return { intents: [], error: 'cancel_all accepts only optional symbol and side filters.' };
      intents.push({ action, symbol: candidate.symbol as string | undefined, side: side as Side | undefined });
      continue;
    }
    if (action !== 'order') return { intents: [], error: 'Actions must be created with buy(), sell(), cancel(), or cancel_all().' };
    orderCount += 1;
    if (orderCount > STRATEGY_MAX_ORDERS_PER_BAR) return { intents: [], error: `At most ${STRATEGY_MAX_ORDERS_PER_BAR} orders are allowed per bar.` };
    const side = candidate.side;
    const symbol = candidate.symbol;
    const quantity = Number(candidate.quantity);
    const type = candidate.type ?? (candidate.price === undefined || candidate.price === null ? 'market' : 'limit');
    if ((side !== 'buy' && side !== 'sell') || typeof symbol !== 'string' || !Number.isInteger(quantity) || quantity < 1 || quantity > STRATEGY_MAX_QUANTITY || (type !== 'limit' && type !== 'market')) {
      return { intents: [], error: `Orders need side, symbol, integer quantity 1-${STRATEGY_MAX_QUANTITY}, and type limit or market.` };
    }
    if (type === 'limit') {
      const price = Number(candidate.price);
      if (!Number.isFinite(price)) return { intents: [], error: 'Limit orders need a numeric visible price.' };
      intents.push({ action: 'order', side, symbol, quantity, type, price });
      continue;
    }
    if (candidate.price !== undefined && candidate.price !== null) return { intents: [], error: 'Market orders must omit price.' };
    intents.push({ action: 'order', side, symbol, quantity, type });
  }
  return { intents };
}

export function expandStrategyIntents(market: Market, intents: StrategyIntent[]): StrategyAction[] {
  const actions: StrategyAction[] = [];
  for (const intent of intents) {
    if (intent.action !== 'cancel_all') {
      actions.push(intent);
      continue;
    }
    const matching = Object.values(market.orders)
      .filter((order) => order.participantId === 'player' && ['queued', 'open', 'partial'].includes(order.status))
      .filter((order) => !intent.symbol || order.symbol === intent.symbol)
      .filter((order) => !intent.side || order.side === intent.side)
      .sort((left, right) => left.sequence - right.sequence);
    for (const order of matching) actions.push({ action: 'cancel', orderId: order.id });
  }
  return actions;
}

export function validateStrategyIntent(market: Market, intent: StrategyOrderIntent): string | undefined {
  const instrument = INSTRUMENTS.find((item) => item.symbol === intent.symbol);
  if (!instrument) return 'Unknown instrument.';
  const player = market.accounts.player;
  if (intent.side === 'sell' && intent.quantity > player.positions[intent.symbol].quantity - player.positions[intent.symbol].reserved) return 'Insufficient available inventory.';
  if (intent.type === 'limit') {
    const visible = [...getBookLevels(market, intent.symbol, 'buy'), ...getBookLevels(market, intent.symbol, 'sell')].some((level) => level.price === intent.price);
    if (!visible) return 'Strategy limit price must be one of the visible top-five levels.';
    if (intent.side === 'buy') {
      const feeRate = market.config.feesEnabled ? Math.max(market.config.makerFeeRate, market.config.takerFeeRate) : 0;
      const required = intent.price! * intent.quantity * (1 + feeRate);
      if (required > player.cash - player.reservedCash + 0.0001) return `Insufficient available cash. Need ${required.toFixed(2)} 酒币.`;
    }
    return undefined;
  }
  const estimate = estimateMarketOrder(market, intent.symbol, intent.side, intent.quantity);
  if (estimate.quantity === 0) return 'No opposing liquidity is currently available.';
  if (intent.side === 'buy' && estimate.total > player.cash - player.reservedCash + 0.0001) return `Insufficient available cash. Need ${estimate.total.toFixed(2)} 酒币.`;
  return undefined;
}

export function validateStrategyAction(market: Market, action: StrategyAction): string | undefined {
  if (action.action === 'order') return validateStrategyIntent(market, action);
  const order = market.orders[action.orderId];
  if (!order || order.participantId !== 'player') return 'Order not found.';
  if (!['queued', 'open', 'partial'].includes(order.status) || order.remaining <= 0) return 'This order can no longer be cancelled.';
  return undefined;
}

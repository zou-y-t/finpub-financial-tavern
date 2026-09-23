import assert from 'node:assert/strict';
import {
  INSTRUMENTS, advanceTick, clearAccumulatedData, createMarket, defaultConfig, estimateMarketOrder, getBookLevels,
  getQuotes, queuePlayerOrder, requestCancel, roundCurrency,
} from './market.ts';
import { buildStrategyContext, createStrategySession, expandStrategyIntents, normalizeStrategyIntents, validateStrategyAction } from './strategy.ts';

function configuredMarket() {
  const config = defaultConfig();
  config.playerCash = 1_000_000;
  config.playerPositions = Object.fromEntries(INSTRUMENTS.map((item) => [item.symbol, 10_000]));
  config.npcCount = 20;
  config.seed = 44321;
  config.startTime = '2026-01-01T00:00';
  return createMarket(config);
}

function firstVisiblePrice(market: ReturnType<typeof configuredMarket>, symbol: string, side: 'buy' | 'sell') {
  const level = getBookLevels(market, symbol, side)[0];
  assert.ok(level, `${side} level should exist`);
  return level.price;
}

{
  const market = configuredMarket();
  assert.equal(market.tick, 0);
  assert.equal(market.snapshots.length, INSTRUMENTS.length * 10, 'tick 0 must contain top-five rows for both sides');
  assert.equal(market.participantSnapshots.length, 21, 'tick 0 must include player plus all NPCs');
  assert.equal(market.portfolioSnapshots.length, 1, 'tick 0 must include a player portfolio baseline');
  const initialWeights = market.portfolioSnapshots[0];
  assert.ok(Math.abs(initialWeights.cashWeight + Object.values(initialWeights.positionWeights).reduce((total, weight) => total + weight, 0) - 1) < 0.000001, 'portfolio weights must sum to 100%');
  assert.ok(Object.values(market.books).every((book) => book.bids.length > 0 && book.asks.length > 0), 'bootstrap liquidity should be confirmed');
}

{
  const market = configuredMarket();
  for (let tick = 0; tick < 5; tick += 1) advanceTick(market);
  const context = buildStrategyContext(market, createStrategySession());
  assert.equal(context.tick, 5);
  assert.equal(Object.keys(context.assets).length, INSTRUMENTS.length);
  assert.ok(context.assets.BDX.model.up_probability >= 0 && context.assets.BDX.model.up_probability <= 1);
  assert.equal(context.account.available_cash, context.account.cash - context.account.frozen_cash);
  assert.deepEqual(context.open_orders, [], 'a fresh strategy context should expose the player open-order collection');
  const ask = firstVisiblePrice(market, 'BDX', 'sell');
  assert.equal(queuePlayerOrder(market, { symbol: 'BDX', side: 'buy', type: 'limit', quantity: 1, limitPrice: ask }).ok, true);
  const withOrder = buildStrategyContext(market, createStrategySession());
  assert.equal(withOrder.open_orders.length, 1);
  assert.equal(withOrder.open_orders[0].reserved_cash > 0, true);
  assert.equal(withOrder.assets.BDX.position.available, market.accounts.player.positions.BDX.quantity - market.accounts.player.positions.BDX.reserved);
  const normalized = normalizeStrategyIntents([{ side: 'buy', symbol: 'BDX', quantity: 1, price: ask }]);
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.intents[0].action, 'order');
  if (normalized.intents[0].action === 'order') assert.equal(validateStrategyAction(market, normalized.intents[0]), undefined);
  assert.ok(normalizeStrategyIntents([{ side: 'buy', symbol: 'BDX', quantity: 26, price: ask }]).error);
  const marketOrder = normalizeStrategyIntents([{ action: 'order', side: 'buy', symbol: 'BDX', quantity: 1, type: 'market' }]);
  assert.equal(marketOrder.error, undefined);
  assert.equal(marketOrder.intents[0].action, 'order');
  if (marketOrder.intents[0].action === 'order') assert.equal(validateStrategyAction(market, marketOrder.intents[0]), undefined);
  const cancellations = expandStrategyIntents(market, normalizeStrategyIntents([{ action: 'cancel_all', symbol: 'BDX', side: 'buy' }]).intents);
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].action, 'cancel');
  assert.equal(validateStrategyAction(market, cancellations[0]), undefined);
}

{
  const market = configuredMarket();
  const ask = firstVisiblePrice(market, 'BDX', 'sell');
  const beforeCash = market.accounts.player.cash;
  const result = queuePlayerOrder(market, { symbol: 'BDX', side: 'buy', type: 'limit', quantity: 1, limitPrice: ask });
  assert.equal(result.ok, true);
  const order = market.orders[market.pendingOrderIds[0]];
  assert.equal(order.status, 'queued');
  assert.ok(!market.books.BDX.bids.some((item) => item.id === order.id), 'queued order must not appear in confirmed book');
  advanceTick(market);
  assert.equal(order.status, 'filled');
  const trade = market.trades.find((item) => item.takerOrderId === order.id);
  assert.ok(trade);
  assert.equal(trade.price, ask, 'execution price must be resting maker price');
  assert.equal(trade.takerId, 'player');
  assert.equal(trade.makerFee, roundCurrency(trade.grossAmount * market.config.makerFeeRate));
  assert.equal(trade.takerFee, roundCurrency(trade.grossAmount * market.config.takerFeeRate));
  assert.equal(market.accounts.player.cash, roundCurrency(beforeCash + trade.buyerCashChange));
  assert.equal(market.accounts.player.reservedCash, 0);
}

{
  const market = configuredMarket();
  const bid = firstVisiblePrice(market, 'ISL', 'buy');
  const beforePosition = market.accounts.player.positions.ISL.quantity;
  const result = queuePlayerOrder(market, { symbol: 'ISL', side: 'sell', type: 'limit', quantity: 3, limitPrice: bid });
  assert.equal(result.ok, true);
  assert.equal(market.accounts.player.positions.ISL.reserved, 3);
  advanceTick(market);
  const order = Object.values(market.orders).find((item) => item.participantId === 'player')!;
  assert.equal(order.status, 'filled');
  assert.equal(market.accounts.player.positions.ISL.quantity, beforePosition - 3);
  assert.equal(market.accounts.player.positions.ISL.reserved, 0);
}

{
  const market = configuredMarket();
  const bid = firstVisiblePrice(market, 'JDG', 'buy');
  const firstMaker = market.books.JDG.bids[0];
  const result = queuePlayerOrder(market, { symbol: 'JDG', side: 'sell', type: 'market', quantity: 1 });
  assert.equal(result.ok, true);
  advanceTick(market);
  const trade = market.trades.find((item) => item.takerId === 'player');
  assert.ok(trade);
  assert.equal(trade.makerOrderId, firstMaker.id, 'same price must preserve earliest book sequence');
  assert.equal(trade.price, bid);
}

{
  const market = configuredMarket();
  const estimated = estimateMarketOrder(market, 'CRM', 'sell', 10_000);
  assert.ok(estimated.quantity > 0 && estimated.quantity < 10_000);
  const result = queuePlayerOrder(market, { symbol: 'CRM', side: 'sell', type: 'market', quantity: 10_000 });
  assert.equal(result.ok, true);
  const order = market.orders[market.pendingOrderIds[0]];
  advanceTick(market);
  assert.equal(order.status, 'cancelled', 'unfilled market remainder must auto-cancel');
  assert.ok(order.remaining > 0);
  assert.equal(market.accounts.player.positions.CRM.reserved, 0);
  assert.ok(market.accounts.player.positions.CRM.quantity >= 0);
}

{
  const market = configuredMarket();
  const bid = firstVisiblePrice(market, 'CHM', 'buy');
  const result = queuePlayerOrder(market, { symbol: 'CHM', side: 'buy', type: 'limit', quantity: 4, limitPrice: bid });
  assert.equal(result.ok, true);
  const order = market.orders[market.pendingOrderIds[0]];
  advanceTick(market);
  assert.ok(['open', 'partial'].includes(order.status));
  assert.ok(market.accounts.player.reservedCash > 0);
  const cancel = requestCancel(market, order.id);
  assert.equal(cancel.ok, true);
  assert.equal(order.status, 'pending_cancel');
  assert.ok(market.books.CHM.bids.some((item) => item.id === order.id), 'pending cancel remains until auction');
  advanceTick(market);
  assert.equal(order.status, 'cancelled');
  assert.ok(!market.books.CHM.bids.some((item) => item.id === order.id));
  assert.equal(market.accounts.player.reservedCash, 0);
}

{
  const market = configuredMarket();
  const asks = getBookLevels(market, 'OCR', 'sell');
  const limitPrice = asks.at(-1)!.price;
  const executable = market.books.OCR.asks.filter((order) => order.limitPrice! <= limitPrice).reduce((total, order) => total + order.remaining, 0);
  const result = queuePlayerOrder(market, { symbol: 'OCR', side: 'buy', type: 'limit', quantity: executable + 3, limitPrice });
  assert.equal(result.ok, true);
  const order = market.orders[market.pendingOrderIds[0]];
  advanceTick(market);
  assert.equal(order.status, 'partial', 'a crossing limit order must keep its unmatched balance');
  assert.equal(order.remaining, 3);
  assert.ok(market.books.OCR.bids.some((candidate) => candidate.id === order.id), 'partial limit balance must remain in the book');
}

{
  const left = configuredMarket();
  const right = configuredMarket();
  for (let tick = 0; tick < 42; tick += 1) { advanceTick(left); advanceTick(right); }
  const compact = (market: typeof left) => JSON.stringify({
    trades: market.trades.map((trade) => [trade.tick, trade.symbol, trade.price, trade.quantity, trade.makerId, trade.takerId]),
    events: market.events,
    books: Object.fromEntries(INSTRUMENTS.map((item) => [item.symbol, {
      bids: market.books[item.symbol].bids.map((order) => [order.limitPrice, order.remaining, order.sequence]),
      asks: market.books[item.symbol].asks.map((order) => [order.limitPrice, order.remaining, order.sequence]),
    }])),
  });
  assert.equal(compact(left), compact(right), 'same seed must reproduce orders, trades and events');
  assert.ok(left.events.length >= 1, 'events should occur on the deterministic schedule');
  assert.equal(left.snapshots.length, (left.tick + 1) * INSTRUMENTS.length * 10);
  assert.equal(left.participantSnapshots.length, (left.tick + 1) * 21);
  assert.equal(left.portfolioSnapshots.length, left.tick + 1, 'one portfolio snapshot must be captured per tick');
  assert.ok(left.accounts.player.cash >= 0);
  assert.ok(INSTRUMENTS.every((item) => left.accounts.player.positions[item.symbol].quantity >= 0));
  for (const symbol of INSTRUMENTS.map((item) => item.symbol)) {
    const quotes = getQuotes(left, symbol);
    if (quotes.bestBid !== null && quotes.bestAsk !== null) assert.ok(quotes.bestBid < quotes.bestAsk, `${symbol} book must not remain crossed`);
  }
}

{
  const market = configuredMarket();
  for (let tick = 0; tick < 20; tick += 1) advanceTick(market);
  const cashBefore = market.accounts.player.cash;
  const openOrderIds = Object.values(market.orders).filter((order) => ['queued', 'open', 'partial', 'pending_cancel'].includes(order.status)).map((order) => order.id);
  const result = clearAccumulatedData(market);
  assert.ok(result.recordsRemoved > 0);
  assert.ok(result.ordersRemoved > 0);
  assert.equal(market.trades.length, 0);
  assert.equal(market.events.length, 0);
  assert.equal(market.snapshots.length, INSTRUMENTS.length * 10, 'cleanup must retain a current baseline book snapshot');
  assert.equal(market.participantSnapshots.length, 21, 'cleanup must retain current participant baseline');
  assert.equal(market.portfolioSnapshots.length, 1, 'cleanup must retain the current portfolio baseline');
  assert.equal(market.accounts.player.cash, cashBefore, 'cleanup must not mutate account balances');
  assert.deepEqual(Object.keys(market.orders).sort(), openOrderIds.sort(), 'cleanup must preserve every active order');
  assert.ok(INSTRUMENTS.every((item) => market.assets[item.symbol].priceHistory.length === 0));
}

console.log('FINPUB market engine acceptance checks passed.');

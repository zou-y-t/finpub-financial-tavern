import type {
  Account, AssetState, Book, BookLevel, BookSnapshot, InstrumentDefinition, Market,
  MarketConfig, MarketEvent, NpcProfile, Order, ParticipantSnapshot, Position, Side,
  Trade, TraderStyle,
} from './types.ts';

export const INSTRUMENTS: InstrumentDefinition[] = [
  { symbol: 'BDX', name: 'Bordeaux Reserve', category: 'Wine', tickSize: 0.1, initialPrice: 102.4 },
  { symbol: 'ISL', name: 'Islay Single Malt', category: 'Whisky', tickSize: 0.1, initialPrice: 148.6 },
  { symbol: 'JDG', name: 'Daiginjo', category: 'Sake', tickSize: 0.1, initialPrice: 86.2 },
  { symbol: 'CRM', name: 'Caribbean Aged Rum', category: 'Rum', tickSize: 0.1, initialPrice: 74.8 },
  { symbol: 'CHM', name: 'Vintage Champagne', category: 'Champagne', tickSize: 0.1, initialPrice: 126.5 },
  { symbol: 'OCR', name: 'Orchard Cider', category: 'Cider', tickSize: 0.1, initialPrice: 39.4 },
];

const STYLES: TraderStyle[] = ['market_maker', 'value', 'trend', 'news', 'noise'];
const EVENT_GAP_MIN = 15;
const EVENT_GAP_RANGE = 26;
const CURRENCY_DECIMALS = 2;

export const defaultConfig = (): MarketConfig => ({
  playerCash: 100_000,
  playerPositions: Object.fromEntries(INSTRUMENTS.map((item) => [item.symbol, 25])),
  npcCount: 80,
  makerFeeRate: 0.0002,
  takerFeeRate: 0.0005,
  feesEnabled: true,
  seed: 20260922,
  startTime: new Date().toISOString().slice(0, 16),
  initialPrices: Object.fromEntries(INSTRUMENTS.map((item) => [item.symbol, item.initialPrice])),
});

export function roundCurrency(value: number): number {
  const factor = 10 ** CURRENCY_DECIMALS;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function roundPrice(value: number, tickSize: number): number {
  const rounded = Math.round((value + Number.EPSILON) / tickSize) * tickSize;
  return Number(rounded.toFixed(4));
}

function createPositions(config: MarketConfig, initial = false): Record<string, Position> {
  return Object.fromEntries(INSTRUMENTS.map((item) => [item.symbol, {
    quantity: initial ? Math.max(0, Math.floor(config.playerPositions[item.symbol] ?? 0)) : 0,
    reserved: 0,
    averageCost: initial ? config.initialPrices[item.symbol] : 0,
  }]));
}

function createPlayer(config: MarketConfig): Account {
  const positions = createPositions(config, true);
  const initialNetAsset = roundCurrency(config.playerCash + INSTRUMENTS.reduce(
    (total, item) => total + positions[item.symbol].quantity * config.initialPrices[item.symbol], 0,
  ));
  return {
    id: 'player', type: 'player', name: 'You', cash: config.playerCash,
    initialNetAsset, positions, realizedPnl: 0, makerFees: 0, takerFees: 0,
    tradeCount: 0, buyVolume: 0, sellVolume: 0, reservedCash: 0,
  };
}

function nextRandom(market: Market): number {
  market.rngState = (market.rngState * 48271) % 2147483647;
  return (market.rngState - 1) / 2147483646;
}

function randomBetween(market: Market, min: number, max: number): number {
  return min + (max - min) * nextRandom(market);
}

function randomInt(market: Market, min: number, maxInclusive: number): number {
  return Math.floor(randomBetween(market, min, maxInclusive + 1));
}

function makeProfile(market: Market, index: number): NpcProfile {
  const style = STYLES[index % STYLES.length];
  const valuationBias = Object.fromEntries(INSTRUMENTS.map((item) => [item.symbol, randomBetween(market, -0.025, 0.025)]));
  const targetInventory = Object.fromEntries(INSTRUMENTS.map((item) => [item.symbol, randomInt(market, -35, 35)]));
  return {
    id: `npc-${String(index + 1).padStart(3, '0')}`,
    style,
    valuationBias,
    targetInventory,
    sensitivity: randomBetween(market, 0.65, 1.45),
    maxOrderSize: randomInt(market, 3, 18),
  };
}

function createNpcAccount(profile: NpcProfile, config: MarketConfig): Account {
  return {
    id: profile.id, type: 'npc', name: `NPC ${profile.id.slice(-3)}`, style: profile.style,
    cash: 0, initialNetAsset: 0, positions: createPositions(config), realizedPnl: 0,
    makerFees: 0, takerFees: 0, tradeCount: 0, buyVolume: 0, sellVolume: 0, reservedCash: 0,
  };
}

function simTime(market: Market): string {
  return new Date(market.simStartMs + market.tick * 1000).toISOString();
}

function activeFeeRates(market: Market): { maker: number; taker: number } {
  return market.config.feesEnabled
    ? { maker: market.config.makerFeeRate, taker: market.config.takerFeeRate }
    : { maker: 0, taker: 0 };
}

export function createMarket(rawConfig: MarketConfig): Market {
  const config: MarketConfig = {
    ...rawConfig,
    npcCount: Math.max(20, Math.min(200, Math.floor(rawConfig.npcCount))),
    playerCash: Math.max(0, roundCurrency(rawConfig.playerCash)),
    seed: Math.max(1, Math.floor(rawConfig.seed) || 1),
    makerFeeRate: Math.max(0, rawConfig.makerFeeRate),
    takerFeeRate: Math.max(0, rawConfig.takerFeeRate),
  };
  const start = Date.parse(config.startTime);
  const market: Market = {
    config, tick: 0, sequence: 0, tradeSequence: 0,
    simStartMs: Number.isFinite(start) ? start : Date.now(),
    assets: {}, books: {}, accounts: {}, npcProfiles: {}, orders: {},
    pendingOrderIds: [], pendingCancelIds: [], trades: [], snapshots: [], participantSnapshots: [],
    events: [], nextEventTick: EVENT_GAP_MIN, rngState: config.seed, notices: [],
  };
  for (const item of INSTRUMENTS) {
    const price = roundPrice(Math.max(item.tickSize, config.initialPrices[item.symbol] ?? item.initialPrice), item.tickSize);
    market.assets[item.symbol] = {
      definition: item, lastPrice: price, previousClose: price, volume: 0, fairValue: price,
      permanentShift: 0, transientShift: 0, eventVolatility: 0, priceHistory: [],
    };
    market.books[item.symbol] = { bids: [], asks: [] };
  }
  market.accounts.player = createPlayer(config);
  for (let index = 0; index < config.npcCount; index += 1) {
    const profile = makeProfile(market, index);
    market.npcProfiles[profile.id] = profile;
    market.accounts[profile.id] = createNpcAccount(profile, config);
  }
  bootstrapLiquidity(market);
  captureSnapshots(market);
  captureParticipantSnapshots(market);
  return market;
}

function newOrder(market: Market, data: Omit<Order, 'id' | 'submittedTick' | 'sequence' | 'status' | 'reservedCash' | 'reservedQuantity'>): Order {
  market.sequence += 1;
  return {
    ...data, id: `O-${String(market.sequence).padStart(7, '0')}`,
    submittedTick: market.tick, sequence: market.sequence, status: 'queued', reservedCash: 0, reservedQuantity: 0,
  };
}

function insertRestingOrder(market: Market, order: Order): void {
  const book = market.books[order.symbol];
  const orders = order.side === 'buy' ? book.bids : book.asks;
  orders.push(order);
  orders.sort((left, right) => {
    const priceDelta = order.side === 'buy'
      ? (right.limitPrice! - left.limitPrice!)
      : (left.limitPrice! - right.limitPrice!);
    return priceDelta !== 0 ? priceDelta : left.sequence - right.sequence;
  });
  order.status = order.remaining === order.quantity ? 'open' : 'partial';
}

function bootstrapLiquidity(market: Market): void {
  const profiles = Object.values(market.npcProfiles).filter((profile) => profile.style === 'market_maker').slice(0, 18);
  const providers = profiles.length ? profiles : Object.values(market.npcProfiles).slice(0, 12);
  for (const asset of Object.values(market.assets)) {
    providers.forEach((profile, index) => {
      const width = 0.003 + index * 0.00055;
      const quantity = 5 + (index % 4) * 2;
      const bid = roundPrice(asset.fairValue * (1 - width), asset.definition.tickSize);
      const ask = roundPrice(asset.fairValue * (1 + width), asset.definition.tickSize);
      for (const data of [
        { participantId: profile.id, symbol: asset.definition.symbol, side: 'buy' as Side, type: 'limit' as const, limitPrice: bid, quantity, remaining: quantity },
        { participantId: profile.id, symbol: asset.definition.symbol, side: 'sell' as Side, type: 'limit' as const, limitPrice: ask, quantity, remaining: quantity },
      ]) {
        const order = newOrder(market, data);
        market.orders[order.id] = order;
        insertRestingOrder(market, order);
      }
    });
  }
}

export function getBookLevels(market: Market, symbol: string, side: Side, depth = 5): BookLevel[] {
  const raw = side === 'buy' ? market.books[symbol].bids : market.books[symbol].asks;
  const levels: BookLevel[] = [];
  for (const order of raw) {
    const existing = levels.find((level) => level.price === order.limitPrice);
    if (existing) {
      existing.quantity += order.remaining;
      existing.orderCount += 1;
      existing.hasPlayerOrder ||= order.participantId === 'player';
    } else if (levels.length < depth) {
      levels.push({ price: order.limitPrice!, quantity: order.remaining, orderCount: 1, hasPlayerOrder: order.participantId === 'player' });
    }
  }
  return levels;
}

export function getQuotes(market: Market, symbol: string): { bestBid: number | null; bestAsk: number | null; mid: number | null; spread: number | null } {
  const bid = market.books[symbol].bids[0]?.limitPrice ?? null;
  const ask = market.books[symbol].asks[0]?.limitPrice ?? null;
  return { bestBid: bid, bestAsk: ask, mid: bid !== null && ask !== null ? roundPrice((bid + ask) / 2, market.assets[symbol].definition.tickSize) : null, spread: bid !== null && ask !== null ? roundPrice(ask - bid, market.assets[symbol].definition.tickSize) : null };
}

export function estimateMarketOrder(market: Market, symbol: string, side: Side, quantity: number): { quantity: number; gross: number; fee: number; total: number; firstPrice: number | null } {
  const raw = side === 'buy' ? market.books[symbol].asks : market.books[symbol].bids;
  let remaining = quantity;
  let gross = 0;
  let filled = 0;
  for (const order of raw) {
    if (remaining <= 0) break;
    const used = Math.min(remaining, order.remaining);
    gross += used * order.limitPrice!;
    filled += used;
    remaining -= used;
  }
  const fees = activeFeeRates(market);
  const fee = roundCurrency(gross * fees.taker);
  return { quantity: filled, gross: roundCurrency(gross), fee, total: roundCurrency(gross + fee), firstPrice: raw[0]?.limitPrice ?? null };
}

function isVisibleBookPrice(market: Market, symbol: string, price: number): boolean {
  return [...getBookLevels(market, symbol, 'buy'), ...getBookLevels(market, symbol, 'sell')].some((level) => level.price === price);
}

export function queuePlayerOrder(market: Market, input: { symbol: string; side: Side; type: 'limit' | 'market'; quantity: number; limitPrice?: number }): { ok: boolean; message: string } {
  const quantity = Math.floor(input.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, message: 'Quantity must be a positive integer.' };
  const player = market.accounts.player;
  const asset = market.assets[input.symbol];
  if (!asset) return { ok: false, message: 'Unknown instrument.' };
  let reserveCash = 0;
  let price: number | undefined;
  if (input.type === 'limit') {
    if (input.limitPrice === undefined || !isVisibleBookPrice(market, input.symbol, input.limitPrice)) return { ok: false, message: 'Choose a price from the visible order book.' };
    price = roundPrice(input.limitPrice, asset.definition.tickSize);
    const rates = activeFeeRates(market);
    reserveCash = roundCurrency(price * quantity * (1 + Math.max(rates.maker, rates.taker)));
  } else {
    const estimate = estimateMarketOrder(market, input.symbol, input.side, quantity);
    if (estimate.quantity === 0) return { ok: false, message: 'No opposing liquidity is currently available.' };
    reserveCash = estimate.total;
  }
  if (input.side === 'buy') {
    const available = roundCurrency(player.cash - player.reservedCash);
    if (reserveCash > available + 0.0001) return { ok: false, message: `Insufficient available cash. Need ${reserveCash.toFixed(2)} 酒币.` };
    player.reservedCash = roundCurrency(player.reservedCash + reserveCash);
  } else {
    const position = player.positions[input.symbol];
    if (quantity > position.quantity - position.reserved) return { ok: false, message: 'Insufficient available inventory.' };
    position.reserved += quantity;
  }
  const order = newOrder(market, { participantId: 'player', symbol: input.symbol, side: input.side, type: input.type, limitPrice: price, quantity, remaining: quantity });
  order.reservedCash = input.side === 'buy' ? reserveCash : 0;
  order.reservedQuantity = input.side === 'sell' ? quantity : 0;
  market.orders[order.id] = order;
  market.pendingOrderIds.push(order.id);
  market.notices.unshift(`${order.id} is queued for the next auction.`);
  return { ok: true, message: `${order.id} queued — it will be processed at the next 1s auction.` };
}

export function requestCancel(market: Market, orderId: string): { ok: boolean; message: string } {
  const order = market.orders[orderId];
  if (!order || order.participantId !== 'player') return { ok: false, message: 'Order not found.' };
  if (!['queued', 'open', 'partial'].includes(order.status) || order.remaining <= 0) return { ok: false, message: 'This order can no longer be cancelled.' };
  order.status = 'pending_cancel';
  if (!market.pendingCancelIds.includes(order.id)) market.pendingCancelIds.push(order.id);
  return { ok: true, message: `${order.id} cancellation queued for the next auction.` };
}

function releaseReservation(market: Market, order: Order): void {
  if (order.participantId !== 'player') return;
  const account = market.accounts.player;
  if (order.side === 'buy' && order.reservedCash > 0) {
    account.reservedCash = roundCurrency(Math.max(0, account.reservedCash - order.reservedCash));
    order.reservedCash = 0;
  }
  if (order.side === 'sell' && order.reservedQuantity > 0) {
    const position = account.positions[order.symbol];
    position.reserved = Math.max(0, position.reserved - order.reservedQuantity);
    order.reservedQuantity = 0;
  }
}

function removeFromBook(market: Market, order: Order): void {
  const book = market.books[order.symbol];
  if (order.side === 'buy') book.bids = book.bids.filter((candidate) => candidate.id !== order.id);
  else book.asks = book.asks.filter((candidate) => candidate.id !== order.id);
}

function cancelOrder(market: Market, order: Order): void {
  removeFromBook(market, order);
  releaseReservation(market, order);
  order.status = 'cancelled';
}

function pruneNpcLiquidity(market: Market): void {
  for (const order of Object.values(market.orders)) {
    if (order.participantId !== 'player' && ['open', 'partial'].includes(order.status) && market.tick - order.submittedTick >= 16) cancelOrder(market, order);
  }
}

function makeEvent(market: Market): void {
  const allAssets = Object.values(market.assets);
  const target = allAssets[randomInt(market, 0, allAssets.length - 1)];
  const direction = nextRandom(market) > 0.47 ? 'bullish' : 'bearish';
  const impact = randomBetween(market, 0.018, 0.075);
  const categoryGroups: Record<string, string[]> = {
    BDX: ['BDX', 'CHM'], CHM: ['BDX', 'CHM'], ISL: ['ISL', 'CRM'], CRM: ['ISL', 'CRM'],
    JDG: ['JDG', 'OCR'], OCR: ['JDG', 'OCR'],
  };
  const related = nextRandom(market) > 0.72 ? categoryGroups[target.definition.symbol] : [target.definition.symbol];
  const subject = target.definition.name;
  const narratives = direction === 'bullish'
    ? [
      `Critics award ${subject} a rare cellar score.`,
      `A frost report tightens supply expectations for ${subject}.`,
      `A prominent bar partnership lifts near-term demand for ${subject}.`,
    ]
    : [
      `A storage quality alert weighs on ${subject}.`,
      `Transport delays raise uncertainty around ${subject}.`,
      `Tax and substitute-product news pressures ${subject}.`,
    ];
  const title = narratives[randomInt(market, 0, narratives.length - 1)];
  const event: MarketEvent = {
    id: `E-${market.tick}`, tick: market.tick, simTime: simTime(market), title,
    description: `${direction === 'bullish' ? 'Bullish' : 'Bearish'} expectation shock; valuations adjust through trader decisions, not a price override.`,
    symbols: related, direction, impact, permanentShare: randomBetween(market, 0.16, 0.38),
  };
  market.events.unshift(event);
  market.latestEvent = event;
  const sign = direction === 'bullish' ? 1 : -1;
  for (const symbol of related) {
    const asset = market.assets[symbol];
    asset.permanentShift += sign * impact * event.permanentShare;
    asset.transientShift += sign * impact * (1 - event.permanentShare);
    asset.eventVolatility = Math.min(0.12, asset.eventVolatility + impact * 0.8);
  }
  market.nextEventTick = market.tick + randomInt(market, EVENT_GAP_MIN, EVENT_GAP_MIN + EVENT_GAP_RANGE - 1);
}

function updateFairValues(market: Market): void {
  for (const asset of Object.values(market.assets)) {
    asset.transientShift *= 0.93;
    asset.eventVolatility *= 0.88;
    asset.fairValue = roundPrice(asset.definition.initialPrice * (market.config.initialPrices[asset.definition.symbol] / asset.definition.initialPrice) * (1 + asset.permanentShift + asset.transientShift), asset.definition.tickSize);
  }
}

function trendSignal(asset: AssetState): number {
  const prices = asset.priceHistory.slice(-7).map((point) => point.price);
  if (prices.length < 2) return 0;
  return (prices[prices.length - 1] - prices[0]) / prices[0];
}

function activeNpcOrderCount(market: Market, participantId: string): number {
  return Object.values(market.orders).filter((order) => order.participantId === participantId && ['queued', 'open', 'partial'].includes(order.status)).length;
}

function queueNpcOrder(market: Market, data: Omit<Order, 'id' | 'submittedTick' | 'sequence' | 'status' | 'reservedCash' | 'reservedQuantity'>): void {
  const order = newOrder(market, data);
  market.orders[order.id] = order;
  market.pendingOrderIds.push(order.id);
}

function npcDecision(market: Market, profile: NpcProfile, asset: AssetState): void {
  if (activeNpcOrderCount(market, profile.id) >= 12) return;
  const symbol = asset.definition.symbol;
  const account = market.accounts[profile.id];
  const subjectiveValue = asset.fairValue * (1 + profile.valuationBias[symbol] + asset.transientShift * (profile.style === 'news' ? 0.55 * profile.sensitivity : 0.12));
  const quote = getQuotes(market, symbol);
  const reference = quote.mid ?? asset.lastPrice;
  const quantity = randomInt(market, 1, profile.maxOrderSize);
  const tick = asset.definition.tickSize;
  const volatility = 0.0018 + asset.eventVolatility * 0.28;
  const inventorySkew = (account.positions[symbol].quantity - profile.targetInventory[symbol]) / 500;
  const submit = (side: Side, type: 'limit' | 'market', price?: number, size = quantity) => {
    queueNpcOrder(market, { participantId: profile.id, symbol, side, type, limitPrice: price, quantity: size, remaining: size });
  };
  if (profile.style === 'market_maker') {
    const halfSpread = volatility + randomBetween(market, 0.0004, 0.0014);
    const center = subjectiveValue * (1 - inventorySkew * 0.35);
    const bid = roundPrice(center * (1 - halfSpread), tick);
    const ask = roundPrice(center * (1 + halfSpread), tick);
    if (bid < ask) {
      submit('buy', 'limit', bid, Math.max(1, Math.round(quantity * (inventorySkew > 0 ? 0.65 : 1.1))));
      submit('sell', 'limit', ask, Math.max(1, Math.round(quantity * (inventorySkew < 0 ? 0.65 : 1.1))));
    }
    return;
  }
  let signal = (subjectiveValue - reference) / Math.max(reference, tick);
  if (profile.style === 'trend') signal = trendSignal(asset) * profile.sensitivity * 2.6 + randomBetween(market, -0.004, 0.004);
  if (profile.style === 'news') signal += asset.transientShift * profile.sensitivity * 1.7;
  if (profile.style === 'noise') signal = randomBetween(market, -0.012, 0.012) + asset.transientShift * 0.16;
  const side: Side = signal >= 0 ? 'buy' : 'sell';
  const urgency = Math.abs(signal);
  const useMarket = urgency > 0.018 && nextRandom(market) < 0.35;
  if (useMarket && ((side === 'buy' && quote.bestAsk !== null) || (side === 'sell' && quote.bestBid !== null))) {
    submit(side, 'market', undefined, Math.max(1, Math.min(quantity, 8)));
    return;
  }
  const offset = randomBetween(market, 0.0002, 0.006 + asset.eventVolatility * 0.2);
  const price = side === 'buy'
    ? roundPrice(Math.min(subjectiveValue, reference) * (1 - offset), tick)
    : roundPrice(Math.max(subjectiveValue, reference) * (1 + offset), tick);
  submit(side, 'limit', Math.max(tick, price));
}

function generateNpcOrders(market: Market): void {
  const profiles = Object.values(market.npcProfiles);
  const actions = Math.min(64, Math.max(12, Math.ceil(profiles.length * 0.28)));
  for (let index = 0; index < actions; index += 1) {
    const profile = profiles[randomInt(market, 0, profiles.length - 1)];
    const asset = market.assets[INSTRUMENTS[randomInt(market, 0, INSTRUMENTS.length - 1)].symbol];
    npcDecision(market, profile, asset);
  }
}

function updatePosition(account: Account, symbol: string, delta: number, price: number): void {
  const position = account.positions[symbol];
  const before = position.quantity;
  const after = before + delta;
  if (before === 0 || before * delta > 0) {
    position.averageCost = before === 0 ? price : ((Math.abs(before) * position.averageCost) + (Math.abs(delta) * price)) / Math.abs(after);
  } else {
    const closed = Math.min(Math.abs(before), Math.abs(delta));
    account.realizedPnl = roundCurrency(account.realizedPnl + closed * (price - position.averageCost) * Math.sign(before));
    if (after === 0) position.averageCost = 0;
    else if (Math.sign(after) !== Math.sign(before)) position.averageCost = price;
  }
  position.quantity = after;
}

function applyFill(account: Account, symbol: string, side: Side, price: number, quantity: number, fee: number, role: 'maker' | 'taker'): void {
  const gross = roundCurrency(price * quantity);
  if (side === 'buy') {
    account.cash = roundCurrency(account.cash - gross - fee);
    updatePosition(account, symbol, quantity, price);
    account.buyVolume += quantity;
  } else {
    account.cash = roundCurrency(account.cash + gross - fee);
    updatePosition(account, symbol, -quantity, price);
    account.sellVolume += quantity;
  }
  account.realizedPnl = roundCurrency(account.realizedPnl - fee);
  if (role === 'maker') account.makerFees = roundCurrency(account.makerFees + fee);
  else account.takerFees = roundCurrency(account.takerFees + fee);
  account.tradeCount += 1;
}

function canPayForBuyer(market: Market, order: Order, debit: number): boolean {
  if (order.participantId !== 'player') return true;
  if (market.accounts.player.cash + 0.0001 < debit) return false;
  return order.reservedCash + 0.0001 >= debit;
}

function releaseAfterFill(market: Market, order: Order, cashDebit: number, executedQuantity: number): void {
  if (order.participantId !== 'player') return;
  const player = market.accounts.player;
  if (order.side === 'buy') {
    const before = order.reservedCash;
    let after = 0;
    if (order.type === 'limit') {
      const rates = activeFeeRates(market);
      after = roundCurrency((order.limitPrice ?? 0) * order.remaining * (1 + Math.max(rates.maker, rates.taker)));
    } else {
      after = Math.max(0, roundCurrency(before - cashDebit));
    }
    order.reservedCash = after;
    player.reservedCash = roundCurrency(Math.max(0, player.reservedCash - Math.max(0, before - after)));
  } else {
    const position = player.positions[order.symbol];
    const release = Math.min(order.reservedQuantity, executedQuantity);
    if (release > 0) {
      position.reserved = Math.max(0, position.reserved - release);
      order.reservedQuantity -= release;
    }
  }
}

function executeTrade(market: Market, maker: Order, taker: Order, quantity: number): void {
  const price = maker.limitPrice!;
  const buyerOrder = maker.side === 'buy' ? maker : taker;
  const sellerOrder = maker.side === 'sell' ? maker : taker;
  const rates = activeFeeRates(market);
  const gross = roundCurrency(price * quantity);
  const makerFee = roundCurrency(gross * rates.maker);
  const takerFee = roundCurrency(gross * rates.taker);
  const buyerFee = buyerOrder.id === maker.id ? makerFee : takerFee;
  const sellerFee = sellerOrder.id === maker.id ? makerFee : takerFee;
  const buyerDebit = roundCurrency(gross + buyerFee);
  if (!canPayForBuyer(market, buyerOrder, buyerDebit)) return;
  maker.remaining -= quantity;
  taker.remaining -= quantity;
  applyFill(market.accounts[buyerOrder.participantId], maker.symbol, 'buy', price, quantity, buyerFee, buyerOrder.id === maker.id ? 'maker' : 'taker');
  applyFill(market.accounts[sellerOrder.participantId], maker.symbol, 'sell', price, quantity, sellerFee, sellerOrder.id === maker.id ? 'maker' : 'taker');
  releaseAfterFill(market, buyerOrder, buyerDebit, quantity);
  releaseAfterFill(market, sellerOrder, 0, quantity);
  market.tradeSequence += 1;
  const trade: Trade = {
    id: `T-${String(market.tradeSequence).padStart(8, '0')}`, simTime: simTime(market), tick: market.tick, symbol: maker.symbol,
    price, quantity, aggressorSide: taker.side, buyerId: buyerOrder.participantId, sellerId: sellerOrder.participantId,
    makerId: maker.participantId, takerId: taker.participantId, makerOrderId: maker.id, takerOrderId: taker.id,
    makerSide: maker.side, takerSide: taker.side, makerFee, takerFee, buyerFee, sellerFee, grossAmount: gross,
    buyerCashChange: -buyerDebit, sellerCashChange: roundCurrency(gross - sellerFee), feeRate: takerFee > 0 ? rates.taker : rates.maker, feeCurrency: '酒币',
  };
  market.trades.unshift(trade);
  const asset = market.assets[maker.symbol];
  asset.lastPrice = price;
  asset.volume += quantity;
  asset.priceHistory.push({ tick: market.tick, price });
}

function processIncomingOrder(market: Market, order: Order): void {
  if (order.status === 'pending_cancel') { cancelOrder(market, order); return; }
  const book = market.books[order.symbol];
  const opposing = order.side === 'buy' ? book.asks : book.bids;
  let hadFill = false;
  while (order.remaining > 0 && opposing.length > 0) {
    const maker = opposing[0];
    const crosses = order.type === 'market' || (order.side === 'buy' ? order.limitPrice! >= maker.limitPrice! : order.limitPrice! <= maker.limitPrice!);
    if (!crosses) break;
    const before = order.remaining;
    executeTrade(market, maker, order, Math.min(order.remaining, maker.remaining));
    if (order.remaining === before) break;
    hadFill = true;
    if (maker.remaining === 0) {
      opposing.shift();
      releaseReservation(market, maker);
      maker.status = 'filled';
    } else maker.status = 'partial';
  }
  if (order.remaining === 0) {
    releaseReservation(market, order);
    order.status = 'filled';
  } else if (order.type === 'market') {
    releaseReservation(market, order);
    order.status = 'cancelled';
    if (order.participantId === 'player') market.notices.unshift(hadFill ? `${order.id} partially filled; the remainder was automatically cancelled.` : `${order.id} found no affordable opposing liquidity and was cancelled.`);
  } else {
    insertRestingOrder(market, order);
  }
}

function processCancels(market: Market): void {
  for (const id of market.pendingCancelIds.splice(0)) {
    const order = market.orders[id];
    if (!order || ['filled', 'cancelled'].includes(order.status)) continue;
    cancelOrder(market, order);
    if (order.participantId === 'player') market.notices.unshift(`${order.id} cancelled at auction tick ${market.tick}.`);
  }
}

function captureSnapshots(market: Market): void {
  for (const asset of Object.values(market.assets)) {
    const symbol = asset.definition.symbol;
    const quotes = getQuotes(market, symbol);
    for (const side of ['buy', 'sell'] as Side[]) {
      const levels = getBookLevels(market, symbol, side);
      for (let index = 0; index < 5; index += 1) {
        const level = levels[index];
        const record: BookSnapshot = {
          simTime: simTime(market), tick: market.tick, symbol, side, level: index + 1,
          price: level?.price ?? null, quantity: level?.quantity ?? 0, orderCount: level?.orderCount ?? 0,
          bestBid: quotes.bestBid, bestAsk: quotes.bestAsk, midPrice: quotes.mid, spread: quotes.spread,
        };
        market.snapshots.push(record);
      }
    }
  }
}

export function accountMetrics(market: Market, account: Account): { positionValue: number; unrealized: number; totalAsset: number; totalPnl: number; netPosition: number } {
  let positionValue = 0;
  let unrealized = 0;
  let netPosition = 0;
  for (const instrument of INSTRUMENTS) {
    const position = account.positions[instrument.symbol];
    const price = market.assets[instrument.symbol].lastPrice;
    positionValue += position.quantity * price;
    unrealized += position.quantity * (price - position.averageCost);
    netPosition += position.quantity;
  }
  const totalAsset = roundCurrency(account.cash + positionValue);
  return { positionValue: roundCurrency(positionValue), unrealized: roundCurrency(unrealized), totalAsset, totalPnl: roundCurrency(totalAsset - account.initialNetAsset), netPosition };
}

function captureParticipantSnapshots(market: Market): void {
  for (const account of Object.values(market.accounts)) {
    const metrics = accountMetrics(market, account);
    const row: ParticipantSnapshot = {
      simTime: simTime(market), tick: market.tick, participantId: account.id, participantType: account.type,
      traderStyle: account.style ?? 'player', cashBalance: account.cash, totalPositionValue: metrics.positionValue,
      realizedPnl: account.realizedPnl, unrealizedPnl: metrics.unrealized, totalPnl: metrics.totalPnl,
      makerFeeTotal: account.makerFees, takerFeeTotal: account.takerFees, totalFee: roundCurrency(account.makerFees + account.takerFees),
      tradeCount: account.tradeCount, netPosition: metrics.netPosition,
    };
    market.participantSnapshots.push(row);
  }
}

export function advanceTick(market: Market): Market {
  market.tick += 1;
  market.notices = [];
  processCancels(market);
  pruneNpcLiquidity(market);
  if (market.tick >= market.nextEventTick) makeEvent(market);
  updateFairValues(market);
  generateNpcOrders(market);
  const incoming = market.pendingOrderIds.splice(0).map((id) => market.orders[id]).filter((order): order is Order => Boolean(order)).sort((a, b) => a.sequence - b.sequence);
  for (const order of incoming) processIncomingOrder(market, order);
  captureSnapshots(market);
  captureParticipantSnapshots(market);
  return market;
}

export function clearAccumulatedData(market: Market): { recordsRemoved: number; ordersRemoved: number } {
  const chartPoints = Object.values(market.assets).reduce((total, asset) => total + asset.priceHistory.length, 0);
  const recordsRemoved = market.trades.length + market.snapshots.length + market.participantSnapshots.length + market.events.length + chartPoints;
  const beforeOrders = Object.keys(market.orders).length;
  const activeStatuses = new Set(['queued', 'open', 'partial', 'pending_cancel']);
  market.orders = Object.fromEntries(Object.entries(market.orders).filter(([, order]) => activeStatuses.has(order.status)));
  const ordersRemoved = beforeOrders - Object.keys(market.orders).length;
  market.trades = [];
  market.snapshots = [];
  market.participantSnapshots = [];
  market.events = [];
  market.latestEvent = undefined;
  for (const asset of Object.values(market.assets)) asset.priceHistory = [];
  captureSnapshots(market);
  captureParticipantSnapshots(market);
  market.notices = [`Cleared ${recordsRemoved.toLocaleString()} cached history records and ${ordersRemoved.toLocaleString()} completed orders at tick ${market.tick}.`];
  return { recordsRemoved, ordersRemoved };
}

export function displayTime(market: Market): string {
  return new Date(market.simStartMs + market.tick * 1000).toLocaleString();
}

export function formatPrice(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(1);
}

export function formatPnl(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

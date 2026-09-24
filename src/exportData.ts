import type { Market } from './types';
import type { StrategySession } from './strategy';

function escapeCsv(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function createCsv(columns: string[], rows: Array<Record<string, string | number | null | undefined>>): string {
  return `\uFEFF${columns.join(',')}\n${rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(',')).join('\n')}`;
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportMarketData(market: Market, strategy?: StrategySession): void {
  const tradesColumns = [
    'sim_time', 'tick', 'trade_id', 'symbol', 'price', 'quantity', 'aggressor_side', 'buyer_id', 'seller_id',
    'maker_order_id', 'taker_order_id', 'maker_id', 'taker_id', 'maker_side', 'taker_side', 'maker_fee', 'taker_fee',
    'buyer_fee', 'seller_fee', 'gross_amount', 'buyer_cash_change', 'seller_cash_change', 'fee_rate', 'fee_currency',
  ];
  download('trades.csv', createCsv(tradesColumns, market.trades.slice().reverse().map((trade) => ({
    sim_time: trade.simTime, tick: trade.tick, trade_id: trade.id, symbol: trade.symbol, price: trade.price, quantity: trade.quantity,
    aggressor_side: trade.aggressorSide, buyer_id: trade.buyerId, seller_id: trade.sellerId, maker_order_id: trade.makerOrderId,
    taker_order_id: trade.takerOrderId, maker_id: trade.makerId, taker_id: trade.takerId, maker_side: trade.makerSide,
    taker_side: trade.takerSide, maker_fee: trade.makerFee, taker_fee: trade.takerFee, buyer_fee: trade.buyerFee,
    seller_fee: trade.sellerFee, gross_amount: trade.grossAmount, buyer_cash_change: trade.buyerCashChange,
    seller_cash_change: trade.sellerCashChange, fee_rate: trade.feeRate, fee_currency: trade.feeCurrency,
  }))));

  const bookColumns = ['sim_time', 'tick', 'symbol', 'side', 'level', 'price', 'quantity', 'order_count', 'best_bid', 'best_ask', 'mid_price', 'spread'];
  download('orderbook_1s.csv', createCsv(bookColumns, market.snapshots.map((row) => ({
    sim_time: row.simTime, tick: row.tick, symbol: row.symbol, side: row.side, level: row.level, price: row.price,
    quantity: row.quantity, order_count: row.orderCount, best_bid: row.bestBid, best_ask: row.bestAsk, mid_price: row.midPrice, spread: row.spread,
  }))));

  const pnlColumns = [
    'sim_time', 'tick', 'participant_id', 'participant_type', 'trader_style', 'cash_balance', 'total_position_value',
    'realized_pnl', 'unrealized_pnl', 'total_pnl', 'maker_fee_total', 'taker_fee_total', 'total_fee', 'trade_count', 'net_position',
  ];
  download('participant_pnl_1s.csv', createCsv(pnlColumns, market.participantSnapshots.map((row) => ({
    sim_time: row.simTime, tick: row.tick, participant_id: row.participantId, participant_type: row.participantType,
    trader_style: row.traderStyle, cash_balance: row.cashBalance, total_position_value: row.totalPositionValue,
    realized_pnl: row.realizedPnl, unrealized_pnl: row.unrealizedPnl, total_pnl: row.totalPnl,
    maker_fee_total: row.makerFeeTotal, taker_fee_total: row.takerFeeTotal, total_fee: row.totalFee,
    trade_count: row.tradeCount, net_position: row.netPosition,
  }))));

  if (!strategy) return;
  const barsColumns = [
    'sim_time', 'tick', 'bar_index', 'symbol', 'open', 'high', 'low', 'close', 'volume',
    'best_bid', 'best_ask', 'mid', 'spread', 'bid_quantity', 'ask_quantity', 'fair_value', 'fair_value_gap',
    'momentum_1', 'momentum_5', 'book_imbalance', 'spread_bps', 'event_signal', 'up_probability', 'expected_return',
    'position_quantity', 'available_quantity', 'reserved_quantity', 'average_cost', 'account_cash', 'account_available_cash',
    'account_frozen_cash', 'account_total_asset', 'account_position_value', 'account_unrealized_pnl', 'event_tick',
    'event_direction', 'event_symbols', 'event_impact', 'event_permanent_share',
    'aggressive_buy_volume_5', 'aggressive_sell_volume_5', 'aggressive_buy_volume_20', 'aggressive_sell_volume_20',
    'aggressive_buy_volume_50', 'aggressive_sell_volume_50', 'orderbook_history_json', 'open_orders_json',
  ];
  download('strategy_bars.csv', createCsv(barsColumns, strategy.bars.map((bar) => ({
    sim_time: bar.simTime, tick: bar.tick, bar_index: bar.barIndex, symbol: bar.symbol, open: bar.open, high: bar.high,
    low: bar.low, close: bar.close, volume: bar.volume, best_bid: bar.bestBid, best_ask: bar.bestAsk, mid: bar.mid,
    spread: bar.spread, bid_quantity: bar.bidQuantity, ask_quantity: bar.askQuantity, fair_value: bar.fairValue,
    fair_value_gap: bar.fairValueGap, momentum_1: bar.momentum1, momentum_5: bar.momentum5,
    book_imbalance: bar.bookImbalance, spread_bps: bar.spreadBps, event_signal: bar.eventSignal,
    up_probability: bar.upProbability, expected_return: bar.expectedReturn, position_quantity: bar.positionQuantity,
    available_quantity: bar.availableQuantity, reserved_quantity: bar.reservedQuantity, average_cost: bar.averageCost,
    account_cash: bar.accountCash, account_available_cash: bar.accountAvailableCash, account_frozen_cash: bar.accountFrozenCash,
    account_total_asset: bar.accountTotalAsset, account_position_value: bar.accountPositionValue,
    account_unrealized_pnl: bar.accountUnrealizedPnl, event_tick: bar.eventTick, event_direction: bar.eventDirection,
    event_symbols: bar.eventSymbols, event_impact: bar.eventImpact, event_permanent_share: bar.eventPermanentShare,
    aggressive_buy_volume_5: bar.aggressiveBuyVolume5, aggressive_sell_volume_5: bar.aggressiveSellVolume5,
    aggressive_buy_volume_20: bar.aggressiveBuyVolume20, aggressive_sell_volume_20: bar.aggressiveSellVolume20,
    aggressive_buy_volume_50: bar.aggressiveBuyVolume50, aggressive_sell_volume_50: bar.aggressiveSellVolume50,
    orderbook_history_json: bar.orderbookHistoryJson,
    open_orders_json: bar.openOrdersJson,
  }))));

  const runsColumns = ['sim_time', 'tick', 'bar_index', 'model_version', 'status', 'duration_ms', 'order_count', 'message', 'intents_json'];
  download('strategy_runs.csv', createCsv(runsColumns, strategy.runs.map((run) => ({
    sim_time: run.simTime, tick: run.tick, bar_index: run.barIndex, model_version: run.modelVersion, status: run.status,
    duration_ms: run.durationMs, order_count: run.orderCount, message: run.message, intents_json: run.intentsJson,
  }))));

  const ordersColumns = ['sim_time', 'tick', 'bar_index', 'mode', 'action', 'order_type', 'side', 'symbol', 'quantity', 'price', 'order_id', 'message'];
  download('strategy_orders.csv', createCsv(ordersColumns, strategy.orders.map((order) => ({
    sim_time: order.simTime, tick: order.tick, bar_index: order.barIndex, mode: order.mode, action: order.action,
    order_type: order.orderType, side: order.side, symbol: order.symbol, quantity: order.quantity, price: order.price,
    order_id: order.orderId, message: order.message,
  }))));
}

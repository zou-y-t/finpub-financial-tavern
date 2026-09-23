import type { Market } from './types';

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

export function exportMarketData(market: Market): void {
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
}

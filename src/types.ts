export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type OrderStatus = 'queued' | 'open' | 'partial' | 'filled' | 'pending_cancel' | 'cancelled' | 'rejected';
export type TraderStyle = 'market_maker' | 'value' | 'trend' | 'news' | 'noise';
export type ParticipantType = 'player' | 'npc';

export interface InstrumentDefinition {
  symbol: string;
  name: string;
  category: 'Wine' | 'Whisky' | 'Sake' | 'Rum' | 'Champagne' | 'Cider';
  tickSize: number;
  initialPrice: number;
}

export interface Position {
  quantity: number;
  reserved: number;
  averageCost: number;
}

export interface Account {
  id: string;
  type: ParticipantType;
  name: string;
  style?: TraderStyle;
  cash: number;
  initialNetAsset: number;
  positions: Record<string, Position>;
  realizedPnl: number;
  makerFees: number;
  takerFees: number;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
  reservedCash: number;
}

export interface NpcProfile {
  id: string;
  style: TraderStyle;
  valuationBias: Record<string, number>;
  sensitivity: number;
  targetInventory: Record<string, number>;
  maxOrderSize: number;
}

export interface Order {
  id: string;
  participantId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  limitPrice?: number;
  quantity: number;
  remaining: number;
  submittedTick: number;
  sequence: number;
  status: OrderStatus;
  reservedCash: number;
  reservedQuantity: number;
}

export interface Book {
  bids: Order[];
  asks: Order[];
}

export interface Trade {
  id: string;
  simTime: string;
  tick: number;
  symbol: string;
  price: number;
  quantity: number;
  aggressorSide: Side;
  buyerId: string;
  sellerId: string;
  makerId: string;
  takerId: string;
  makerOrderId: string;
  takerOrderId: string;
  makerSide: Side;
  takerSide: Side;
  makerFee: number;
  takerFee: number;
  buyerFee: number;
  sellerFee: number;
  grossAmount: number;
  buyerCashChange: number;
  sellerCashChange: number;
  feeRate: number;
  feeCurrency: string;
}

export interface BookSnapshot {
  simTime: string;
  tick: number;
  symbol: string;
  side: Side;
  level: number;
  price: number | null;
  quantity: number;
  orderCount: number;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
}

export interface ParticipantSnapshot {
  simTime: string;
  tick: number;
  participantId: string;
  participantType: ParticipantType;
  traderStyle: string;
  cashBalance: number;
  totalPositionValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  makerFeeTotal: number;
  takerFeeTotal: number;
  totalFee: number;
  tradeCount: number;
  netPosition: number;
}

export interface MarketEvent {
  id: string;
  tick: number;
  simTime: string;
  title: string;
  description: string;
  symbols: string[];
  direction: 'bullish' | 'bearish';
  impact: number;
  permanentShare: number;
}

export interface AssetState {
  definition: InstrumentDefinition;
  lastPrice: number;
  previousClose: number;
  volume: number;
  fairValue: number;
  permanentShift: number;
  transientShift: number;
  eventVolatility: number;
  priceHistory: Array<{ tick: number; price: number }>;
}

export interface MarketConfig {
  playerCash: number;
  playerPositions: Record<string, number>;
  npcCount: number;
  makerFeeRate: number;
  takerFeeRate: number;
  feesEnabled: boolean;
  seed: number;
  startTime: string;
  initialPrices: Record<string, number>;
}

export interface Market {
  config: MarketConfig;
  tick: number;
  sequence: number;
  tradeSequence: number;
  simStartMs: number;
  assets: Record<string, AssetState>;
  books: Record<string, Book>;
  accounts: Record<string, Account>;
  npcProfiles: Record<string, NpcProfile>;
  orders: Record<string, Order>;
  pendingOrderIds: string[];
  pendingCancelIds: string[];
  trades: Trade[];
  snapshots: BookSnapshot[];
  participantSnapshots: ParticipantSnapshot[];
  events: MarketEvent[];
  latestEvent?: MarketEvent;
  nextEventTick: number;
  rngState: number;
  notices: string[];
}

export interface BookLevel {
  price: number;
  quantity: number;
  orderCount: number;
  hasPlayerOrder: boolean;
}

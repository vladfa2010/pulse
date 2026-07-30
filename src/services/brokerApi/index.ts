/**
 * =============================================================================
 * PULSE — Broker API adapters
 * =============================================================================
 *
 * Unified interface for read-only broker integrations. Each adapter accepts a
 * single token and hides provider-specific auth (secret→JWT for Finam,
 * refresh→access rotation for BCS).
 */

export type Broker = 'inside' | 'finam' | 'bcs';

export interface BrokerPosition {
  ticker: string;
  exchange: string;
  companyName?: string;
  quantity: number;
  avgPrice?: number | null;
  currency: string;
  externalId?: string;
}

export interface TestKeyResult {
  ok: boolean;
  positionsCount?: number;
  error?: string;
  newToken?: string; // For adapters that rotate refresh tokens (BCS)
}

export interface BrokerAdapter {
  broker: Broker;
  testKey(token: string): Promise<TestKeyResult>;
  getPositions(token: string): Promise<{ positions: BrokerPosition[]; newToken?: string }>;
}

export function getBrokerAdapter(broker: string): BrokerAdapter {
  switch (broker) {
    case 'inside':
      return require('./insideAdapter').default as BrokerAdapter;
    case 'finam':
      return require('./finamAdapter').default as BrokerAdapter;
    case 'bcs':
      return require('./bcsAdapter').default as BrokerAdapter;
    default:
      throw new Error(`Unsupported broker: ${broker}`);
  }
}

// Re-export adapter modules for direct imports if needed
export { default as finamAdapter } from './finamAdapter';
export { default as bcsAdapter } from './bcsAdapter';
export { default as insideAdapter } from './insideAdapter';

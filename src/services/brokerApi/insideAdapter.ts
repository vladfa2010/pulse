/**
 * PULSE — Inside broker adapter (TBD)
 *
 * Placeholder until the customer provides the REST API spec.
 */

import { BrokerAdapter, TestKeyResult, BrokerPosition } from './index';

const insideAdapter: BrokerAdapter = {
  broker: 'inside',

  async testKey(_token: string): Promise<TestKeyResult> {
    return { ok: false, error: 'broker_unavailable' };
  },

  async getPositions(_token: string): Promise<{ positions: BrokerPosition[] }> {
    return { positions: [] };
  },
};

export default insideAdapter;

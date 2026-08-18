/**
 * =============================================================================
 * PULSE — Unit tests for addBillingPeriod
 * =============================================================================
 *
 * ADM-H: единая арифметика периода подписки в днях.
 * Run: npx ts-node src/tests/addBillingPeriod.test.ts
 */

import { addBillingPeriod } from '../services/subscription';

interface TestCase {
  name: string;
  base: Date;
  billingFrequency: string;
  expectedDays: number;
}

function runTests() {
  const base = new Date('2026-01-15T12:00:00.000Z');

  const cases: TestCase[] = [
    { name: 'weekly', base, billingFrequency: 'weekly', expectedDays: 7 },
    { name: 'monthly', base, billingFrequency: 'monthly', expectedDays: 30 },
    { name: 'quarterly', base, billingFrequency: 'quarterly', expectedDays: 90 },
    { name: 'yearly', base, billingFrequency: 'yearly', expectedDays: 365 },
    { name: 'unknown fallback', base, billingFrequency: 'unknown', expectedDays: 30 },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const result = addBillingPeriod(tc.base, tc.billingFrequency);
    const actualDays = Math.round((result.getTime() - tc.base.getTime()) / (24 * 60 * 60 * 1000));
    const ok = actualDays === tc.expectedDays;

    if (ok) {
      console.log(`✅ ${tc.name}: +${actualDays} days`);
      passed++;
    } else {
      console.log(`❌ ${tc.name}: expected +${tc.expectedDays}, got +${actualDays}`);
      failed++;
    }
  }

  // Regression: 31 Jan + 1 month must be 2 Mar (30 days), not 3 Mar
  const jan31 = new Date('2026-01-31T12:00:00.000Z');
  const fromJan31 = addBillingPeriod(jan31, 'monthly');
  const expectedFeb28 = new Date('2026-03-02T12:00:00.000Z'); // Jan 31 + 30 days
  const feb28Ok = fromJan31.getTime() === expectedFeb28.getTime();

  if (feb28Ok) {
    console.log('✅ 31 Jan + monthly = 2 Mar (30 days, no setMonth overflow)');
    passed++;
  } else {
    console.log(`❌ 31 Jan + monthly: expected ${expectedFeb28.toISOString()}, got ${fromJan31.toISOString()}`);
    failed++;
  }

  // Accumulation from future expires_at (not NOW)
  const futureBase = new Date('2026-12-01T00:00:00.000Z');
  const addTwoMonths = addBillingPeriod(
    new Date(futureBase.getTime() + 30 * 24 * 60 * 60 * 1000),
    'monthly'
  );
  const twoMonthsDays = Math.round((addTwoMonths.getTime() - futureBase.getTime()) / (24 * 60 * 60 * 1000));
  const accumulationOk = twoMonthsDays === 60;

  if (accumulationOk) {
    console.log('✅ future base + 2x monthly accumulates 60 days');
    passed++;
  } else {
    console.log(`❌ future base accumulation: expected 60 days, got ${twoMonthsDays}`);
    failed++;
  }

  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

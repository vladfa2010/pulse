/**
 * =============================================================================
 * PULSE — Zod Schemas (Payment)
 * =============================================================================
 */

import { z } from 'zod';

export const CreatePaymentSchema = z.object({
  planId: z.string().regex(/^[a-z0-9_-]+$/).max(20),
  billingCycle: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  isUpgrade: z.boolean().default(false),
  method: z.string().max(50).default('bank_card'),
  promoCode: z.string().max(50).optional(),
  // legacy fields, ignored
  amount: z.number().optional(),
  discount: z.number().optional(),
});

export const ConfirmPaymentSchema = z.object({
  paymentId: z.string().uuid('Некорректный ID платежа'),
});

export const UpgradePreviewSchema = z.object({
  targetPlan: z.string().regex(/^[a-z0-9_-]+$/).max(20),
  billingCycle: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type ConfirmPaymentInput = z.infer<typeof ConfirmPaymentSchema>;

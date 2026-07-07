/**
 * =============================================================================
 * PULSE — Zod Schemas (Payment)
 * =============================================================================
 */

import { z } from 'zod';

export const CreatePaymentSchema = z.object({
  planId: z.enum(['free', 'base', 'premium', 'club', 'pro']),
  billingCycle: z.enum(['monthly', 'yearly']),
  isUpgrade: z.boolean().default(false),
  method: z.string().max(50).default('bank_card'),
  // legacy fields, ignored
  amount: z.number().optional(),
  discount: z.number().optional(),
});

export const ConfirmPaymentSchema = z.object({
  paymentId: z.string().uuid('Некорректный ID платежа'),
});

export const UpgradePreviewSchema = z.object({
  targetPlan: z.enum(['base', 'premium', 'club', 'pro']),
  billingCycle: z.enum(['monthly', 'yearly']),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type ConfirmPaymentInput = z.infer<typeof ConfirmPaymentSchema>;

/**
 * =============================================================================
 * PULSE — Zod Schemas (Promo Codes, Plans, Features)
 * =============================================================================
 */

import { z } from 'zod';

export const CreatePlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/).max(20),
  name: z.string().min(1).max(50),
  price: z.number().min(0),
  billing_frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).default('monthly'),
  yearly_discount: z.number().int().min(0).max(100).default(0),
  tag_limit: z.number().int().min(-1),
  plan_level: z.number().int().min(0),
  features: z.record(z.any()).default({}),
  is_active: z.boolean().default(true),
  is_popular: z.boolean().default(false),
  coming_soon_label: z.string().max(50).nullable().optional(),
  display_order: z.number().int().min(0),
});

export const UpdatePlanSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  price: z.number().min(0).optional(),
  billing_frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).optional(),
  yearly_discount: z.number().int().min(0).max(100).optional(),
  tag_limit: z.number().int().min(-1).optional(),
  features: z.record(z.any()).optional(),
  is_active: z.boolean().optional(),
  is_popular: z.boolean().optional(),
  coming_soon_label: z.string().max(50).nullable().optional(),
  display_order: z.number().int().min(0).optional(),
});

export const CreatePromoCodeSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_-]+$/).max(50),
  description: z.string().max(255).optional(),
  discount_type: z.enum(['percent', 'trial']),
  discount_value: z.number().int().min(1).max(365),
  applicable_plans: z.array(z.string().max(20)).optional(),
  max_uses: z.number().int().min(1).optional(),
  valid_from: z.string().datetime().optional(),
  expires_at: z.string().datetime().optional(),
});

export const UpdatePromoCodeSchema = z.object({
  description: z.string().max(255).optional(),
  discount_type: z.enum(['percent', 'trial']).optional(),
  discount_value: z.number().int().min(1).max(365).optional(),
  applicable_plans: z.array(z.string().max(20)).optional(),
  max_uses: z.number().int().min(1).optional(),
  valid_from: z.string().datetime().optional(),
  expires_at: z.string().datetime().optional(),
  is_active: z.boolean().optional(),
});

export const ValidatePromoQuerySchema = z.object({
  code: z.string().min(1).max(50),
  planId: z.string().regex(/^[a-z0-9_-]+$/).max(20),
});

export const CreateFeatureSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/).max(50),
  label: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
  is_active: z.boolean().default(true),
});

export const UpdateFeatureSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  description: z.string().max(255).optional(),
  is_active: z.boolean().optional(),
});

export type CreatePlanInput = z.infer<typeof CreatePlanSchema>;
export type UpdatePlanInput = z.infer<typeof UpdatePlanSchema>;
export type CreatePromoCodeInput = z.infer<typeof CreatePromoCodeSchema>;
export type UpdatePromoCodeInput = z.infer<typeof UpdatePromoCodeSchema>;
export type ValidatePromoQueryInput = z.infer<typeof ValidatePromoQuerySchema>;
export type CreateFeatureInput = z.infer<typeof CreateFeatureSchema>;
export type UpdateFeatureInput = z.infer<typeof UpdateFeatureSchema>;

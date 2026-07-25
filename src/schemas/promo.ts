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
  features: z.record(z.boolean()).default({}),
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
  features: z.record(z.boolean()).optional(),
  is_active: z.boolean().optional(),
  is_popular: z.boolean().optional(),
  coming_soon_label: z.string().max(50).nullable().optional(),
  display_order: z.number().int().min(0).optional(),
});

export const CreatePromoCodeSchema = z.object({
  code: z.string()
    .min(1, 'Code is required.')
    .regex(/^[A-Z0-9_]+$/, 'Code: only uppercase A-Z, 0-9, _')
    .max(50, 'Maximum 50 characters.'),
  description: z.string().max(255, 'Maximum 255 characters.').optional().or(z.literal('')),
  discount_type: z.enum(['percent', 'trial'], { required_error: 'Select a type.' }),
  discount_value: z.number({ required_error: 'Enter a value.', invalid_type_error: 'Enter a value.' })
    .int('Enter an integer.')
    .min(1, 'Minimum 1.'),
  applicable_plans: z.array(z.string().max(20)).optional().nullable(),
  max_uses: z.union([
    z.number().int().min(1, 'Must be at least 1 or empty.'),
    z.null(),
    z.literal(''),
  ]).optional(),
  valid_from: z.string({ required_error: 'Select a start date.' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD).'),
  expires_at: z.string({ required_error: 'Select an end date.' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD).'),
}).superRefine((data, ctx) => {
  const maxValue = data.discount_type === 'percent' ? 100 : 365;
  const valueMsg = data.discount_type === 'percent' ? 'Enter 1-100.' : 'Enter 1-365 days.';
  if (data.discount_value > maxValue) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: maxValue,
      type: 'number',
      inclusive: true,
      message: valueMsg,
      path: ['discount_value'],
    });
  }

  const validFromDate = new Date(data.valid_from);
  const expiresAtDate = new Date(data.expires_at);
  if (expiresAtDate <= validFromDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must be after Valid From.',
      path: ['expires_at'],
    });
  }
});

export const UpdatePromoCodeSchema = z.object({
  description: z.string().max(255, 'Maximum 255 characters.').optional().or(z.literal('')),
  discount_type: z.enum(['percent', 'trial'], { required_error: 'Select a type.' }).optional(),
  discount_value: z.number({ invalid_type_error: 'Enter a value.' }).int('Enter an integer.').min(1, 'Minimum 1.').optional(),
  applicable_plans: z.array(z.string().max(20)).optional().nullable(),
  max_uses: z.union([
    z.number().int().min(1, 'Must be at least 1 or empty.'),
    z.null(),
    z.literal(''),
  ]).optional(),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD).').optional(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD).').optional(),
  is_active: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.discount_type && data.discount_value !== undefined && data.discount_value !== null) {
    const maxValue = data.discount_type === 'percent' ? 100 : 365;
    const valueMsg = data.discount_type === 'percent' ? 'Enter 1-100.' : 'Enter 1-365 days.';
    if (data.discount_value > maxValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: maxValue,
        type: 'number',
        inclusive: true,
        message: valueMsg,
        path: ['discount_value'],
      });
    }
  }
  if (data.valid_from && data.expires_at) {
    const validFromDate = new Date(data.valid_from);
    const expiresAtDate = new Date(data.expires_at);
    if (expiresAtDate <= validFromDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must be after Valid From.',
        path: ['expires_at'],
      });
    }
  }
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

/**
 * =============================================================================
 * PULSE — Zod Schemas (User)
 * =============================================================================
 */

import { z } from 'zod';

export const AddTagSchema = z.object({
  tagId: z.string()
    .min(1, 'ID тега обязателен')
    .max(50, 'Максимум 50 символов'),
  tagName: z.string()
    .min(1, 'Название тега обязательно')
    .max(100, 'Максимум 100 символов'),
  tagType: z.string()
    .max(20, 'Максимум 20 символов')
    .default('company'),
});

export type AddTagInput = z.infer<typeof AddTagSchema>;

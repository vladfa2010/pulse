/**
 * =============================================================================
 * PULSE — Zod Schemas (User)
 * =============================================================================
 */

import { z } from 'zod';

// Допустимые типы тегов (синхронизировано с tagManager.ts)
const VALID_TAG_TYPES = [
  'company', 'ticker', 'sector', 'trend', 'person', 'commodity', 'index', 'currency'
] as const;

export const AddTagSchema = z.object({
  tagId: z.string()
    .min(1, 'ID тега обязателен')
    .max(50, 'Максимум 50 символов'),
  tagName: z.string()
    .min(1, 'Название тега обязательно')
    .max(100, 'Максимум 100 символов'),
  tagType: z.enum([...VALID_TAG_TYPES, 'auto'] as const)
    .default('auto'),
});

export type AddTagInput = z.infer<typeof AddTagSchema>;

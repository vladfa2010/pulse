/**
 * =============================================================================
 * PULSE — Zod Schemas (Auth)
 * =============================================================================
 *
 * Все схемы валидации для auth endpoints.
 * TypeScript-first: типы выводятся автоматически из схем.
 */

import { z } from 'zod';

// ─── Регистрация ──────────────────────────────────────────────────────────
export const RegisterSchema = z.object({
  email: z.string()
    .min(1, 'Email обязателен')
    .email('Некорректный email'),
  username: z.string()
    .min(1, 'Имя пользователя обязательно')
    .max(50, 'Максимум 50 символов'),
  password: z.string()
    .min(8, 'Минимум 8 символов')
    .max(128, 'Максимум 128 символов'),
});

// ─── Логин ────────────────────────────────────────────────────────────────
export const LoginSchema = z.object({
  email: z.string()
    .min(1, 'Email обязателен')
    .email('Некорректный email'),
  password: z.string()
    .min(1, 'Пароль обязателен')
    .max(128, 'Максимум 128 символов'),
});

// ─── Типы (выводятся из схем) ───────────────────────────────────────────
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;

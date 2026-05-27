/**
 * =============================================================================
 * PULSE — Zod Schemas (Payment)
 * =============================================================================
 */

import { z } from 'zod';

export const CreatePaymentSchema = z.object({
  amount: z.number()
    .int('Сумма должна быть целым числом')
    .min(1, 'Минимальная сумма 1 копейка')
    .max(1000000, 'Максимальная сумма 10,000 ₽'),
  discount: z.number()
    .int('Скидка целое число')
    .min(0, 'Скидка не может быть отрицательной')
    .max(100, 'Максимальная скидка 100%')
    .default(0),
  method: z.string()
    .max(50)
    .default('bank_card'),
});

export const ConfirmPaymentSchema = z.object({
  paymentId: z.string()
    .uuid('Некорректный ID платежа'),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type ConfirmPaymentInput = z.infer<typeof ConfirmPaymentSchema>;

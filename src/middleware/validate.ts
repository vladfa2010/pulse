/**
 * =============================================================================
 * PULSE — Zod Validation Middleware
 * =============================================================================
 *
 * Task 3: Input validation для всех API endpoints.
 * Используем Zod — TypeScript-first schema validation.
 *
 * Пример использования:
 *   router.post('/login', validate(LoginSchema), async (req, res) => {
 *     // req.body уже провалидирован
 *   })
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * validate — middleware для проверки req.body через Zod схему
 * При ошибке валидации → 400 Bad Request с деталями
 */
export function validate<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = req.method === 'GET' ? req.query : req.body;
      const parsed = schema.parse(input);
      if (req.method === 'GET') {
        req.query = parsed as any;
      } else {
        req.body = parsed;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues.map(i => ({
          field: i.path.join('.'),
          message: i.message,
        }));
        return res.status(400).json({
          error: 'Validation failed',
          details: issues,
        });
      }
      return res.status(400).json({ error: 'Invalid input' });
    }
  };
}

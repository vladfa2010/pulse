import { z } from 'zod';

export const VoteSchema = z.object({
  value: z.number().int().refine(v => [-1, 0, 1].includes(v), {
    message: 'value must be -1, 0 or 1',
  }),
});

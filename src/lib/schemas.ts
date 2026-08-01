import { z } from 'zod';

/** Request schemas shared by more than one route handler. */

export const segmentQuerySchema = z.object({
  signupAfter: z.string().nullable().optional(),
  signupBefore: z.string().nullable().optional(),
  sources: z.array(z.enum(['web_form', 'import', 'api'])).nullable().optional(),
  attributes: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        op: z.enum(['eq', 'ne', 'exists', 'not_exists']),
        value: z.string().max(200).optional(),
      }),
    )
    .nullable()
    .optional(),
  openedInLastNCampaigns: z.number().int().min(1).max(50).nullable().optional(),
});

export const tiptapDocSchema = z
  .object({ type: z.literal('doc'), content: z.array(z.unknown()).optional() })
  .passthrough();

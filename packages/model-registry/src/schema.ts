import { z } from 'zod';

export const sourceModelSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  limit: z
    .looseObject({
      context: z.number().int().nonnegative(),
      output: z.number().int().nonnegative().optional(),
    })
    .optional(),
  tool_call: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  structured_output: z.boolean().optional(),
});

export const sourceProviderSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  npm: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  env: z.array(z.string().min(1)).default([]),
  doc: z.url().optional(),
  models: z.record(z.string().min(1), sourceModelSchema),
});

export const sourceCatalogSchema = z.record(z.string().min(1), sourceProviderSchema);

export type SourceModel = z.infer<typeof sourceModelSchema>;
export type SourceProvider = z.infer<typeof sourceProviderSchema>;
export type SourceCatalog = z.infer<typeof sourceCatalogSchema>;

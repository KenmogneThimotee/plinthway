import { z } from 'zod';

import {
  modelOverrideSchema,
  mcpServerSchema,
  profileIdSchema,
  providerIdSchema,
  secureUrlSchema,
  serverIdSchema,
  toolActionSchema,
} from '@plinthway/config';
import type { WorkProfile } from '@plinthway/shared';

const modelRefSchema = z
  .string()
  .min(3)
  .regex(/^[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
  .refine((value) => !value.split('/').includes('..'), 'Model references cannot traverse paths');

const toolPatternSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]+\.(?:\*|[A-Za-z0-9_.-]+)$/u,
    'Tool rules must use an exact server.tool name or terminal server.* wildcard',
  )
  .refine(
    (value) => !value.slice(0, -1).includes('*'),
    'Tool wildcards are allowed only as terminal server.* patterns',
  );

export const toolRuleSchema = z.strictObject({
  tool: toolPatternSchema,
  action: toolActionSchema,
});

const workProfileInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: profileIdSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  model: z.strictObject({
    primary: modelRefSchema.optional(),
    fallback: z.array(modelRefSchema).default([]),
    parameters: z
      .strictObject({
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .default({}),
  }),
  mcp: z.strictObject({ enabled: z.array(serverIdSchema) }).optional(),
  tools: z.strictObject({
    defaultPolicy: toolActionSchema,
    rules: z.array(toolRuleSchema),
  }),
  agent: z.strictObject({
    instructionsFile: z.string().min(1).optional(),
    maxSteps: z.number().int().min(1).max(100),
    toolTimeoutSeconds: z.number().int().min(1).max(600).optional(),
  }),
  session: z.strictObject({ persist: z.boolean() }),
});

export const workProfileSchema = workProfileInputSchema.transform((value): WorkProfile => ({
  schemaVersion: value.schemaVersion,
  id: value.id,
  name: value.name,
  ...(value.description === undefined ? {} : { description: value.description }),
  model: {
    ...(value.model.primary === undefined ? {} : { primary: value.model.primary }),
    fallback: [...value.model.fallback],
    parameters: {
      ...(value.model.parameters.temperature === undefined
        ? {}
        : { temperature: value.model.parameters.temperature }),
      ...(value.model.parameters.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: value.model.parameters.maxOutputTokens }),
    },
  },
  ...(value.mcp === undefined ? {} : { mcp: { enabled: [...value.mcp.enabled] } }),
  tools: {
    defaultPolicy: value.tools.defaultPolicy,
    rules: value.tools.rules.map((rule) => ({ ...rule })),
  },
  agent: {
    ...(value.agent.instructionsFile === undefined
      ? {}
      : { instructionsFile: value.agent.instructionsFile }),
    maxSteps: value.agent.maxSteps,
    ...(value.agent.toolTimeoutSeconds === undefined
      ? {}
      : { toolTimeoutSeconds: value.agent.toolTimeoutSeconds }),
  },
  session: { persist: value.session.persist },
}));

export type ParsedWorkProfile = z.infer<typeof workProfileSchema>;

export const profileProviderSchema = z
  .strictObject({
    adapter: z.enum(['openai', 'anthropic', 'google', 'openai-compatible', 'openai-chatgpt']),
    baseURL: secureUrlSchema.optional(),
    auth: z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('none') }),
      z.strictObject({ mode: z.literal('api-key'), credential: z.literal('keyring') }),
      z.strictObject({
        mode: z.literal('oauth'),
        service: z.literal('chatgpt'),
        connectionId: z.string().min(1),
      }),
    ]),
    models: z.record(z.string().min(1), modelOverrideSchema).default({}),
  })
  .superRefine((provider, context) => {
    if (provider.adapter === 'openai-chatgpt') {
      if (provider.baseURL !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['baseURL'],
          message: 'ChatGPT subscription requests use the fixed OpenAI resource origin',
        });
      }
      if (provider.auth.mode !== 'oauth') {
        context.addIssue({
          code: 'custom',
          path: ['auth'],
          message: 'The ChatGPT subscription adapter requires a ChatGPT OAuth account',
        });
      }
    } else if (provider.auth.mode === 'oauth') {
      context.addIssue({
        code: 'custom',
        path: ['auth'],
        message: 'ChatGPT OAuth accounts can only be used by the ChatGPT subscription adapter',
      });
    }
  });

export const profileProvidersSchema = z.strictObject({
  schemaVersion: z.literal(1),
  providers: z.record(providerIdSchema, profileProviderSchema),
});

const profileMcpV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  servers: z.record(serverIdSchema, mcpServerSchema),
  enabled: z.array(serverIdSchema),
});

export const mcpRootSchema = z.strictObject({
  uri: z.url().refine((value) => {
    const url = new URL(value);
    return (
      value.startsWith('file://') &&
      url.protocol === 'file:' &&
      url.pathname.startsWith('/') &&
      url.username === '' &&
      url.password === ''
    );
  }, 'MCP roots must use absolute file:// URIs'),
  name: z.string().min(1).max(200).optional(),
});

const profileMcpV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  servers: z.record(serverIdSchema, mcpServerSchema),
  enabled: z.array(serverIdSchema),
  roots: z.array(mcpRootSchema).default([]),
});

export const profileMcpSchema = z.union([
  profileMcpV2Schema,
  profileMcpV1Schema.transform((value) => ({
    schemaVersion: 2 as const,
    servers: value.servers,
    enabled: value.enabled,
    roots: [],
  })),
]);

export const profileBundleSchema = z.strictObject({
  profile: workProfileSchema,
  providers: profileProvidersSchema,
  mcp: profileMcpSchema,
});

export type ProfileProvider = z.infer<typeof profileProviderSchema>;
export type ProfileProviders = z.infer<typeof profileProvidersSchema>;
export type ProfileMcp = z.infer<typeof profileMcpSchema>;
export type ProfileBundle = z.infer<typeof profileBundleSchema>;

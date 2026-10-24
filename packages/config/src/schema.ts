import { z } from 'zod';

import { asProfileId } from '@plinthway/shared';

export const DEFAULT_KEYMAP = Object.freeze({
  commandPalette: 'ctrl+p',
  submit: 'enter',
  newline: 'shift+enter',
  close: 'escape',
  cancel: 'ctrl+c',
  complete: 'tab',
});

const identifierSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const credentialIdSchema = z.string().min(1).max(200);

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.')
  );
}

export const secureUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    context.addIssue({
      code: 'custom',
      message: 'Remote endpoints must use HTTPS; HTTP is allowed only for loopback hosts',
    });
  }
});

export const mcpEndpointUrlSchema = z.url().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    context.addIssue({
      code: 'custom',
      message: 'MCP endpoints must use HTTP or HTTPS',
    });
  }
});

export const profileIdSchema = identifierSchema.transform((value) => asProfileId(value));
export const providerIdSchema = identifierSchema;
export const BUILTIN_TOOL_NAMESPACES = Object.freeze(['filesystem', 'shell'] as const);
export const serverIdSchema = identifierSchema.refine(
  (value) => !(BUILTIN_TOOL_NAMESPACES as readonly string[]).includes(value),
  'MCP server id is reserved for a built-in tool provider',
);
export const toolActionSchema = z.enum(['allow', 'ask', 'deny']);

export const registryConfigSchema = z.strictObject({
  source: secureUrlSchema.default('https://models.dev/api.json'),
  cache: z.boolean().default(true),
  refreshIntervalHours: z.number().int().positive().default(24),
});

export const modelOverrideSchema = z.strictObject({
  name: z.string().min(1).optional(),
  contextLimit: z.number().int().nonnegative().optional(),
  outputLimit: z.number().int().nonnegative().optional(),
  toolCalls: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
});

export const providerConfigSchema = z.strictObject({
  adapter: z.enum(['openai', 'anthropic', 'google', 'openai-compatible', 'openai-chatgpt']),
  authPlugin: z.string().min(1),
  baseURL: secureUrlSchema.optional(),
  models: z.record(z.string().min(3), modelOverrideSchema).default({}),
});

export const DEFAULT_MCP_EXTENSIONS = Object.freeze({
  tasks: false,
  skills: false,
  apps: false,
  oauthClientCredentials: false,
  enterpriseManagedAuth: false,
});

export const mcpExtensionSettingsSchema = z
  .strictObject({
    tasks: z.boolean().default(false),
    skills: z.boolean().default(false),
    apps: z.boolean().default(false),
    oauthClientCredentials: z.boolean().default(false),
    enterpriseManagedAuth: z.boolean().default(false),
  })
  .default(DEFAULT_MCP_EXTENSIONS);

const keyringCredentialSchema = z.strictObject({
  source: z.literal('keyring'),
  id: credentialIdSchema,
});

export const mcpHttpAuthSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({
    mode: z.literal('bearer'),
    credential: keyringCredentialSchema,
  }),
  z.strictObject({
    mode: z.literal('oauth'),
    clientId: z.string().min(1).optional(),
    clientIdMetadataDocument: secureUrlSchema.optional(),
    scopes: z.array(z.string().min(1)).default([]),
  }),
  z.strictObject({
    mode: z.literal('client-credentials'),
    clientId: z.string().min(1),
    issuer: secureUrlSchema,
    authentication: z.enum(['client-secret-basic', 'client-secret-post', 'private-key-jwt']),
    credential: keyringCredentialSchema,
    scopes: z.array(z.string().min(1)).default([]),
    algorithm: z.string().min(1).default('RS256'),
  }),
  z.strictObject({
    mode: z.literal('enterprise'),
    managedProfile: identifierSchema,
  }),
]);

export const mcpServerLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value),
    'MCP server labels must contain printable characters on one line',
  );

const stdioMcpServerSchema = z.strictObject({
  label: mcpServerLabelSchema.optional(),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.array(environmentNameSchema).default([]),
  extensions: mcpExtensionSettingsSchema,
});

const streamableHttpMcpServerSchema = z
  .strictObject({
    label: mcpServerLabelSchema.optional(),
    transport: z.literal('streamable-http'),
    url: mcpEndpointUrlSchema,
    auth: mcpHttpAuthSchema.default({ mode: 'none' }),
    extensions: mcpExtensionSettingsSchema,
  })
  .superRefine((value, context) => {
    if (value.auth.mode === 'client-credentials' && !value.extensions.oauthClientCredentials) {
      context.addIssue({
        code: 'custom',
        path: ['extensions', 'oauthClientCredentials'],
        message: 'OAuth Client Credentials must be explicitly enabled',
      });
    }
    if (value.auth.mode === 'enterprise' && !value.extensions.enterpriseManagedAuth) {
      context.addIssue({
        code: 'custom',
        path: ['extensions', 'enterpriseManagedAuth'],
        message: 'Enterprise-Managed Authorization must be explicitly enabled',
      });
    }
  });

const legacyStreamableHttpMcpServerSchema = z
  .strictObject({
    label: mcpServerLabelSchema.optional(),
    transport: z.literal('streamable-http'),
    url: mcpEndpointUrlSchema,
    authPlugin: z.string().min(1),
    auth: z
      .strictObject({
        mode: z.literal('bearer'),
        credential: z.strictObject({
          source: z.literal('plugin'),
          id: credentialIdSchema,
        }),
      })
      .optional(),
    extensions: mcpExtensionSettingsSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.auth !== undefined && value.auth.credential.id !== value.authPlugin) {
      context.addIssue({
        code: 'custom',
        path: ['auth', 'credential', 'id'],
        message: 'Legacy MCP authentication must match authPlugin',
      });
    }
    if (
      value.extensions !== undefined &&
      Object.values(value.extensions).some((enabled) => enabled)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['extensions'],
        message: 'Legacy MCP servers do not support extensions',
      });
    }
  })
  .transform((value) => ({
    ...value,
    auth: {
      mode: 'bearer' as const,
      credential: { source: 'plugin' as const, id: value.authPlugin },
    },
    extensions: { ...DEFAULT_MCP_EXTENSIONS },
  }));

export const mcpServerSchema = z.union([
  stdioMcpServerSchema,
  streamableHttpMcpServerSchema,
  legacyStreamableHttpMcpServerSchema,
]);

export const keymapSchema = z.strictObject({
  commandPalette: z.string().min(1),
  submit: z.string().min(1),
  newline: z.string().min(1),
  close: z.string().min(1),
  cancel: z.string().min(1),
  complete: z.string().min(1),
});

export const globalConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  defaultProfile: profileIdSchema.optional(),
  registry: registryConfigSchema.default({
    source: 'https://models.dev/api.json',
    cache: true,
    refreshIntervalHours: 24,
  }),
  providers: z.record(providerIdSchema, providerConfigSchema),
  mcpServers: z.record(serverIdSchema, mcpServerSchema),
  security: z.strictObject({
    defaultToolPolicy: toolActionSchema.default('deny'),
    allowedHttpOrigins: z.array(secureUrlSchema).default([]),
  }),
  keymap: keymapSchema.default(DEFAULT_KEYMAP),
});

export const runtimeOverridesSchema = z.strictObject({
  workspace: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  persist: z.boolean().optional(),
  maxSteps: z.number().int().positive().optional(),
  toolTimeoutSeconds: z.number().positive().optional(),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type RuntimeOverrides = z.infer<typeof runtimeOverridesSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelOverride = z.infer<typeof modelOverrideSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = globalConfigSchema.parse({
  schemaVersion: 1,
  providers: {},
  mcpServers: {},
  security: {},
});

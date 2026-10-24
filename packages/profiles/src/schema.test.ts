import { describe, expect, it } from 'vitest';

import {
  profileBundleSchema,
  profileMcpSchema,
  profileProviderSchema,
  workProfileSchema,
} from './schema.js';
import { profile } from './test-helpers.js';

describe('workProfileSchema', () => {
  it('applies only the documented defaults', () => {
    const value = profile();
    const parsed = workProfileSchema.parse({
      ...value,
      model: { primary: value.model.primary },
    });
    expect(parsed.model.fallback).toEqual([]);
    expect(parsed.model.parameters).toEqual({});
  });

  it('rejects unknown keys, path-like IDs, malformed model refs, and broad globs', () => {
    expect(() => workProfileSchema.parse({ ...profile(), surprise: true })).toThrow();
    expect(() => workProfileSchema.parse({ ...profile(), id: '../coding' })).toThrow();
    expect(() =>
      workProfileSchema.parse({
        ...profile(),
        model: { ...profile().model, primary: 'not-qualified' },
      }),
    ).toThrow();
    expect(() =>
      workProfileSchema.parse({
        ...profile(),
        tools: { defaultPolicy: 'deny', rules: [{ tool: '*.read', action: 'allow' }] },
      }),
    ).toThrow();
  });

  it('accepts an empty self-contained profile bundle without a primary model', () => {
    const parsed = profileBundleSchema.parse({
      profile: {
        schemaVersion: 1,
        id: 'default',
        name: 'Default',
        model: { fallback: [], parameters: {} },
        tools: { defaultPolicy: 'deny', rules: [] },
        agent: { maxSteps: 12, toolTimeoutSeconds: 30 },
        session: { persist: true },
      },
      providers: { schemaVersion: 1, providers: {} },
      mcp: { schemaVersion: 1, servers: {}, enabled: [] },
    });

    expect(parsed.profile.model.primary).toBeUndefined();
    expect(parsed.providers.providers).toEqual({});
    expect(parsed.mcp.servers).toEqual({});
  });

  it('migrates v1 MCP data to v2 with safe defaults', () => {
    const parsed = profileMcpSchema.parse({
      schemaVersion: 1,
      servers: {
        docs: {
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
          authPlugin: 'legacy-bearer',
        },
      },
      enabled: ['docs'],
    });

    expect(parsed).toEqual({
      schemaVersion: 2,
      servers: {
        docs: {
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
          authPlugin: 'legacy-bearer',
          auth: { mode: 'bearer', credential: { source: 'plugin', id: 'legacy-bearer' } },
          extensions: {
            tasks: false,
            skills: false,
            apps: false,
            oauthClientCredentials: false,
            enterpriseManagedAuth: false,
          },
        },
      },
      enabled: ['docs'],
      roots: [],
    });
  });

  it('accepts only strict file URI roots in v2 MCP data', () => {
    const parsed = profileMcpSchema.parse({
      schemaVersion: 2,
      servers: {},
      enabled: [],
      roots: [{ uri: 'file:///workspace', name: 'Workspace' }],
    });
    expect(parsed.roots).toEqual([{ uri: 'file:///workspace', name: 'Workspace' }]);

    for (const uri of ['https://example.com/root', '/workspace', 'file:relative']) {
      expect(() =>
        profileMcpSchema.parse({ schemaVersion: 2, servers: {}, enabled: [], roots: [{ uri }] }),
      ).toThrow();
    }
    expect(() =>
      profileMcpSchema.parse({
        schemaVersion: 2,
        servers: {},
        enabled: [],
        roots: [{ uri: 'file:///workspace', extra: true }],
      }),
    ).toThrow();
  });
});

describe('profileProviderSchema', () => {
  it('accepts a ChatGPT subscription account binding', () => {
    expect(
      profileProviderSchema.parse({
        adapter: 'openai-chatgpt',
        auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'connection-1' },
        models: {},
      }),
    ).toMatchObject({
      adapter: 'openai-chatgpt',
      auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'connection-1' },
    });
  });

  it('rejects API base URLs for the ChatGPT subscription adapter', () => {
    expect(() =>
      profileProviderSchema.parse({
        adapter: 'openai-chatgpt',
        baseURL: 'https://example.com/v1',
        auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'connection-1' },
        models: {},
      }),
    ).toThrow();
  });
});

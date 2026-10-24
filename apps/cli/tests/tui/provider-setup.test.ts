import { describe, expect, it } from 'vitest';

import {
  PROVIDER_CHOICES,
  providerConfiguration,
  providerConfigurationFromPrefill,
} from '../../src/tui/overlays/provider-setup.js';

describe('provider setup', () => {
  it('offers ChatGPT subscription first', () => {
    expect(PROVIDER_CHOICES[0]).toMatchObject({ id: 'chatgpt', label: 'ChatGPT subscription' });
  });
  it('builds a keyring-backed built-in provider without storing its secret', () => {
    expect(providerConfiguration('openai', 'openai/gpt-test')).toEqual({
      providerId: 'openai',
      primaryModel: 'openai/gpt-test',
      provider: {
        adapter: 'openai',
        auth: { mode: 'api-key', credential: 'keyring' },
        models: {},
      },
    });
  });

  it('declares a manual custom model inside an OpenAI-compatible provider', () => {
    expect(
      providerConfiguration('custom', 'acme/chat-pro', {
        providerId: 'acme',
        baseURL: 'https://models.acme.test/v1',
        authMode: 'none',
      }),
    ).toEqual({
      providerId: 'acme',
      primaryModel: 'acme/chat-pro',
      provider: {
        adapter: 'openai-compatible',
        baseURL: 'https://models.acme.test/v1',
        auth: { mode: 'none' },
        models: {
          'chat-pro': {
            toolCalls: false,
            reasoning: false,
            structuredOutput: false,
          },
        },
      },
    });
  });

  it('builds a compatible provider directly from a validated catalog prefill', () => {
    expect(
      providerConfigurationFromPrefill({
        providerId: 'acme',
        providerName: 'Acme',
        adapter: 'openai-compatible',
        baseURL: 'https://api.acme.test/v1',
        authMode: 'api-key',
        envName: 'ACME_API_KEY',
        model: {
          id: 'acme/chat',
          providerId: 'acme',
          modelId: 'chat',
          name: 'Acme Chat',
          capabilities: { toolCalls: true, reasoning: false, structuredOutput: true },
        },
      }),
    ).toEqual({
      providerId: 'acme',
      primaryModel: 'acme/chat',
      provider: {
        adapter: 'openai-compatible',
        baseURL: 'https://api.acme.test/v1',
        auth: { mode: 'api-key', credential: 'keyring' },
        models: {
          chat: {
            name: 'Acme Chat',
            toolCalls: true,
            reasoning: false,
            structuredOutput: true,
          },
        },
      },
    });
  });

  it('does not copy an insecure endpoint from a forged prefill', () => {
    expect(() =>
      providerConfigurationFromPrefill({
        providerId: 'acme',
        providerName: 'Acme',
        adapter: 'openai-compatible',
        baseURL: 'http://api.acme.test/v1',
        authMode: 'none',
        model: {
          id: 'acme/chat',
          providerId: 'acme',
          modelId: 'chat',
          name: 'Chat',
          capabilities: { toolCalls: false, reasoning: false, structuredOutput: false },
        },
      }),
    ).toThrow('secure');
  });
});

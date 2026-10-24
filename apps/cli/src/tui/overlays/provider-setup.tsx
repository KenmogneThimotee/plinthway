import { useMemo, useRef, useState } from 'react';
import { Text, useInput } from 'ink';

import type { ModelMetadata } from '@plinthway/model-registry';
import type { ProviderSetupDescriptor } from '@plinthway/app-core';
import type { ProfileProvider } from '@plinthway/profiles';
import { secureUrlSchema } from '@plinthway/config';
import { redact } from '@plinthway/shared';

import { OverlayFrame } from './frame.js';

export type ProviderChoice = 'openai' | 'anthropic' | 'google' | 'custom';
type SetupChoice = 'chatgpt' | ProviderChoice;

export const PROVIDER_CHOICES = Object.freeze([
  { id: 'chatgpt', label: 'ChatGPT subscription' },
  { id: 'openai', label: 'OpenAI API key' },
  { id: 'anthropic', label: 'Anthropic API key' },
  { id: 'google', label: 'Google API key' },
  { id: 'custom', label: 'Custom OpenAI-compatible' },
] as const);

export interface ProviderConfiguration {
  readonly providerId: string;
  readonly provider: ProfileProvider;
  readonly primaryModel: string;
}

export interface ProviderSetupPrefill extends ProviderSetupDescriptor {
  readonly model: ModelMetadata;
}

export function providerConfigurationFromPrefill(
  prefill: ProviderSetupPrefill,
): ProviderConfiguration {
  const baseURL =
    prefill.baseURL === undefined ? undefined : secureUrlSchema.safeParse(prefill.baseURL);
  if (baseURL !== undefined && !baseURL.success) {
    throw new TypeError('Catalog provider setup requires a secure endpoint');
  }
  if (prefill.model.providerId !== prefill.providerId) {
    throw new TypeError('Catalog model does not belong to the selected provider');
  }
  return {
    providerId: prefill.providerId,
    primaryModel: prefill.model.id,
    provider: {
      adapter: prefill.adapter,
      ...(baseURL === undefined ? {} : { baseURL: baseURL.data }),
      auth:
        prefill.authMode === 'none' ? { mode: 'none' } : { mode: 'api-key', credential: 'keyring' },
      models: {
        [prefill.model.modelId]: {
          name: prefill.model.name,
          ...(prefill.model.contextLimit === undefined
            ? {}
            : { contextLimit: prefill.model.contextLimit }),
          ...(prefill.model.outputLimit === undefined
            ? {}
            : { outputLimit: prefill.model.outputLimit }),
          ...prefill.model.capabilities,
        },
      },
    },
  };
}

export function providerConfiguration(
  choice: ProviderChoice,
  primaryModel: string,
  custom?: {
    readonly providerId: string;
    readonly baseURL: string;
    readonly authMode: 'none' | 'api-key';
  },
): ProviderConfiguration {
  if (choice !== 'custom') {
    return {
      providerId: choice,
      primaryModel,
      provider: {
        adapter: choice,
        auth: { mode: 'api-key', credential: 'keyring' },
        models: {},
      },
    };
  }
  if (custom === undefined) throw new TypeError('Custom provider details are required');
  const prefix = `${custom.providerId}/`;
  const modelId = primaryModel.startsWith(prefix)
    ? primaryModel.slice(prefix.length)
    : primaryModel;
  return {
    providerId: custom.providerId,
    primaryModel: `${custom.providerId}/${modelId}`,
    provider: {
      adapter: 'openai-compatible',
      baseURL: custom.baseURL,
      auth:
        custom.authMode === 'none' ? { mode: 'none' } : { mode: 'api-key', credential: 'keyring' },
      models: {
        [modelId]: { toolCalls: false, reasoning: false, structuredOutput: false },
      },
    },
  };
}

type Step = 'provider' | 'provider-id' | 'base-url' | 'auth' | 'api-key' | 'model' | 'confirm';

export function ProviderSetupOverlay({
  models,
  onCancel,
  onSave,
  onChatGpt,
  prefill,
}: {
  readonly models: readonly ModelMetadata[];
  readonly prefill?: ProviderSetupPrefill;
  readonly onCancel: () => void;
  readonly onSave: (configuration: ProviderConfiguration, apiKey?: string) => Promise<void>;
  readonly onChatGpt: () => void;
}) {
  const [step, setStep] = useState<Step>(() =>
    prefill === undefined ? 'provider' : prefill.authMode === 'api-key' ? 'api-key' : 'confirm',
  );
  const [choice, setChoice] = useState<SetupChoice>('chatgpt');
  const [field, setField] = useState('');
  const [providerId, setProviderId] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [authMode, setAuthMode] = useState<'none' | 'api-key'>('api-key');
  const [selected, setSelected] = useState(0);
  const [manualModel, setManualModel] = useState(false);
  const [secretLength, setSecretLength] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const secret = useRef('');
  const availableModels = useMemo(
    () => (choice === 'custom' ? [] : models.filter((model) => model.providerId === choice)),
    [choice, models],
  );

  const append = (input: string): void => {
    if (input.length > 0) setField((value) => `${value}${input}`);
  };
  const save = async (modelRef: string): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      if (choice === 'chatgpt') throw new TypeError('ChatGPT uses the account setup flow');
      const configuration = providerConfiguration(
        choice,
        modelRef,
        choice === 'custom' ? { providerId, baseURL, authMode } : undefined,
      );
      await onSave(
        configuration,
        configuration.provider.auth.mode === 'api-key' ? secret.current : undefined,
      );
      secret.current = '';
      setSecretLength(0);
    } catch (caught) {
      setError(
        String(redact(caught instanceof Error ? caught.message : 'Provider configuration failed')),
      );
      setSaving(false);
    }
  };
  const saveCatalogPrefill = async (): Promise<void> => {
    if (prefill === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const configuration = providerConfigurationFromPrefill(prefill);
      await onSave(
        configuration,
        configuration.provider.auth.mode === 'api-key' ? secret.current : undefined,
      );
      secret.current = '';
      setSecretLength(0);
    } catch (caught) {
      setError(
        String(redact(caught instanceof Error ? caught.message : 'Provider configuration failed')),
      );
      setSaving(false);
    }
  };

  useInput((input, key) => {
    if (saving) return;
    if (key.escape) {
      secret.current = '';
      onCancel();
      return;
    }
    if (step === 'provider') {
      const next = (
        {
          '1': 'chatgpt',
          '2': 'openai',
          '3': 'anthropic',
          '4': 'google',
          '5': 'custom',
        } as const
      )[input];
      if (next === undefined) return;
      if (next === 'chatgpt') {
        onChatGpt();
        return;
      }
      setChoice(next);
      setField('');
      setStep(next === 'custom' ? 'provider-id' : 'api-key');
      return;
    }
    if (step === 'auth') {
      if (input === '1') {
        setAuthMode('api-key');
        setStep('api-key');
      } else if (input === '2') {
        setAuthMode('none');
        setField('');
        setStep('model');
        setManualModel(true);
      }
      return;
    }
    if (step === 'api-key') {
      if (key.return && secret.current.length > 0) {
        if (prefill === undefined) {
          setField('');
          setStep('model');
          setManualModel(choice === 'custom');
        } else {
          void saveCatalogPrefill();
        }
      } else if (key.backspace || key.delete) {
        secret.current = secret.current.slice(0, -1);
        setSecretLength(secret.current.length);
      } else if (!key.ctrl && !key.meta && input.length > 0) {
        secret.current += input;
        setSecretLength(secret.current.length);
      }
      return;
    }
    if (step === 'confirm') {
      if (key.return) void saveCatalogPrefill();
      return;
    }
    if (step === 'model' && !manualModel && availableModels.length > 0) {
      if (key.upArrow || key.downArrow) {
        setSelected(
          (current) =>
            (current + (key.downArrow ? 1 : -1) + availableModels.length) % availableModels.length,
        );
      } else if (input.toLowerCase() === 'm') {
        setManualModel(true);
        setField('');
      } else if (key.return) {
        const model = availableModels[selected];
        if (model !== undefined) void save(model.id);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setField((value) => value.slice(0, -1));
      return;
    }
    if (key.return && field.trim().length > 0) {
      const value = field.trim();
      if (step === 'provider-id') {
        setProviderId(value);
        setField('');
        setStep('base-url');
      } else if (step === 'base-url') {
        setBaseURL(value);
        setField('');
        setStep('auth');
      } else {
        void save(choice === 'custom' ? `${providerId}/${value}` : `${choice}/${value}`);
      }
      return;
    }
    if (!key.ctrl && !key.meta) append(input);
  });

  return (
    <OverlayFrame title="Configure provider">
      {prefill !== undefined && (
        <Text>
          {prefill.providerName} · {prefill.model.id}
        </Text>
      )}
      {step === 'provider' && (
        <>
          <Text>
            Choose: [1] ChatGPT subscription [2] OpenAI [3] Anthropic [4] Google [5] Custom
          </Text>
          <Text dimColor>Esc dismisses setup; chat remains available.</Text>
        </>
      )}
      {step === 'provider-id' && <Text>Provider ID: {field}</Text>}
      {step === 'base-url' && <Text>Base URL (HTTPS or loopback HTTP): {field}</Text>}
      {step === 'auth' && <Text>Authentication: [1] API key [2] None</Text>}
      {step === 'api-key' && (
        <Text>
          {prefill?.envName ?? 'API key'}: {'*'.repeat(secretLength)} (stored only in the OS
          keyring)
        </Text>
      )}
      {step === 'confirm' && <Text>Press Enter to configure this no-auth provider.</Text>}
      {step === 'model' && !manualModel && availableModels.length > 0 && (
        <>
          <Text>Select model (↑/↓, Enter) or [M] enter an ID:</Text>
          {availableModels.slice(Math.max(0, selected - 4), selected + 5).map((model) => (
            <Text
              key={model.id}
              {...(availableModels[selected]?.id === model.id ? { color: 'cyan' } : {})}
            >
              {availableModels[selected]?.id === model.id ? '› ' : '  '}
              {model.id}
            </Text>
          ))}
        </>
      )}
      {step === 'model' && (manualModel || availableModels.length === 0) && (
        <Text>
          Model ID: {choice === 'custom' ? `${providerId}/` : `${choice}/`}
          {field}
        </Text>
      )}
      {saving && <Text color="yellow">Saving provider and starting a new session…</Text>}
      {error !== undefined && <Text color="red">{error}</Text>}
    </OverlayFrame>
  );
}

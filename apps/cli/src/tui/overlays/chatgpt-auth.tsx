import { useCallback, useEffect, useState } from 'react';
import { Text, useInput } from 'ink';

import type { ChatGptConnectionSummary, ChatGptModel } from '@plinthway/auth';
import { redact } from '@plinthway/shared';

import type { CliApplication } from '../../application.js';
import { OverlayFrame } from './frame.js';

type Step = 'accounts' | 'connecting' | 'models' | 'saving';

export function ChatGptAuthOverlay({
  application,
  profileId,
  onCancel,
  onConfigured,
}: {
  readonly application: CliApplication;
  readonly profileId: string;
  readonly onCancel: () => void;
  readonly onConfigured: (
    connection: ChatGptConnectionSummary,
    model: ChatGptModel,
  ) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>('accounts');
  const [accounts, setAccounts] = useState<readonly ChatGptConnectionSummary[]>([]);
  const [connection, setConnection] = useState<ChatGptConnectionSummary | undefined>();
  const [models, setModels] = useState<readonly ChatGptModel[]>([]);
  const [selected, setSelected] = useState(0);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setAccounts(await application.listChatGptAccounts());
  }, [application]);

  useEffect(() => {
    void refresh().catch((caught: unknown) => {
      setError(
        String(redact(caught instanceof Error ? caught.message : 'Could not load accounts')),
      );
    });
  }, [refresh]);

  const choose = useCallback(
    async (account: ChatGptConnectionSummary) => {
      setError(undefined);
      setConnection(account);
      try {
        const available = await application.listChatGptModels(account.id);
        setModels(available);
        setSelected(0);
        setStep('models');
      } catch (caught) {
        setError(
          String(redact(caught instanceof Error ? caught.message : 'Could not load models')),
        );
        setStep('accounts');
      }
    },
    [application],
  );

  const connect = useCallback(
    async (connectionId?: string) => {
      setStep('connecting');
      setError(undefined);
      setAuthorizationUrl(undefined);
      try {
        const account = await application.signInChatGpt({
          openBrowser: true,
          callbackPort: 1455,
          ...(connectionId === undefined ? {} : { connectionId }),
          onAuthorizationUrl: setAuthorizationUrl,
        });
        await refresh();
        await choose(account);
      } catch (caught) {
        setError(
          String(redact(caught instanceof Error ? caught.message : 'ChatGPT sign-in failed')),
        );
        setStep('accounts');
      }
    },
    [application, choose, refresh],
  );

  useInput((input, key) => {
    if (key.escape && step !== 'saving') {
      onCancel();
      return;
    }
    if (step === 'accounts') {
      const account = accounts[selected];
      if (key.upArrow || key.downArrow) {
        if (accounts.length > 0) {
          setSelected(
            (current) => (current + (key.downArrow ? 1 : -1) + accounts.length) % accounts.length,
          );
        }
      } else if (input.toLowerCase() === 'n') void connect();
      else if (input.toLowerCase() === 'r' && account !== undefined) void connect(account.id);
      else if (input.toLowerCase() === 'd' && account !== undefined) {
        void application
          .disconnectChatGpt(account.id)
          .then(refresh)
          .catch((caught: unknown) => {
            setError(
              String(redact(caught instanceof Error ? caught.message : 'Disconnect failed')),
            );
          });
      } else if (key.return && account?.status === 'connected') void choose(account);
    } else if (step === 'models' && models.length > 0) {
      if (key.upArrow || key.downArrow) {
        setSelected(
          (current) => (current + (key.downArrow ? 1 : -1) + models.length) % models.length,
        );
      } else if (key.return) {
        const model = models[selected];
        if (connection !== undefined && model !== undefined) {
          setStep('saving');
          void onConfigured(connection, model).catch((caught: unknown) => {
            setError(
              String(redact(caught instanceof Error ? caught.message : 'Configuration failed')),
            );
            setStep('models');
          });
        }
      }
    }
  });

  return (
    <OverlayFrame title="ChatGPT subscription">
      {step === 'accounts' && (
        <>
          <Text>[N] New · [R] Reconnect · [D] Disconnect · ↑/↓ and Enter to select</Text>
          {accounts.length === 0 && <Text dimColor>No saved accounts.</Text>}
          {accounts.map((account, index) => (
            <Text key={account.id} {...(index === selected ? { color: 'cyan' as const } : {})}>
              {index === selected ? '› ' : '  '}
              {account.email ?? account.displayName ?? account.subject} · {account.status}
            </Text>
          ))}
        </>
      )}
      {step === 'connecting' && (
        <>
          <Text color="yellow">Waiting for ChatGPT authorization…</Text>
          {authorizationUrl !== undefined && (
            <Text wrap="wrap">If the browser did not open: {authorizationUrl}</Text>
          )}
        </>
      )}
      {(step === 'models' || step === 'saving') && (
        <>
          <Text>Select a subscription model (↑/↓, Enter):</Text>
          {models.map((model, index) => (
            <Text key={model.id} {...(index === selected ? { color: 'cyan' as const } : {})}>
              {index === selected ? '› ' : '  '}
              {model.name} · chatgpt/{model.id}
            </Text>
          ))}
          {models.length === 0 && <Text color="yellow">No subscription models are available.</Text>}
          {step === 'saving' && <Text color="yellow">Saving and starting a new session…</Text>}
        </>
      )}
      {error !== undefined && <Text color="red">{error}</Text>}
      <Text dimColor>Esc cancels without changing profile {profileId} or the composer.</Text>
    </OverlayFrame>
  );
}

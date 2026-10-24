import type { Command } from 'commander';
import { password } from '@inquirer/prompts';

import { PlinthwayError } from '@plinthway/shared';

import type { CliContext } from '../application.js';
import { writeRecord } from '../application.js';

async function profileId(context: CliContext, explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    await context.application.getProfile(explicit);
    return explicit;
  }
  const selected = await context.application.initialize();
  if (selected === undefined) {
    throw new PlinthwayError('PROFILE_NOT_FOUND', 'No profile is selected');
  }
  return selected.id;
}

export function registerAuthCommands(program: Command, context: CliContext): void {
  const auth = program.command('auth').description('manage provider credentials');
  auth
    .command('login <provider>')
    .option('--api-key <key>')
    .option('--profile <id>')
    .option('--no-browser', 'print the authorization URL instead of opening a browser')
    .option('--port <port>', 'loopback callback port', (value) => Number.parseInt(value, 10), 1455)
    .option('--connection <id>', 'replace a saved ChatGPT connection')
    .action(
      async (
        provider: string,
        options: {
          apiKey?: string;
          profile?: string;
          browser: boolean;
          port: number;
          connection?: string;
        },
        command: Command,
      ) => {
        if (provider === 'chatgpt') {
          const connection = await context.application.signInChatGpt({
            openBrowser: options.browser,
            callbackPort: options.port,
            ...(options.connection === undefined ? {} : { connectionId: options.connection }),
            onAuthorizationUrl: (url) => {
              context.stderr.write(`Open this URL to connect ChatGPT: ${url}\n`);
            },
          });
          writeRecord(
            context,
            command,
            connection,
            `ChatGPT subscription connected: ${connection.email ?? connection.displayName ?? connection.id}`,
          );
          return;
        }
        let secret = options.apiKey;
        if (secret === undefined && context.stdin.isTTY) {
          secret = await password({ message: `API key for ${provider}` });
        }
        if (secret === undefined || secret.length === 0) {
          throw new PlinthwayError('CREDENTIAL_MISSING', 'An API key is required');
        }
        const selectedProfile = await profileId(context, options.profile);
        await context.application.setProviderApiKey(selectedProfile, provider, secret);
        writeRecord(
          context,
          command,
          { profileId: selectedProfile, providerId: provider, loggedIn: true },
          `${selectedProfile}/${provider}: authenticated`,
        );
      },
    );
  auth
    .command('logout <provider>')
    .option('--profile <id>')
    .option('--connection <id>')
    .action(
      async (
        provider: string,
        options: { profile?: string; connection?: string },
        command: Command,
      ) => {
        if (provider === 'chatgpt') {
          const accounts = await context.application.listChatGptAccounts();
          const connectionId =
            options.connection ?? (accounts.length === 1 ? accounts[0]?.id : undefined);
          if (connectionId === undefined) {
            throw new PlinthwayError('AUTH_FAILED', 'Choose a ChatGPT account with --connection');
          }
          const result = await context.application.disconnectChatGpt(connectionId);
          writeRecord(
            context,
            command,
            { connectionId, connected: false, ...result },
            `ChatGPT subscription disconnected${result.revocationConfirmed ? '' : ' locally; remote revocation was not confirmed'}`,
          );
          return;
        }
        const selectedProfile = await profileId(context, options.profile);
        await context.application.deleteProviderCredential(selectedProfile, provider);
        writeRecord(
          context,
          command,
          { profileId: selectedProfile, providerId: provider, loggedIn: false },
          `${selectedProfile}/${provider}: logged out`,
        );
      },
    );
  auth
    .command('status <provider>')
    .option('--profile <id>')
    .action(async (provider: string, options: { profile?: string }, command: Command) => {
      if (provider === 'chatgpt') {
        const accounts = await context.application.listChatGptAccounts();
        writeRecord(
          context,
          command,
          { available: accounts.some(({ status }) => status === 'connected'), accounts },
          accounts.length === 0
            ? 'ChatGPT subscription: not connected'
            : `ChatGPT subscription: ${String(accounts.length)} saved account(s)`,
        );
        return;
      }
      const selectedProfile = await profileId(context, options.profile);
      const available = await context.application.providerCredentialStatus(
        selectedProfile,
        provider,
      );
      writeRecord(
        context,
        command,
        { profileId: selectedProfile, providerId: provider, available, source: 'keyring' },
        `${selectedProfile}/${provider}: ${available ? 'keyring' : 'missing'}`,
      );
    });
  auth
    .command('accounts')
    .description('list saved ChatGPT subscription accounts')
    .action(async (_options: unknown, command: Command) => {
      const accounts = await context.application.listChatGptAccounts();
      writeRecord(
        context,
        command,
        accounts,
        accounts.length === 0
          ? 'No ChatGPT subscription accounts are saved.'
          : accounts
              .map(
                (account) =>
                  `${account.id}\t${account.email ?? account.displayName ?? account.subject}\t${account.status}`,
              )
              .join('\n'),
      );
    });
}

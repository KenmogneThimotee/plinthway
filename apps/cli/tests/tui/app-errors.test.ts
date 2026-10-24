import { describe, expect, it } from 'vitest';

import { PlinthwayError } from '@plinthway/shared';

import { actionableMessage, isNarrowTerminal } from '../../src/tui/app.js';

describe('TUI submission errors', () => {
  it('tells the user to retry a temporary ChatGPT overload without changing configuration', () => {
    const message = actionableMessage(
      new PlinthwayError('PROVIDER_ERROR', 'ChatGPT is temporarily overloaded', {
        providerError: 'server_is_overloaded',
      }),
    );

    expect(message).toBe(
      'ChatGPT is temporarily overloaded. Your prompt has been restored; retry shortly.',
    );
  });

  it('uses the compact terminal chrome at the standard 80-column width', () => {
    expect(isNarrowTerminal(80)).toBe(true);
    expect(isNarrowTerminal(120)).toBe(false);
  });
});

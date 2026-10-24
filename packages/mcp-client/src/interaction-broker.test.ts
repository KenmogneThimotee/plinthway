import { describe, expect, it, vi } from 'vitest';

import { McpInteractionBroker } from './interaction-broker.js';

describe('McpInteractionBroker', () => {
  it('tracks concurrent requests with distinct host IDs and resolves them independently', async () => {
    const broker = new McpInteractionBroker();
    const seen: string[] = [];
    broker.onRequest((request) => seen.push(request.id));

    const first = broker.handle('docs', 'sampling/createMessage', { maxTokens: 10 });
    const second = broker.handle('forms', 'elicitation/create', {
      mode: 'form',
      message: 'Choose',
      requestedSchema: { type: 'object' },
    });
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    const secondId = seen[1];
    const firstId = seen[0];
    if (secondId === undefined || firstId === undefined) throw new Error('missing interaction IDs');

    broker.approve(secondId, { action: 'accept', content: { choice: 'yes' } });
    broker.approve(firstId, {
      role: 'assistant',
      content: { type: 'text', text: 'sampled' },
      model: 'fixture',
      stopReason: 'endTurn',
    });
    await expect(first).resolves.toMatchObject({ model: 'fixture' });
    await expect(second).resolves.toMatchObject({ action: 'accept' });
  });

  it('defaults roots to empty and requires consent only for first non-empty disclosure', async () => {
    const broker = new McpInteractionBroker();
    await expect(broker.handle('docs', 'roots/list', {})).resolves.toEqual({ roots: [] });

    broker.setRoots([{ uri: 'file:///workspace', name: 'Workspace' }]);
    const listener = vi.fn<(request: { readonly id: string }) => void>();
    broker.onRequest(listener);
    const first = broker.handle('docs', 'roots/list', {});
    expect(listener).toHaveBeenCalledOnce();
    const requestId = listener.mock.calls[0]?.[0].id;
    if (requestId === undefined) throw new Error('missing roots interaction ID');
    broker.approve(requestId);
    await expect(first).resolves.toEqual({
      roots: [{ uri: 'file:///workspace', name: 'Workspace' }],
    });
    await expect(broker.handle('docs', 'roots/list', {})).resolves.toEqual({
      roots: [{ uri: 'file:///workspace', name: 'Workspace' }],
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('supports declines and cancellation without leaking pending interactions', async () => {
    const broker = new McpInteractionBroker();
    const requests: string[] = [];
    broker.onRequest(({ id }) => requests.push(id));
    const elicitation = broker.handle('forms', 'elicitation/create', { mode: 'url' });
    const elicitationId = requests[0];
    if (elicitationId === undefined) throw new Error('missing elicitation interaction ID');
    broker.decline(elicitationId);
    await expect(elicitation).resolves.toEqual({ action: 'decline' });

    const sampling = broker.handle('model', 'sampling/createMessage', {});
    const samplingId = requests[1];
    if (samplingId === undefined) throw new Error('missing sampling interaction ID');
    broker.cancel(samplingId);
    await expect(sampling).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(broker.pending()).toEqual([]);
  });

  it('cancels an interaction when its operation signal aborts', async () => {
    const broker = new McpInteractionBroker();
    const controller = new AbortController();
    const pending = broker.handle('forms', 'elicitation/create', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(broker.pending()).toEqual([]);
  });
});

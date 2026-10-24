import { describe, expect, it } from 'vitest';

import { SessionDatabase } from './database.js';
import {
  SqliteActiveProfileStore,
  SqliteSelectedProfileStore,
  SqliteTransitionRepository,
} from './repository.js';
import { snapshot } from './test-helpers.js';

describe('active profiles and transitions', () => {
  it('stores a selected profile without requiring an effective snapshot', async () => {
    const database = new SessionDatabase(':memory:');
    const selected = new SqliteSelectedProfileStore(database);
    expect(await selected.get()).toBeUndefined();
    await selected.set('default');
    expect(await selected.get()).toBe('default');
    await selected.clear();
    expect(await selected.get()).toBeUndefined();
    database.close();
  });

  it('round-trips verified active snapshots and commits transitions atomically', async () => {
    const database = new SessionDatabase(':memory:');
    const active = new SqliteActiveProfileStore(database);
    const transitions = new SqliteTransitionRepository(database);
    const target = snapshot('research');
    const transition = await transitions.begin(undefined, target);
    expect(await active.get()).toBeUndefined();
    await transitions.commitWithActiveProfile(transition.id, target);
    expect(await active.get()).toEqual(target);
    expect((await transitions.list())[0]).toMatchObject({ id: transition.id, state: 'committed' });
    await active.clear();
    expect(await active.get()).toBeUndefined();
    database.close();
  });

  it('compensates a post-commit activation failure in one transaction', async () => {
    const database = new SessionDatabase(':memory:');
    const active = new SqliteActiveProfileStore(database);
    const transitions = new SqliteTransitionRepository(database);
    const previous = snapshot('coding');
    const target = snapshot('research');
    await active.set(previous);
    const transition = await transitions.begin(previous, target);
    await transitions.commitWithActiveProfile(transition.id, target);
    await transitions.compensate(transition.id, previous, new Error('activation failed'));
    expect(await active.get()).toEqual(previous);
    expect((await transitions.list())[0]).toMatchObject({ state: 'rolled-back' });
    database.close();
  });
});

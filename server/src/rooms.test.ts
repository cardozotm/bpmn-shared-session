import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_DIAGRAM_XML,
  RoomError,
  RoomStore,
  sanitizeName,
} from './rooms.js';

describe('RoomStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a room with revision 0 and one participant keyed by clientId', () => {
    const store = new RoomStore({ codeGenerator: () => 'ABC123' });
    const snapshot = store.create(
      'client-alice',
      'socket-1',
      'Alice',
      EMPTY_DIAGRAM_XML
    );

    expect(snapshot.roomId).toBe('ABC123');
    expect(snapshot.revision).toBe(0);
    expect(snapshot.xml).toBe(EMPTY_DIAGRAM_XML);
    expect(snapshot.participants).toHaveLength(1);
    expect(snapshot.participants[0]).toMatchObject({
      id: 'client-alice',
      name: 'Alice',
      color: '#2563eb',
      selectedElementId: null,
    });
  });

  it('allows a second participant and assigns a different color', () => {
    const store = new RoomStore({ codeGenerator: () => 'ROOM01' });
    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    const snapshot = store.join('ROOM01', 'client-b', 'socket-2', 'Bob');

    expect(snapshot.participants).toHaveLength(2);
    const colors = snapshot.participants.map((p) => p.color);
    expect(new Set(colors).size).toBe(2);
  });

  it('rejects a third participant when the room is full', () => {
    const store = new RoomStore({ codeGenerator: () => 'FULL01' });
    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.join('FULL01', 'client-b', 'socket-2', 'Bob');

    expect(() =>
      store.join('FULL01', 'client-c', 'socket-3', 'Carol')
    ).toThrow(RoomError);
    expect(() =>
      store.join('FULL01', 'client-c', 'socket-3', 'Carol')
    ).toThrow(/dois participantes/);
  });

  it('rejoins the same clientId without consuming a second seat', () => {
    const store = new RoomStore({ codeGenerator: () => 'REJOIN' });
    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.join('REJOIN', 'client-b', 'socket-2', 'Bob');

    const snapshot = store.join('REJOIN', 'client-a', 'socket-9', 'Alice');
    expect(snapshot.participants).toHaveLength(2);
    expect(snapshot.participants.find((p) => p.id === 'client-a')).toBeTruthy();
  });

  it('accepts diagram updates when baseRevision matches', () => {
    const store = new RoomStore({ codeGenerator: () => 'SYNC01' });
    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);

    const first = store.applyDiagramUpdate(
      'SYNC01',
      'socket-1',
      0,
      '<xml>v1</xml>'
    );
    expect(first).toMatchObject({ ok: true, revision: 1, clientId: 'client-a' });

    const second = store.applyDiagramUpdate(
      'SYNC01',
      'socket-1',
      1,
      '<xml>v2</xml>'
    );
    expect(second).toMatchObject({ ok: true, revision: 2 });
    expect(store.getSnapshot('SYNC01')?.xml).toBe('<xml>v2</xml>');
  });

  it('rejects stale diagram updates and returns canonical state', () => {
    const store = new RoomStore({ codeGenerator: () => 'STALE1' });
    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.applyDiagramUpdate('STALE1', 'socket-1', 0, '<xml>canonical</xml>');

    const result = store.applyDiagramUpdate(
      'STALE1',
      'socket-1',
      0,
      '<xml>stale</xml>'
    );

    expect(result).toEqual({
      ok: false,
      error: 'Diagrama atualizado por outro participante.',
      xml: '<xml>canonical</xml>',
      revision: 1,
    });
  });

  it('updates presence selection for a participant', () => {
    const store = new RoomStore({ codeGenerator: () => 'PRES01' });
    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.join('PRES01', 'client-b', 'socket-2', 'Bob');

    const participants = store.updatePresence('PRES01', 'socket-2', 'Task_1');
    expect(
      participants?.find((p) => p.id === 'client-b')?.selectedElementId
    ).toBe('Task_1');
  });

  it('keeps the seat during disconnect grace and frees it after', () => {
    vi.useFakeTimers();
    const store = new RoomStore({
      codeGenerator: () => 'GRACE1',
      disconnectGraceMs: 1000,
    });
    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.join('GRACE1', 'client-b', 'socket-2', 'Bob');

    const expired: string[] = [];
    store.beginDisconnect('socket-2', (_roomId, participants) => {
      expired.push(...participants.map((p) => p.id));
    });

    expect(store.getSnapshot('GRACE1')?.participants).toHaveLength(2);

    store.join('GRACE1', 'client-b', 'socket-99', 'Bob');
    vi.advanceTimersByTime(1000);
    expect(store.getSnapshot('GRACE1')?.participants).toHaveLength(2);
    expect(expired).toHaveLength(0);

    store.beginDisconnect('socket-99');
    vi.advanceTimersByTime(1000);
    expect(store.getSnapshot('GRACE1')?.participants).toHaveLength(1);
  });

  it('restores a missing room from local XML with the same code', () => {
    const store = new RoomStore({ codeGenerator: () => 'NEWID1' });
    const snapshot = store.join(
      'OLDCODE',
      'client-a',
      'socket-1',
      'Alice',
      { xml: '<xml>from-local</xml>', revision: 4 }
    );

    expect(snapshot.roomId).toBe('OLDCODE');
    expect(snapshot.xml).toBe('<xml>from-local</xml>');
    expect(snapshot.revision).toBe(4);
  });

  it('applies a newer local diagram via restoreDiagram', () => {
    const store = new RoomStore({ codeGenerator: () => 'REST01' });
    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);

    const result = store.restoreDiagram(
      'REST01',
      'socket-1',
      '<xml>newer</xml>',
      3
    );
    expect(result).toMatchObject({ ok: true, revision: 3 });
    expect(store.getSnapshot('REST01')?.xml).toBe('<xml>newer</xml>');
  });

  it('preserves room XML after explicit leave until idle TTL', () => {
    vi.useFakeTimers();
    const store = new RoomStore({
      codeGenerator: () => 'IDLE01',
      idleTtlMs: 1000,
    });

    store.create('client-a', 'socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.applyDiagramUpdate('IDLE01', 'socket-1', 0, '<xml>saved</xml>');
    store.leave('client-a');

    expect(store.size()).toBe(1);
    expect(store.getSnapshot('IDLE01')?.xml).toBe('<xml>saved</xml>');

    const rejoined = store.join('IDLE01', 'client-a', 'socket-2', 'Alice');
    expect(rejoined.xml).toBe('<xml>saved</xml>');
    expect(rejoined.revision).toBe(1);

    store.leave('client-a');
    vi.advanceTimersByTime(999);
    expect(store.size()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(store.size()).toBe(0);
  });
});

describe('sanitizeName', () => {
  it('trims, truncates, and falls back to Anônimo', () => {
    expect(sanitizeName('  Ada  ')).toBe('Ada');
    expect(sanitizeName('')).toBe('Anônimo');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(32);
  });
});

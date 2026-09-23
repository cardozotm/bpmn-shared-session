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

  it('creates a room with revision 0 and one participant', () => {
    const store = new RoomStore({ codeGenerator: () => 'ABC123' });
    const snapshot = store.create('socket-1', 'Alice', EMPTY_DIAGRAM_XML);

    expect(snapshot.roomId).toBe('ABC123');
    expect(snapshot.revision).toBe(0);
    expect(snapshot.xml).toBe(EMPTY_DIAGRAM_XML);
    expect(snapshot.participants).toHaveLength(1);
    expect(snapshot.participants[0]).toMatchObject({
      id: 'socket-1',
      name: 'Alice',
      color: '#2563eb',
      selectedElementId: null,
    });
  });

  it('allows a second participant and assigns a different color', () => {
    const store = new RoomStore({ codeGenerator: () => 'ROOM01' });
    store.create('socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    const snapshot = store.join('ROOM01', 'socket-2', 'Bob');

    expect(snapshot.participants).toHaveLength(2);
    const colors = snapshot.participants.map((p) => p.color);
    expect(new Set(colors).size).toBe(2);
  });

  it('rejects a third participant when the room is full', () => {
    const store = new RoomStore({ codeGenerator: () => 'FULL01' });
    store.create('socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.join('FULL01', 'socket-2', 'Bob');

    expect(() => store.join('FULL01', 'socket-3', 'Carol')).toThrow(RoomError);
    expect(() => store.join('FULL01', 'socket-3', 'Carol')).toThrow(
      /dois participantes/
    );
  });

  it('accepts diagram updates when baseRevision matches', () => {
    const store = new RoomStore({ codeGenerator: () => 'SYNC01' });
    store.create('socket-1', 'Alice', EMPTY_DIAGRAM_XML);

    const first = store.applyDiagramUpdate(
      'SYNC01',
      'socket-1',
      0,
      '<xml>v1</xml>'
    );
    expect(first).toEqual({ ok: true, revision: 1 });

    const second = store.applyDiagramUpdate(
      'SYNC01',
      'socket-1',
      1,
      '<xml>v2</xml>'
    );
    expect(second).toEqual({ ok: true, revision: 2 });
    expect(store.getSnapshot('SYNC01')?.xml).toBe('<xml>v2</xml>');
  });

  it('rejects stale diagram updates and returns canonical state', () => {
    const store = new RoomStore({ codeGenerator: () => 'STALE1' });
    store.create('socket-1', 'Alice', EMPTY_DIAGRAM_XML);
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
    store.create('socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.join('PRES01', 'socket-2', 'Bob');

    const participants = store.updatePresence('PRES01', 'socket-2', 'Task_1');
    expect(participants?.find((p) => p.id === 'socket-2')?.selectedElementId).toBe(
      'Task_1'
    );
  });

  it('removes participants on leave and deletes idle rooms after TTL', () => {
    vi.useFakeTimers();
    const store = new RoomStore({
      codeGenerator: () => 'IDLE01',
      idleTtlMs: 1000,
    });

    store.create('socket-1', 'Alice', EMPTY_DIAGRAM_XML);
    store.leave('socket-1');
    expect(store.size()).toBe(1);

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

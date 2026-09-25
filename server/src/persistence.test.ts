import { describe, expect, it } from 'vitest';
import { createRoomPersistence } from './persistence.js';

describe('createRoomPersistence', () => {
  it('returns a no-op adapter when env vars are missing', async () => {
    const persistence = createRoomPersistence({});
    expect(persistence.enabled).toBe(false);
    expect(await persistence.load('ABC123')).toBeNull();
    expect(await persistence.exists('ABC123')).toBe(false);
    await expect(
      persistence.save({
        id: 'ABC123',
        xml: '<xml/>',
        revision: 1,
        legend: [],
      })
    ).resolves.toBeUndefined();
  });
});

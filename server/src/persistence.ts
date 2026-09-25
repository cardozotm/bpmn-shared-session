import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { LegendEntry } from './types.js';

export interface PersistedRoom {
  id: string;
  xml: string;
  revision: number;
  legend: LegendEntry[];
  updatedAt: string;
}

export interface RoomPersistence {
  enabled: boolean;
  load(roomId: string): Promise<PersistedRoom | null>;
  exists(roomId: string): Promise<boolean>;
  save(room: {
    id: string;
    xml: string;
    revision: number;
    legend: LegendEntry[];
  }): Promise<void>;
}

interface RoomsRow {
  id: string;
  xml: string;
  revision: number;
  legend: LegendEntry[] | null;
  updated_at: string;
}

function normalizeLegend(value: unknown): LegendEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (entry): entry is LegendEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as LegendEntry).fill === 'string' &&
        typeof (entry as LegendEntry).label === 'string'
    )
    .map((entry) => ({
      fill: entry.fill,
      label: entry.label.slice(0, 64),
      stroke: typeof entry.stroke === 'string' ? entry.stroke : undefined,
    }));
}

class NoopPersistence implements RoomPersistence {
  enabled = false;

  async load(): Promise<PersistedRoom | null> {
    return null;
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async save(): Promise<void> {
    // no-op
  }
}

class SupabasePersistence implements RoomPersistence {
  enabled = true;

  constructor(private readonly client: SupabaseClient) {}

  async load(roomId: string): Promise<PersistedRoom | null> {
    const id = roomId.trim().toUpperCase();
    const { data, error } = await this.client
      .from('rooms')
      .select('id, xml, revision, legend, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[persistence] load failed', id, error.message);
      return null;
    }
    if (!data) {
      return null;
    }

    const row = data as RoomsRow;
    return {
      id: row.id,
      xml: row.xml,
      revision: row.revision,
      legend: normalizeLegend(row.legend),
      updatedAt: row.updated_at,
    };
  }

  async exists(roomId: string): Promise<boolean> {
    const id = roomId.trim().toUpperCase();
    const { data, error } = await this.client
      .from('rooms')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[persistence] exists failed', id, error.message);
      return false;
    }
    return !!data;
  }

  async save(room: {
    id: string;
    xml: string;
    revision: number;
    legend: LegendEntry[];
  }): Promise<void> {
    const id = room.id.trim().toUpperCase();
    const { error } = await this.client.from('rooms').upsert(
      {
        id,
        xml: room.xml,
        revision: room.revision,
        legend: room.legend,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );

    if (error) {
      console.error('[persistence] save failed', id, error.message);
    }
  }
}

export function createRoomPersistence(
  env: NodeJS.ProcessEnv = process.env
): RoomPersistence {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    return new NoopPersistence();
  }

  const client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return new SupabasePersistence(client);
}

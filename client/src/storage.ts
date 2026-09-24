import type { ActiveSession } from './types';

const CLIENT_ID_KEY = 'bpmn-client-id';
const SESSION_KEY = 'bpmn-active-session';
const ROOMS_KEY = 'bpmn-saved-rooms';
const MAX_SAVED_ROOMS = 20;

export interface SavedRoomDiagram {
  roomId: string;
  xml: string;
  revision: number;
  updatedAt: number;
  name?: string;
}

type SavedRoomsMap = Record<string, SavedRoomDiagram>;

export function getOrCreateClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing && existing.length > 0) {
    return existing;
  }
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export function saveActiveSession(roomId: string, name: string): void {
  const session: ActiveSession = { roomId, name };
  const raw = JSON.stringify(session);
  localStorage.setItem(SESSION_KEY, raw);
  sessionStorage.setItem(SESSION_KEY, raw);
}

export function loadActiveSession(): ActiveSession | null {
  const raw =
    sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ActiveSession;
    if (parsed?.roomId && typeof parsed.name === 'string') {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export function clearActiveSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
}

function readRoomsMap(): SavedRoomsMap {
  const raw = localStorage.getItem(ROOMS_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as SavedRoomsMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRoomsMap(map: SavedRoomsMap): void {
  const entries = Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmed: SavedRoomsMap = {};
  for (const entry of entries.slice(0, MAX_SAVED_ROOMS)) {
    trimmed[entry.roomId] = entry;
  }
  localStorage.setItem(ROOMS_KEY, JSON.stringify(trimmed));
}

export function saveRoomDiagram(
  roomId: string,
  xml: string,
  revision: number,
  name?: string
): void {
  const id = roomId.trim().toUpperCase();
  if (!id || !xml) {
    return;
  }
  const map = readRoomsMap();
  const previous = map[id];
  map[id] = {
    roomId: id,
    xml,
    revision,
    updatedAt: Date.now(),
    name: name ?? previous?.name,
  };
  writeRoomsMap(map);
}

export function loadRoomDiagram(roomId: string): SavedRoomDiagram | null {
  const id = roomId.trim().toUpperCase();
  return readRoomsMap()[id] ?? null;
}

export function listSavedRooms(): SavedRoomDiagram[] {
  return Object.values(readRoomsMap()).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
}

export function touchSavedRoomName(roomId: string, name: string): void {
  const id = roomId.trim().toUpperCase();
  const map = readRoomsMap();
  const existing = map[id];
  if (!existing) {
    return;
  }
  existing.name = name;
  existing.updatedAt = Date.now();
  writeRoomsMap(map);
}

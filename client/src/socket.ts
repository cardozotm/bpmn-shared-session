import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const CLIENT_ID_KEY = 'bpmn-client-id';
const SESSION_KEY = 'bpmn-active-session';

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

export function createSocket(): AppSocket {
  const clientId = getOrCreateClientId();
  return io({
    path: '/socket.io',
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    transports: ['websocket', 'polling'],
    auth: { clientId },
    query: { clientId },
  });
}

export function emitWithAck<T>(
  emit: (callback: (result: T) => void) => void,
  timeoutMs = 8000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('Tempo esgotado ao falar com o servidor.'));
    }, timeoutMs);

    emit((result) => {
      window.clearTimeout(timer);
      resolve(result);
    });
  });
}

export function saveActiveSession(roomId: string, name: string): void {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ roomId, name } satisfies import('./types').ActiveSession)
  );
}

export function loadActiveSession(): import('./types').ActiveSession | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as import('./types').ActiveSession;
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
}

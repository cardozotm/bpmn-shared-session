import { io, type Socket } from 'socket.io-client';
import { getOrCreateClientId } from './storage';
import type { ClientToServerEvents, ServerToClientEvents } from './types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export { getOrCreateClientId } from './storage';
export {
  clearActiveSession,
  loadActiveSession,
  saveActiveSession,
  loadRoomDiagram,
  saveRoomDiagram,
  saveRoomLegend,
  listSavedRooms,
  touchSavedRoomName,
} from './storage';

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

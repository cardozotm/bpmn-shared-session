import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createSocket(): AppSocket {
  return io({
    path: '/socket.io',
    autoConnect: true,
    transports: ['websocket', 'polling'],
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

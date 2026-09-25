import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createRoomPersistence } from './persistence.js';
import {
  allocateRoomCode,
  DEFAULT_LEGEND,
  EMPTY_DIAGRAM_XML,
  normalizeRoomId,
  RoomError,
  RoomStore,
  sanitizeClientId,
  sanitizeName,
} from './rooms.js';
import type {
  ClientToServerEvents,
  LegendEntry,
  ServerToClientEvents,
} from './types.js';

const PORT = Number(process.env.PORT ?? 8765);
const isProduction = process.env.NODE_ENV === 'production';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');

const app = express();
app.use(cors());
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: '*',
  },
});

const rooms = new RoomStore();
const persistence = createRoomPersistence();

if (persistence.enabled) {
  console.log('[persistence] Supabase adapter enabled');
} else {
  console.log('[persistence] No-op (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
}

async function persistRoom(roomId: string): Promise<void> {
  const snapshot = rooms.getSnapshot(roomId);
  if (!snapshot) {
    return;
  }
  await persistence.save({
    id: snapshot.roomId,
    xml: snapshot.xml,
    revision: snapshot.revision,
    legend: snapshot.legend,
  });
}

async function allocateUniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const code = allocateRoomCode();
    if (rooms.has(code)) {
      continue;
    }
    if (await persistence.exists(code)) {
      continue;
    }
    return code;
  }
  throw new Error('Unable to allocate room code');
}

io.on('connection', (socket) => {
  let currentRoomId: string | null = null;
  let currentClientId: string | null = null;

  socket.on('room:create', (payload, callback) => {
    void (async () => {
      try {
        if (currentRoomId) {
          leaveExplicit();
        }

        const clientId = sanitizeClientId(payload?.clientId ?? '');
        const name = sanitizeName(payload?.name ?? '');
        const code = await allocateUniqueCode();
        const snapshot = rooms.createWithId(
          code,
          clientId,
          socket.id,
          name,
          EMPTY_DIAGRAM_XML,
          0,
          DEFAULT_LEGEND
        );
        currentRoomId = snapshot.roomId;
        currentClientId = clientId;
        void socket.join(snapshot.roomId);
        await persistRoom(snapshot.roomId);
        callback({ ok: true, snapshot });
      } catch (error) {
        callback({
          ok: false,
          error: error instanceof Error ? error.message : 'Falha ao criar sala.',
        });
      }
    })();
  });

  socket.on('room:join', (payload, callback) => {
    void (async () => {
      try {
        const roomId = normalizeRoomId(payload.roomId);
        if (currentRoomId && currentRoomId !== roomId) {
          leaveExplicit();
        }

        const clientId = sanitizeClientId(payload?.clientId ?? '');
        const name = sanitizeName(payload?.name ?? '');
        const restoreLegend = payload.restoreLegend as LegendEntry[] | undefined;

        if (!rooms.has(roomId)) {
          const persisted = await persistence.load(roomId);
          if (persisted) {
            rooms.createWithId(
              roomId,
              clientId,
              socket.id,
              name,
              persisted.xml,
              persisted.revision,
              persisted.legend.length > 0 ? persisted.legend : DEFAULT_LEGEND
            );
          } else if (
            payload.restoreXml &&
            typeof payload.restoreXml === 'string' &&
            payload.restoreXml.trim().length > 0
          ) {
            rooms.createWithId(
              roomId,
              clientId,
              socket.id,
              name,
              payload.restoreXml,
              Math.max(0, Math.floor(payload.restoreRevision ?? 0) || 0),
              restoreLegend
            );
            await persistRoom(roomId);
          } else {
            throw new RoomError('ROOM_NOT_FOUND', 'Sala não encontrada.');
          }
        } else {
          rooms.join(roomId, clientId, socket.id, name, null);
        }

        const snapshot = rooms.getSnapshot(roomId);
        if (!snapshot) {
          throw new RoomError('ROOM_NOT_FOUND', 'Sala não encontrada.');
        }

        currentRoomId = snapshot.roomId;
        currentClientId = clientId;
        void socket.join(snapshot.roomId);
        socket.to(snapshot.roomId).emit('presence:state', {
          participants: snapshot.participants,
        });
        callback({ ok: true, snapshot });
      } catch (error) {
        if (error instanceof RoomError) {
          callback({ ok: false, error: error.message });
          return;
        }
        callback({
          ok: false,
          error: error instanceof Error ? error.message : 'Falha ao entrar na sala.',
        });
      }
    })();
  });

  socket.on('room:leave', (payload, callback) => {
    const roomId = currentRoomId;
    leaveExplicit(payload?.clientId ?? currentClientId);
    callback?.({ ok: true });
    if (roomId) {
      const snapshot = rooms.getSnapshot(roomId);
      if (snapshot) {
        socket.to(roomId).emit('presence:state', {
          participants: snapshot.participants,
        });
      }
    }
  });

  socket.on('diagram:update', (payload, callback) => {
    void (async () => {
      const result = rooms.applyDiagramUpdate(
        payload.roomId,
        socket.id,
        payload.baseRevision,
        payload.xml
      );

      if (result.ok && result.clientId) {
        await persistRoom(payload.roomId);
        socket.to(payload.roomId).emit('diagram:state', {
          xml: payload.xml,
          revision: result.revision,
          fromClientId: result.clientId,
          source: 'edit',
        });
      }

      callback(result);
    })();
  });

  socket.on('diagram:restore', (payload, callback) => {
    void (async () => {
      const result = rooms.restoreDiagram(
        payload.roomId,
        socket.id,
        payload.xml,
        payload.revision
      );

      if (result.ok && result.clientId) {
        await persistRoom(payload.roomId);
        const snapshot = rooms.getSnapshot(payload.roomId);
        if (snapshot) {
          socket.to(payload.roomId).emit('diagram:state', {
            xml: snapshot.xml,
            revision: snapshot.revision,
            fromClientId: result.clientId,
            source: payload.source === 'import' ? 'import' : 'restore',
          });
        }
      }

      callback(result);
    })();
  });

  socket.on('legend:update', (payload) => {
    void (async () => {
      const updated = rooms.updateLegend(
        payload.roomId,
        socket.id,
        payload.legend
      );
      if (!updated) {
        return;
      }
      await persistRoom(payload.roomId);
      io.to(payload.roomId).emit('legend:state', {
        legend: updated.legend,
        fromClientId: updated.clientId,
      });
    })();
  });

  socket.on('presence:update', (payload) => {
    const participants = rooms.updatePresence(
      payload.roomId,
      socket.id,
      payload.selectedElementId
    );
    if (!participants) {
      return;
    }
    io.to(payload.roomId).emit('presence:state', { participants });
  });

  socket.on('cursor:update', (payload) => {
    const participant = rooms.getParticipantBySocket(socket.id);
    if (!participant) {
      return;
    }
    if (
      typeof payload.x !== 'number' ||
      typeof payload.y !== 'number' ||
      !Number.isFinite(payload.x) ||
      !Number.isFinite(payload.y)
    ) {
      return;
    }
    socket.to(payload.roomId).emit('cursor:state', {
      clientId: participant.id,
      name: participant.name,
      color: participant.color,
      x: payload.x,
      y: payload.y,
    });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) {
      return;
    }

    const roomId = currentRoomId;
    currentRoomId = null;
    currentClientId = null;
    void socket.leave(roomId);

    rooms.beginDisconnect(socket.id, (expiredRoomId, participants) => {
      io.to(expiredRoomId).emit('presence:state', { participants });
    });
  });

  function leaveExplicit(clientId: string | null = currentClientId): void {
    if (!currentRoomId && !clientId) {
      return;
    }

    const roomId = currentRoomId;
    const id = clientId ?? currentClientId;
    currentRoomId = null;
    currentClientId = null;

    if (roomId) {
      void socket.leave(roomId);
    }

    if (!id) {
      return;
    }

    const leaveResult = rooms.leave(id);
    if (!leaveResult) {
      return;
    }

    if (roomId) {
      socket.to(roomId).emit('presence:state', {
        participants: leaveResult.participants,
      });
    }
  }
});

if (isProduction && existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io') || req.path === '/health') {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

httpServer.listen(PORT, () => {
  console.log(`BPMN sync server listening on http://localhost:${PORT}`);
});

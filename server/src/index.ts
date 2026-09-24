import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import {
  EMPTY_DIAGRAM_XML,
  RoomError,
  RoomStore,
} from './rooms.js';
import type {
  ClientToServerEvents,
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

io.on('connection', (socket) => {
  let currentRoomId: string | null = null;
  let currentClientId: string | null = null;

  socket.on('room:create', (payload, callback) => {
    try {
      if (currentRoomId) {
        leaveExplicit();
      }

      const snapshot = rooms.create(
        payload?.clientId ?? '',
        socket.id,
        payload?.name ?? '',
        EMPTY_DIAGRAM_XML
      );
      currentRoomId = snapshot.roomId;
      currentClientId = payload.clientId;
      void socket.join(snapshot.roomId);
      callback({ ok: true, snapshot });
    } catch (error) {
      callback({
        ok: false,
        error: error instanceof Error ? error.message : 'Falha ao criar sala.',
      });
    }
  });

  socket.on('room:join', (payload, callback) => {
    try {
      if (currentRoomId && currentRoomId !== payload.roomId.trim().toUpperCase()) {
        leaveExplicit();
      }

      const snapshot = rooms.join(
        payload.roomId,
        payload?.clientId ?? '',
        socket.id,
        payload?.name ?? '',
        payload.restoreXml
          ? {
              xml: payload.restoreXml,
              revision: payload.restoreRevision ?? 0,
            }
          : null
      );
      currentRoomId = snapshot.roomId;
      currentClientId = payload.clientId;
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
    const result = rooms.applyDiagramUpdate(
      payload.roomId,
      socket.id,
      payload.baseRevision,
      payload.xml
    );

    if (result.ok && result.clientId) {
      socket.to(payload.roomId).emit('diagram:state', {
        xml: payload.xml,
        revision: result.revision,
        fromClientId: result.clientId,
      });
    }

    callback(result);
  });

  socket.on('diagram:restore', (payload, callback) => {
    const result = rooms.restoreDiagram(
      payload.roomId,
      socket.id,
      payload.xml,
      payload.revision
    );

    if (result.ok && result.clientId) {
      const snapshot = rooms.getSnapshot(payload.roomId);
      if (snapshot) {
        socket.to(payload.roomId).emit('diagram:state', {
          xml: snapshot.xml,
          revision: snapshot.revision,
          fromClientId: result.clientId,
        });
      }
    }

    callback(result);
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

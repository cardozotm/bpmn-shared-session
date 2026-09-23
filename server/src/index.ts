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

  socket.on('room:create', (payload, callback) => {
    try {
      if (currentRoomId) {
        leaveCurrentRoom();
      }

      const snapshot = rooms.create(
        socket.id,
        payload?.name ?? '',
        EMPTY_DIAGRAM_XML
      );
      currentRoomId = snapshot.roomId;
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
      if (currentRoomId) {
        leaveCurrentRoom();
      }

      const snapshot = rooms.join(
        payload.roomId,
        socket.id,
        payload?.name ?? ''
      );
      currentRoomId = snapshot.roomId;
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

  socket.on('diagram:update', (payload, callback) => {
    const result = rooms.applyDiagramUpdate(
      payload.roomId,
      socket.id,
      payload.baseRevision,
      payload.xml
    );

    if (result.ok) {
      socket.to(payload.roomId).emit('diagram:state', {
        xml: payload.xml,
        revision: result.revision,
        fromSocketId: socket.id,
      });
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

  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });

  function leaveCurrentRoom(): void {
    if (!currentRoomId) {
      return;
    }

    const roomId = currentRoomId;
    currentRoomId = null;
    void socket.leave(roomId);

    const leaveResult = rooms.leave(socket.id);
    if (!leaveResult) {
      return;
    }

    socket.to(roomId).emit('presence:state', {
      participants: leaveResult.participants,
    });
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

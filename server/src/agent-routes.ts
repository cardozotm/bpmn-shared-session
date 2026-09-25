import type { Express, NextFunction, Request, Response } from 'express';
import type { Server } from 'socket.io';
import {
  AGENT_CLIENT_ID,
  applyOperations,
  parseOperations,
  summarizeGraph,
  toGraph,
} from './bpmn-graph.js';
import type { RoomPersistence } from './persistence.js';
import {
  DEFAULT_LEGEND,
  normalizeRoomId,
  type RoomStore,
} from './rooms.js';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from './types.js';

function requireAgentToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = process.env.BPMN_AGENT_TOKEN?.trim();
  if (!expected) {
    res.status(503).json({
      ok: false,
      error: 'BPMN_AGENT_TOKEN is not configured on the server.',
    });
    return;
  }

  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim() ?? '';
  if (!token || token !== expected) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  next();
}

async function ensureRoomLoaded(
  rooms: RoomStore,
  persistence: RoomPersistence,
  roomIdRaw: string
): Promise<{ roomId: string } | { error: string; status: number }> {
  const roomId = normalizeRoomId(roomIdRaw);
  if (!/^[A-Z0-9]{4,8}$/.test(roomId)) {
    return { error: 'Invalid room id', status: 400 };
  }

  if (rooms.has(roomId)) {
    return { roomId };
  }

  const persisted = await persistence.load(roomId);
  if (!persisted) {
    return { error: 'Room not found', status: 404 };
  }

  rooms.hydrateRoom(
    roomId,
    persisted.xml,
    persisted.revision,
    persisted.legend.length > 0 ? persisted.legend : DEFAULT_LEGEND
  );
  return { roomId };
}

export function registerAgentRoutes(
  app: Express,
  rooms: RoomStore,
  persistence: RoomPersistence,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  persistRoom: (roomId: string) => Promise<void>
): void {
  app.use('/agent', requireAgentToken);

  app.get('/agent/rooms/:roomId', async (req, res) => {
    try {
      const loaded = await ensureRoomLoaded(
        rooms,
        persistence,
        req.params.roomId
      );
      if ('error' in loaded) {
        res.status(loaded.status).json({ ok: false, error: loaded.error });
        return;
      }

      const snapshot = rooms.getSnapshot(loaded.roomId);
      if (!snapshot) {
        res.status(404).json({ ok: false, error: 'Room not found' });
        return;
      }

      const includeXml = req.query.includeXml !== '0' && req.query.includeXml !== 'false';
      res.json({
        ok: true,
        roomId: snapshot.roomId,
        revision: snapshot.revision,
        legend: snapshot.legend,
        participants: snapshot.participants,
        ...(includeXml ? { xml: snapshot.xml } : {}),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to load room',
      });
    }
  });

  app.get('/agent/rooms/:roomId/graph', async (req, res) => {
    try {
      const loaded = await ensureRoomLoaded(
        rooms,
        persistence,
        req.params.roomId
      );
      if ('error' in loaded) {
        res.status(loaded.status).json({ ok: false, error: loaded.error });
        return;
      }

      const snapshot = rooms.getSnapshot(loaded.roomId);
      if (!snapshot) {
        res.status(404).json({ ok: false, error: 'Room not found' });
        return;
      }

      const graph = await toGraph(snapshot.xml);
      res.json({
        ok: true,
        roomId: snapshot.roomId,
        revision: snapshot.revision,
        graph,
        summary: summarizeGraph(graph),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to build graph',
      });
    }
  });

  app.post('/agent/rooms/:roomId/mutations', async (req, res) => {
    try {
      const loaded = await ensureRoomLoaded(
        rooms,
        persistence,
        req.params.roomId
      );
      if ('error' in loaded) {
        res.status(loaded.status).json({ ok: false, error: loaded.error });
        return;
      }

      const operations = parseOperations(req.body?.operations);
      if (operations.length === 0) {
        res.status(400).json({ ok: false, error: 'operations must be non-empty' });
        return;
      }

      const applyOnce = async () => {
        const snapshot = rooms.getSnapshot(loaded.roomId);
        if (!snapshot) {
          return {
            ok: false as const,
            status: 404,
            error: 'Room not found',
          };
        }

        const { xml, applied } = await applyOperations(
          snapshot.xml,
          operations
        );
        const result = rooms.applyAgentDiagramUpdate(
          loaded.roomId,
          snapshot.revision,
          xml
        );
        if (!result.ok) {
          return {
            ok: false as const,
            status: 409,
            error: result.error ?? 'Conflict',
            revision: result.revision,
            xml: result.xml,
            applied: 0,
          };
        }

        await persistRoom(loaded.roomId);
        io.to(loaded.roomId).emit('diagram:state', {
          xml,
          revision: result.revision,
          fromClientId: AGENT_CLIENT_ID,
          source: 'edit',
        });

        const graph = await toGraph(xml);
        return {
          ok: true as const,
          roomId: loaded.roomId,
          revision: result.revision,
          applied,
          graph,
          summary: summarizeGraph(graph),
        };
      };

      let outcome = await applyOnce();
      if (!outcome.ok && outcome.status === 409) {
        outcome = await applyOnce();
      }

      if (!outcome.ok) {
        res.status(outcome.status).json(outcome);
        return;
      }

      res.json(outcome);
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Mutation failed',
      });
    }
  });
}

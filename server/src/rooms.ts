import {
  PARTICIPANT_COLORS,
  type DiagramUpdateResult,
  type ParticipantPublic,
  type RoomSnapshot,
} from './types.js';

/** Keep empty rooms (and their XML) for 24h after the last explicit leave. */
export const ROOM_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/** Wait before freeing a seat after a transport disconnect (reconnect window). */
export const DISCONNECT_GRACE_MS = 45_000;

export interface Participant {
  clientId: string;
  socketId: string;
  name: string;
  color: (typeof PARTICIPANT_COLORS)[number];
  selectedElementId: string | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface Room {
  id: string;
  xml: string;
  revision: number;
  /** Keyed by clientId */
  participants: Map<string, Participant>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface RoomStoreOptions {
  now?: () => number;
  idleTtlMs?: number;
  disconnectGraceMs?: number;
  codeGenerator?: () => string;
}

function defaultCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export class RoomStore {
  private rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private readonly disconnectGraceMs: number;
  private readonly codeGenerator: () => string;

  constructor(options: RoomStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? ROOM_IDLE_TTL_MS;
    this.disconnectGraceMs = options.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
    this.codeGenerator = options.codeGenerator ?? defaultCode;
  }

  create(
    clientId: string,
    socketId: string,
    name: string,
    initialXml: string
  ): RoomSnapshot {
    const id = sanitizeClientId(clientId);
    if (!id) {
      throw new RoomError('INVALID_CLIENT', 'clientId inválido.');
    }

    const roomId = this.allocateCode();
    const participant: Participant = {
      clientId: id,
      socketId,
      name: sanitizeName(name),
      color: PARTICIPANT_COLORS[0],
      selectedElementId: null,
      disconnectTimer: null,
    };

    const room: Room = {
      id: roomId,
      xml: initialXml,
      revision: 0,
      participants: new Map([[id, participant]]),
      idleTimer: null,
    };

    this.rooms.set(roomId, room);
    return this.toSnapshot(room);
  }

  join(
    roomId: string,
    clientId: string,
    socketId: string,
    name: string
  ): RoomSnapshot {
    const id = sanitizeClientId(clientId);
    if (!id) {
      throw new RoomError('INVALID_CLIENT', 'clientId inválido.');
    }

    const room = this.rooms.get(normalizeRoomId(roomId));
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Sala não encontrada.');
    }

    this.clearIdleTimer(room);

    const existing = room.participants.get(id);
    if (existing) {
      this.clearDisconnectTimer(existing);
      existing.socketId = socketId;
      existing.name = sanitizeName(name);
      return this.toSnapshot(room);
    }

    if (room.participants.size >= 2) {
      throw new RoomError('ROOM_FULL', 'Esta sala já tem dois participantes.');
    }

    const usedColors = new Set(
      [...room.participants.values()].map((participant) => participant.color)
    );
    const color =
      PARTICIPANT_COLORS.find((candidate) => !usedColors.has(candidate)) ??
      PARTICIPANT_COLORS[1];

    room.participants.set(id, {
      clientId: id,
      socketId,
      name: sanitizeName(name),
      color,
      selectedElementId: null,
      disconnectTimer: null,
    });

    return this.toSnapshot(room);
  }

  /**
   * Soft disconnect: keep the seat for a grace period so the same clientId can rejoin.
   * When the grace expires, `onExpired` receives the post-removal presence list.
   */
  beginDisconnect(
    socketId: string,
    onExpired?: (roomId: string, participants: ParticipantPublic[]) => void
  ): { roomId: string; participants: ParticipantPublic[] } | null {
    const found = this.findBySocket(socketId);
    if (!found) {
      return null;
    }

    const { room, participant } = found;
    this.clearDisconnectTimer(participant);

    participant.disconnectTimer = setTimeout(() => {
      participant.disconnectTimer = null;
      // Only remove if still associated with this socket (not rejoined).
      if (participant.socketId !== socketId) {
        return;
      }
      const result = this.removeParticipant(room, participant.clientId);
      onExpired?.(result.roomId, result.participants);
    }, this.disconnectGraceMs);

    return {
      roomId: room.id,
      participants: this.toPublicParticipants(room),
    };
  }

  /** Explicit leave: free the seat immediately. Room XML stays until idle TTL. */
  leave(
    clientId: string
  ): { roomId: string; participants: ParticipantPublic[] } | null {
    const id = sanitizeClientId(clientId);
    const found = this.findByClientId(id);
    if (!found) {
      return null;
    }

    const { room, participant } = found;
    this.clearDisconnectTimer(participant);
    return this.removeParticipant(room, id);
  }

  leaveBySocket(
    socketId: string
  ): { roomId: string; participants: ParticipantPublic[] } | null {
    const found = this.findBySocket(socketId);
    if (!found) {
      return null;
    }
    this.clearDisconnectTimer(found.participant);
    return this.removeParticipant(found.room, found.participant.clientId);
  }

  applyDiagramUpdate(
    roomId: string,
    socketId: string,
    baseRevision: number,
    xml: string
  ): DiagramUpdateResult & { clientId?: string } {
    const room = this.rooms.get(normalizeRoomId(roomId));
    if (!room) {
      return {
        ok: false,
        error: 'Sala não encontrada.',
        xml: '',
        revision: 0,
      };
    }

    const participant = [...room.participants.values()].find(
      (p) => p.socketId === socketId
    );
    if (!participant) {
      return {
        ok: false,
        error: 'Você não está nesta sala.',
        xml: room.xml,
        revision: room.revision,
      };
    }

    if (baseRevision !== room.revision) {
      return {
        ok: false,
        error: 'Diagrama atualizado por outro participante.',
        xml: room.xml,
        revision: room.revision,
      };
    }

    if (typeof xml !== 'string' || xml.trim().length === 0) {
      return {
        ok: false,
        error: 'XML inválido.',
        xml: room.xml,
        revision: room.revision,
      };
    }

    room.xml = xml;
    room.revision += 1;

    return { ok: true, revision: room.revision, clientId: participant.clientId };
  }

  updatePresence(
    roomId: string,
    socketId: string,
    selectedElementId: string | null
  ): ParticipantPublic[] | null {
    const room = this.rooms.get(normalizeRoomId(roomId));
    if (!room) {
      return null;
    }

    const participant = [...room.participants.values()].find(
      (p) => p.socketId === socketId
    );
    if (!participant) {
      return null;
    }

    participant.selectedElementId = selectedElementId;
    return this.toPublicParticipants(room);
  }

  getSnapshot(roomId: string): RoomSnapshot | null {
    const room = this.rooms.get(normalizeRoomId(roomId));
    return room ? this.toSnapshot(room) : null;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(normalizeRoomId(roomId));
  }

  getClientIdForSocket(socketId: string): string | null {
    return this.findBySocket(socketId)?.participant.clientId ?? null;
  }

  getParticipantBySocket(socketId: string): ParticipantPublic | null {
    const found = this.findBySocket(socketId);
    if (!found) {
      return null;
    }
    const { participant } = found;
    return {
      id: participant.clientId,
      name: participant.name,
      color: participant.color,
      selectedElementId: participant.selectedElementId,
    };
  }

  forceDelete(roomId: string): void {
    const room = this.rooms.get(normalizeRoomId(roomId));
    if (!room) {
      return;
    }
    for (const participant of room.participants.values()) {
      this.clearDisconnectTimer(participant);
    }
    this.clearIdleTimer(room);
    this.rooms.delete(room.id);
  }

  size(): number {
    return this.rooms.size;
  }

  private removeParticipant(
    room: Room,
    clientId: string
  ): { roomId: string; participants: ParticipantPublic[] } {
    room.participants.delete(clientId);

    if (room.participants.size === 0) {
      this.scheduleIdleCleanup(room);
      return {
        roomId: room.id,
        participants: [],
      };
    }

    return {
      roomId: room.id,
      participants: this.toPublicParticipants(room),
    };
  }

  private allocateCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = this.codeGenerator();
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error('Unable to allocate room code');
  }

  private findBySocket(
    socketId: string
  ): { room: Room; participant: Participant } | undefined {
    for (const room of this.rooms.values()) {
      for (const participant of room.participants.values()) {
        if (participant.socketId === socketId) {
          return { room, participant };
        }
      }
    }
    return undefined;
  }

  private findByClientId(
    clientId: string
  ): { room: Room; participant: Participant } | undefined {
    for (const room of this.rooms.values()) {
      const participant = room.participants.get(clientId);
      if (participant) {
        return { room, participant };
      }
    }
    return undefined;
  }

  private scheduleIdleCleanup(room: Room): void {
    this.clearIdleTimer(room);
    room.idleTimer = setTimeout(() => {
      if (room.participants.size === 0) {
        this.rooms.delete(room.id);
      }
    }, this.idleTtlMs);
  }

  private clearIdleTimer(room: Room): void {
    if (room.idleTimer) {
      clearTimeout(room.idleTimer);
      room.idleTimer = null;
    }
  }

  private clearDisconnectTimer(participant: Participant): void {
    if (participant.disconnectTimer) {
      clearTimeout(participant.disconnectTimer);
      participant.disconnectTimer = null;
    }
  }

  private toPublicParticipants(room: Room): ParticipantPublic[] {
    return [...room.participants.values()].map((participant) => ({
      id: participant.clientId,
      name: participant.name,
      color: participant.color,
      selectedElementId: participant.selectedElementId,
    }));
  }

  private toSnapshot(room: Room): RoomSnapshot {
    return {
      roomId: room.id,
      xml: room.xml,
      revision: room.revision,
      participants: this.toPublicParticipants(room),
    };
  }
}

export class RoomError extends Error {
  constructor(
    public readonly code: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'INVALID_CLIENT',
    message: string
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export function sanitizeName(name: string): string {
  const trimmed = name.trim().slice(0, 32);
  return trimmed.length > 0 ? trimmed : 'Anônimo';
}

export function sanitizeClientId(clientId: string): string {
  return clientId.trim().slice(0, 64);
}

export function normalizeRoomId(roomId: string): string {
  return roomId.trim().toUpperCase();
}

/** Minimal valid BPMN diagram used when a room is created. */
export const EMPTY_DIAGRAM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="_BPMNShape_StartEvent_2" bpmnElement="StartEvent_1">
        <dc:Bounds x="180" y="100" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

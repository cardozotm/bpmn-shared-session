import {
  PARTICIPANT_COLORS,
  type DiagramUpdateResult,
  type ParticipantPublic,
  type RoomSnapshot,
} from './types.js';

const ROOM_IDLE_TTL_MS = 60_000;

export interface Participant {
  socketId: string;
  name: string;
  color: (typeof PARTICIPANT_COLORS)[number];
  selectedElementId: string | null;
}

export interface Room {
  id: string;
  xml: string;
  revision: number;
  participants: Map<string, Participant>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface RoomStoreOptions {
  now?: () => number;
  idleTtlMs?: number;
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
  private readonly codeGenerator: () => string;

  constructor(options: RoomStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? ROOM_IDLE_TTL_MS;
    this.codeGenerator = options.codeGenerator ?? defaultCode;
  }

  create(socketId: string, name: string, initialXml: string): RoomSnapshot {
    const roomId = this.allocateCode();
    const participant: Participant = {
      socketId,
      name: sanitizeName(name),
      color: PARTICIPANT_COLORS[0],
      selectedElementId: null,
    };

    const room: Room = {
      id: roomId,
      xml: initialXml,
      revision: 0,
      participants: new Map([[socketId, participant]]),
      idleTimer: null,
    };

    this.rooms.set(roomId, room);
    return this.toSnapshot(room);
  }

  join(roomId: string, socketId: string, name: string): RoomSnapshot {
    const room = this.rooms.get(normalizeRoomId(roomId));
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Sala não encontrada.');
    }

    this.clearIdleTimer(room);

    if (room.participants.has(socketId)) {
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

    room.participants.set(socketId, {
      socketId,
      name: sanitizeName(name),
      color,
      selectedElementId: null,
    });

    return this.toSnapshot(room);
  }

  leave(socketId: string): { roomId: string; closed: boolean; participants: ParticipantPublic[] } | null {
    const room = this.findRoomBySocket(socketId);
    if (!room) {
      return null;
    }

    room.participants.delete(socketId);

    if (room.participants.size === 0) {
      this.scheduleIdleCleanup(room);
      return {
        roomId: room.id,
        closed: false,
        participants: [],
      };
    }

    return {
      roomId: room.id,
      closed: false,
      participants: this.toPublicParticipants(room),
    };
  }

  applyDiagramUpdate(
    roomId: string,
    socketId: string,
    baseRevision: number,
    xml: string
  ): DiagramUpdateResult {
    const room = this.rooms.get(normalizeRoomId(roomId));
    if (!room) {
      return {
        ok: false,
        error: 'Sala não encontrada.',
        xml: '',
        revision: 0,
      };
    }

    if (!room.participants.has(socketId)) {
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

    return { ok: true, revision: room.revision };
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

    const participant = room.participants.get(socketId);
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

  forceDelete(roomId: string): void {
    const room = this.rooms.get(normalizeRoomId(roomId));
    if (!room) {
      return;
    }
    this.clearIdleTimer(room);
    this.rooms.delete(room.id);
  }

  size(): number {
    return this.rooms.size;
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

  private findRoomBySocket(socketId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.participants.has(socketId)) {
        return room;
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

  private toPublicParticipants(room: Room): ParticipantPublic[] {
    return [...room.participants.values()].map((participant) => ({
      id: participant.socketId,
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
    public readonly code: 'ROOM_NOT_FOUND' | 'ROOM_FULL',
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

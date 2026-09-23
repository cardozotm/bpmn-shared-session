export const PARTICIPANT_COLORS = ['#2563eb', '#dc2626'] as const;

export type ParticipantColor = (typeof PARTICIPANT_COLORS)[number];

export interface ParticipantPublic {
  id: string;
  name: string;
  color: ParticipantColor;
  selectedElementId: string | null;
}

export interface RoomSnapshot {
  roomId: string;
  xml: string;
  revision: number;
  participants: ParticipantPublic[];
}

export interface DiagramUpdatePayload {
  roomId: string;
  baseRevision: number;
  xml: string;
}

export interface PresenceUpdatePayload {
  roomId: string;
  selectedElementId: string | null;
}

export type RoomCreateResult =
  | { ok: true; snapshot: RoomSnapshot }
  | { ok: false; error: string };

export type RoomJoinResult =
  | { ok: true; snapshot: RoomSnapshot }
  | { ok: false; error: string };

export type DiagramUpdateResult =
  | { ok: true; revision: number }
  | { ok: false; error: string; xml: string; revision: number };

export type ClientToServerEvents = {
  'room:create': (
    payload: { name: string },
    callback: (result: RoomCreateResult) => void
  ) => void;
  'room:join': (
    payload: { roomId: string; name: string },
    callback: (result: RoomJoinResult) => void
  ) => void;
  'diagram:update': (
    payload: DiagramUpdatePayload,
    callback: (result: DiagramUpdateResult) => void
  ) => void;
  'presence:update': (payload: PresenceUpdatePayload) => void;
};

export type ServerToClientEvents = {
  'diagram:state': (payload: {
    xml: string;
    revision: number;
    fromSocketId: string;
  }) => void;
  'presence:state': (payload: { participants: ParticipantPublic[] }) => void;
  'room:closed': (payload: { reason: string }) => void;
};

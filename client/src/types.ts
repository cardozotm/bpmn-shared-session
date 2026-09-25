export const PARTICIPANT_COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#ca8a04',
  '#9333ea',
] as const;

export type ParticipantColor = (typeof PARTICIPANT_COLORS)[number];

export interface LegendEntry {
  fill: string;
  label: string;
  stroke?: string;
}

export const DEFAULT_LEGEND: LegendEntry[] = [
  { fill: '#bfdbfe', stroke: '#1d4ed8', label: 'A fazer' },
  { fill: '#fde68a', stroke: '#b45309', label: 'Em andamento' },
  { fill: '#fecaca', stroke: '#b91c1c', label: 'Bloqueado' },
  { fill: '#bbf7d0', stroke: '#15803d', label: 'Concluído' },
  { fill: '#e9d5ff', stroke: '#7e22ce', label: 'Revisão' },
  { fill: '#f1f5f9', stroke: '#475569', label: 'Neutro' },
];

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
  legend: LegendEntry[];
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

export interface CursorUpdatePayload {
  roomId: string;
  x: number;
  y: number;
}

export interface CursorStatePayload {
  clientId: string;
  name: string;
  color: ParticipantColor;
  x: number;
  y: number;
}

export interface DiagramRestorePayload {
  roomId: string;
  xml: string;
  revision: number;
  source?: 'import' | 'restore';
}

export interface LegendUpdatePayload {
  roomId: string;
  legend: LegendEntry[];
}

export type ClientToServerEvents = {
  'room:create': (
    payload: { name: string; clientId: string },
    callback: (result: RoomCreateResult) => void
  ) => void;
  'room:join': (
    payload: {
      roomId: string;
      name: string;
      clientId: string;
      restoreXml?: string;
      restoreRevision?: number;
      restoreLegend?: LegendEntry[];
    },
    callback: (result: RoomJoinResult) => void
  ) => void;
  'room:leave': (
    payload: { roomId: string; clientId: string },
    callback?: (result: { ok: boolean }) => void
  ) => void;
  'diagram:update': (
    payload: DiagramUpdatePayload,
    callback: (result: DiagramUpdateResult) => void
  ) => void;
  'diagram:restore': (
    payload: DiagramRestorePayload,
    callback: (result: DiagramUpdateResult) => void
  ) => void;
  'presence:update': (payload: PresenceUpdatePayload) => void;
  'cursor:update': (payload: CursorUpdatePayload) => void;
  'legend:update': (payload: LegendUpdatePayload) => void;
};

export type ServerToClientEvents = {
  'diagram:state': (payload: {
    xml: string;
    revision: number;
    fromClientId: string;
    source?: 'import' | 'edit' | 'restore';
  }) => void;
  'presence:state': (payload: { participants: ParticipantPublic[] }) => void;
  'cursor:state': (payload: CursorStatePayload) => void;
  'legend:state': (payload: { legend: LegendEntry[]; fromClientId: string }) => void;
  'room:closed': (payload: { reason: string }) => void;
};

export type RoomCreateResult =
  | { ok: true; snapshot: RoomSnapshot }
  | { ok: false; error: string };

export type RoomJoinResult =
  | { ok: true; snapshot: RoomSnapshot }
  | { ok: false; error: string };

export type DiagramUpdateResult =
  | { ok: true; revision: number }
  | { ok: false; error: string; xml: string; revision: number };

export interface ActiveSession {
  roomId: string;
  name: string;
}

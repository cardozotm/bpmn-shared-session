import type BpmnModeler from 'bpmn-js/lib/Modeler';
import type { AppSocket } from './socket';
import type { ParticipantPublic, RoomSnapshot } from './types';

const DEBOUNCE_MS = 250;
const REMOTE_SELECTION_MARKER = 'remote-selection';

export interface CollaborationHandle {
  dispose: () => void;
  applySnapshot: (snapshot: RoomSnapshot) => Promise<void>;
  flush: () => Promise<void>;
  getRevision: () => number;
}

interface SyncOptions {
  modeler: BpmnModeler;
  socket: AppSocket;
  roomId: string;
  initialRevision: number;
  localClientId: string;
  onRevision: (revision: number) => void;
  onConflict: (message: string) => void;
  onParticipants: (participants: ParticipantPublic[]) => void;
}

export function attachCollaboration(options: SyncOptions): CollaborationHandle {
  const {
    modeler,
    socket,
    roomId,
    localClientId,
    onRevision,
    onConflict,
    onParticipants,
  } = options;

  let revision = options.initialRevision;
  let applyingRemote = false;
  let debounceTimer: number | null = null;
  let destroyed = false;
  let pendingFlush = false;

  const canvas = modeler.get('canvas') as {
    viewbox: (vb?: unknown) => unknown;
    addMarker: (id: string, marker: string) => void;
    removeMarker: (id: string, marker: string) => void;
    resized?: () => void;
  };
  const eventBus = modeler.get('eventBus') as {
    on: (event: string, priority: number | ((e: unknown) => void), handler?: (e: unknown) => void) => void;
    off: (event: string, handler: (e: unknown) => void) => void;
  };

  const onCommandStackChanged = () => {
    if (applyingRemote || destroyed) {
      return;
    }
    schedulePush();
  };

  const onSelectionChanged = (event: unknown) => {
    if (applyingRemote || destroyed) {
      return;
    }
    const selection = (event as { newSelection?: Array<{ id: string }> }).newSelection ?? [];
    const selectedElementId = selection[0]?.id ?? null;
    socket.emit('presence:update', { roomId, selectedElementId });
  };

  eventBus.on('commandStack.changed', onCommandStackChanged);
  eventBus.on('selection.changed', onSelectionChanged);

  const onDiagramState = async (payload: {
    xml: string;
    revision: number;
    fromClientId: string;
  }) => {
    if (payload.fromClientId === localClientId || destroyed) {
      return;
    }
    await applyRemoteXml(payload.xml, payload.revision);
  };

  const onPresenceState = (payload: { participants: ParticipantPublic[] }) => {
    if (destroyed) {
      return;
    }
    onParticipants(payload.participants);
    paintRemoteSelections(payload.participants);
  };

  socket.on('diagram:state', onDiagramState);
  socket.on('presence:state', onPresenceState);

  function schedulePush(): void {
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void pushLocalXml();
    }, DEBOUNCE_MS);
  }

  async function pushLocalXml(): Promise<void> {
    if (applyingRemote || destroyed) {
      return;
    }

    if (!socket.connected) {
      pendingFlush = true;
      return;
    }

    try {
      const { xml } = await modeler.saveXML({ format: true });
      if (!xml) {
        return;
      }

      const baseRevision = revision;
      pendingFlush = false;
      socket.emit(
        'diagram:update',
        { roomId, baseRevision, xml },
        (result) => {
          if (destroyed) {
            return;
          }
          if (result.ok) {
            revision = result.revision;
            onRevision(revision);
            return;
          }

          onConflict(result.error);
          void applyRemoteXml(result.xml, result.revision);
        }
      );
    } catch (error) {
      console.error('Failed to export diagram', error);
      pendingFlush = true;
    }
  }

  async function applyRemoteXml(xml: string, nextRevision: number): Promise<void> {
    applyingRemote = true;
    const viewbox = canvas.viewbox();

    try {
      await modeler.importXML(xml);
      canvas.viewbox(viewbox);
      canvas.resized?.();
      revision = nextRevision;
      onRevision(revision);
    } catch (error) {
      console.error('Failed to import remote diagram', error);
    } finally {
      applyingRemote = false;
    }
  }

  async function applySnapshot(snapshot: RoomSnapshot): Promise<void> {
    if (destroyed) {
      return;
    }
    onParticipants(snapshot.participants);
    paintRemoteSelections(snapshot.participants);
    if (snapshot.revision !== revision) {
      await applyRemoteXml(snapshot.xml, snapshot.revision);
    } else {
      revision = snapshot.revision;
      onRevision(revision);
    }
    if (pendingFlush) {
      await pushLocalXml();
    }
  }

  const paintedMarkers = new Map<string, string>();

  function paintRemoteSelections(participants: ParticipantPublic[]): void {
    for (const [elementId] of paintedMarkers) {
      try {
        canvas.removeMarker(elementId, REMOTE_SELECTION_MARKER);
      } catch {
        // Element may no longer exist.
      }
    }
    paintedMarkers.clear();

    const styleId = 'remote-selection-style';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }

    const rules: string[] = [];

    for (const participant of participants) {
      if (participant.id === localClientId || !participant.selectedElementId) {
        continue;
      }

      const elementId = participant.selectedElementId;
      try {
        canvas.addMarker(elementId, REMOTE_SELECTION_MARKER);
        paintedMarkers.set(elementId, participant.color);
        rules.push(
          `.djs-element.remote-selection:not(.selected) .djs-visual > :nth-child(1) { stroke: ${participant.color} !important; stroke-width: 3px !important; }`
        );
      } catch {
        // Element may not be in the diagram yet.
      }
    }

    const peer = participants.find(
      (p) => p.id !== localClientId && p.selectedElementId
    );
    if (peer) {
      (modeler.get('canvas') as { _container?: HTMLElement })._container
        ?.style.setProperty('--remote-selection-color', peer.color);
      rules.push(
        `.djs-element.remote-selection:not(.selected) .djs-visual > :nth-child(1) { stroke: var(--remote-selection-color, ${peer.color}) !important; stroke-width: 3px !important; }`
      );
    }

    styleEl.textContent = rules.join('\n');
  }

  return {
    dispose: () => {
      destroyed = true;
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
      }
      eventBus.off('commandStack.changed', onCommandStackChanged);
      eventBus.off('selection.changed', onSelectionChanged);
      socket.off('diagram:state', onDiagramState);
      socket.off('presence:state', onPresenceState);
    },
    applySnapshot,
    flush: pushLocalXml,
    getRevision: () => revision,
  };
}

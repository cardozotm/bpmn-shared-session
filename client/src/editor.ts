import type BpmnModeler from 'bpmn-js/lib/Modeler';
import type { AppSocket } from './socket';
import type { ParticipantPublic } from './types';

const DEBOUNCE_MS = 250;
const REMOTE_SELECTION_MARKER = 'remote-selection';

interface SyncOptions {
  modeler: BpmnModeler;
  socket: AppSocket;
  roomId: string;
  initialRevision: number;
  localSocketId: string;
  onRevision: (revision: number) => void;
  onConflict: (message: string) => void;
  onParticipants: (participants: ParticipantPublic[]) => void;
}

export function attachCollaboration(options: SyncOptions): () => void {
  const {
    modeler,
    socket,
    roomId,
    localSocketId,
    onRevision,
    onConflict,
    onParticipants,
  } = options;

  let revision = options.initialRevision;
  let applyingRemote = false;
  let debounceTimer: number | null = null;
  let destroyed = false;

  const canvas = modeler.get('canvas') as {
    viewbox: (vb?: unknown) => unknown;
    addMarker: (id: string, marker: string) => void;
    removeMarker: (id: string, marker: string) => void;
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
    fromSocketId: string;
  }) => {
    if (payload.fromSocketId === localSocketId || destroyed) {
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

    try {
      const { xml } = await modeler.saveXML({ format: true });
      if (!xml) {
        return;
      }

      const baseRevision = revision;
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
    }
  }

  async function applyRemoteXml(xml: string, nextRevision: number): Promise<void> {
    applyingRemote = true;
    const viewbox = canvas.viewbox();

    try {
      await modeler.importXML(xml);
      canvas.viewbox(viewbox);
      revision = nextRevision;
      onRevision(revision);
    } catch (error) {
      console.error('Failed to import remote diagram', error);
    } finally {
      applyingRemote = false;
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
      if (participant.id === localSocketId || !participant.selectedElementId) {
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

    // Color is applied via CSS variable on the canvas container for the latest peer.
    const peer = participants.find(
      (p) => p.id !== localSocketId && p.selectedElementId
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

  return () => {
    destroyed = true;
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
    }
    eventBus.off('commandStack.changed', onCommandStackChanged);
    eventBus.off('selection.changed', onSelectionChanged);
    socket.off('diagram:state', onDiagramState);
    socket.off('presence:state', onPresenceState);
  };
}

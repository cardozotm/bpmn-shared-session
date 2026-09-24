import type BpmnModeler from 'bpmn-js/lib/Modeler';
import type { AppSocket } from './socket';
import { saveRoomDiagram } from './storage';
import type { CursorStatePayload, ParticipantPublic, RoomSnapshot } from './types';

const DEBOUNCE_MS = 250;
const CURSOR_THROTTLE_MS = 40;
const CURSOR_HIDE_MS = 2500;
const REMOTE_SELECTION_MARKER = 'remote-selection';

interface Viewbox {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface CollaborationHandle {
  dispose: () => void;
  applySnapshot: (snapshot: RoomSnapshot) => Promise<void>;
  loadImportedDiagram: (xml: string, revision: number) => Promise<void>;
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
  let cursorThrottleTimer: number | null = null;
  let destroyed = false;
  let pendingFlush = false;
  let lastCursorDiagram: { x: number; y: number } | null = null;

  const canvas = modeler.get('canvas') as {
    viewbox: (vb?: unknown) => Viewbox;
    addMarker: (id: string, marker: string) => void;
    removeMarker: (id: string, marker: string) => void;
    resized?: () => void;
    _container?: HTMLElement;
  };
  const containerEl = canvas._container;
  if (!containerEl) {
    throw new Error('BPMN canvas container missing');
  }
  const container: HTMLElement = containerEl;
  container.style.position = container.style.position || 'relative';

  const cursorLayer = document.createElement('div');
  cursorLayer.className = 'remote-cursors';
  cursorLayer.setAttribute('aria-hidden', 'true');
  container.appendChild(cursorLayer);

  const remoteCursors = new Map<
    string,
    { el: HTMLElement; hideTimer: number | null }
  >();

  const eventBus = modeler.get('eventBus') as {
    on: (
      event: string,
      priority: number | ((e: unknown) => void),
      handler?: (e: unknown) => void
    ) => void;
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
    const selection =
      (event as { newSelection?: Array<{ id: string }> }).newSelection ?? [];
    const selectedElementId = selection[0]?.id ?? null;
    socket.emit('presence:update', { roomId, selectedElementId });
  };

  const onCanvasMouseMove = (event: MouseEvent) => {
    if (destroyed || applyingRemote) {
      return;
    }
    const diagramPoint = clientToDiagram(event.clientX, event.clientY);
    if (!diagramPoint) {
      return;
    }
    lastCursorDiagram = diagramPoint;
    if (cursorThrottleTimer !== null) {
      return;
    }
    cursorThrottleTimer = window.setTimeout(() => {
      cursorThrottleTimer = null;
      if (!lastCursorDiagram || destroyed || !socket.connected) {
        return;
      }
      socket.emit('cursor:update', {
        roomId,
        x: lastCursorDiagram.x,
        y: lastCursorDiagram.y,
      });
    }, CURSOR_THROTTLE_MS);
  };

  const onCanvasMouseLeave = () => {
    lastCursorDiagram = null;
  };

  eventBus.on('commandStack.changed', onCommandStackChanged);
  eventBus.on('selection.changed', onSelectionChanged);
  eventBus.on('canvas.viewbox.changed', repositionRemoteCursors);
  container.addEventListener('mousemove', onCanvasMouseMove);
  container.addEventListener('mouseleave', onCanvasMouseLeave);

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
    const activeIds = new Set(payload.participants.map((p) => p.id));
    for (const clientId of [...remoteCursors.keys()]) {
      if (!activeIds.has(clientId)) {
        removeRemoteCursor(clientId);
      }
    }
  };

  const onCursorState = (payload: CursorStatePayload) => {
    if (destroyed || payload.clientId === localClientId) {
      return;
    }
    showRemoteCursor(payload);
  };

  socket.on('diagram:state', onDiagramState);
  socket.on('presence:state', onPresenceState);
  socket.on('cursor:state', onCursorState);

  function clientToDiagram(
    clientX: number,
    clientY: number
  ): { x: number; y: number } | null {
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    const viewbox = canvas.viewbox();
    const scale = viewbox.scale || 1;
    return {
      x: viewbox.x + (clientX - rect.left) / scale,
      y: viewbox.y + (clientY - rect.top) / scale,
    };
  }

  function diagramToLayer(x: number, y: number): { left: number; top: number } {
    const viewbox = canvas.viewbox();
    const scale = viewbox.scale || 1;
    return {
      left: (x - viewbox.x) * scale,
      top: (y - viewbox.y) * scale,
    };
  }

  function showRemoteCursor(payload: CursorStatePayload): void {
    let entry = remoteCursors.get(payload.clientId);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML = `
        <svg class="remote-cursor-pointer" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M4 3l1.5 16 4.2-4.2 4.6 7.2 2.1-1.3-4.6-7.2L20 8.5 4 3z" fill="currentColor"/>
        </svg>
        <span class="remote-cursor-label"></span>
      `;
      cursorLayer.appendChild(el);
      entry = { el, hideTimer: null };
      remoteCursors.set(payload.clientId, entry);
    }

    entry.el.style.color = payload.color;
    const label = entry.el.querySelector('.remote-cursor-label');
    if (label) {
      label.textContent = payload.name;
      (label as HTMLElement).style.background = payload.color;
    }

    const pos = diagramToLayer(payload.x, payload.y);
    entry.el.style.transform = `translate(${pos.left}px, ${pos.top}px)`;
    entry.el.classList.add('is-visible');
    entry.el.dataset.x = String(payload.x);
    entry.el.dataset.y = String(payload.y);

    if (entry.hideTimer !== null) {
      window.clearTimeout(entry.hideTimer);
    }
    entry.hideTimer = window.setTimeout(() => {
      entry?.el.classList.remove('is-visible');
    }, CURSOR_HIDE_MS);
  }

  function repositionRemoteCursors(): void {
    for (const entry of remoteCursors.values()) {
      const x = Number(entry.el.dataset.x);
      const y = Number(entry.el.dataset.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      const pos = diagramToLayer(x, y);
      entry.el.style.transform = `translate(${pos.left}px, ${pos.top}px)`;
    }
  }

  function removeRemoteCursor(clientId: string): void {
    const entry = remoteCursors.get(clientId);
    if (!entry) {
      return;
    }
    if (entry.hideTimer !== null) {
      window.clearTimeout(entry.hideTimer);
    }
    entry.el.remove();
    remoteCursors.delete(clientId);
  }

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
            saveRoomDiagram(roomId, xml, revision);
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
      saveRoomDiagram(roomId, xml, revision);
      repositionRemoteCursors();
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

  async function loadImportedDiagram(
    xml: string,
    nextRevision: number
  ): Promise<void> {
    if (destroyed) {
      return;
    }
    await applyRemoteXml(xml, nextRevision);
    const canvasApi = modeler.get('canvas') as {
      zoom: (mode: string) => void;
      resized?: () => void;
    };
    canvasApi.resized?.();
    canvasApi.zoom('fit-viewport');
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
      container.style.setProperty('--remote-selection-color', peer.color);
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
      if (cursorThrottleTimer !== null) {
        window.clearTimeout(cursorThrottleTimer);
      }
      eventBus.off('commandStack.changed', onCommandStackChanged);
      eventBus.off('selection.changed', onSelectionChanged);
      eventBus.off('canvas.viewbox.changed', repositionRemoteCursors);
      container.removeEventListener('mousemove', onCanvasMouseMove);
      container.removeEventListener('mouseleave', onCanvasMouseLeave);
      socket.off('diagram:state', onDiagramState);
      socket.off('presence:state', onPresenceState);
      socket.off('cursor:state', onCursorState);
      for (const clientId of [...remoteCursors.keys()]) {
        removeRemoteCursor(clientId);
      }
      cursorLayer.remove();
    },
    applySnapshot,
    loadImportedDiagram,
    flush: pushLocalXml,
    getRevision: () => revision,
  };
}

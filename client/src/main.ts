import BpmnModeler from 'bpmn-js/lib/Modeler';
import camundaModdle from 'camunda-bpmn-moddle/resources/camunda.json';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';

import {
  applyElementColor,
  cloneLegend,
  downloadBlob,
  exportPng,
  exportSvg,
} from './diagram-tools';
import { attachCollaboration, type CollaborationHandle } from './editor';
import {
  attachPropertiesPanel,
  type PropertiesPanelHandle,
} from './properties-panel';
import {
  clearActiveSession,
  createSocket,
  emitWithAck,
  getOrCreateClientId,
  listSavedRooms,
  loadActiveSession,
  loadRoomDiagram,
  saveActiveSession,
  saveRoomDiagram,
  saveRoomLegend,
  touchSavedRoomName,
} from './socket';
import type {
  DiagramUpdateResult,
  LegendEntry,
  ParticipantPublic,
  RoomCreateResult,
  RoomJoinResult,
  RoomSnapshot,
} from './types';
import { DEFAULT_LEGEND } from './types';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('#app root missing');
}

const clientId = getOrCreateClientId();
const socket = createSocket();
let collaboration: CollaborationHandle | null = null;
let propertiesPanel: PropertiesPanelHandle | null = null;
let modeler: BpmnModeler | null = null;
let activeRoomId: string | null = null;
let activeName: string | null = null;
let inEditor = false;
let rejoining = false;
let currentLegend: LegendEntry[] = cloneLegend(DEFAULT_LEGEND);
let legendOutsideClickHandler: ((event: MouseEvent) => void) | null = null;

const params = new URLSearchParams(window.location.search);
const prefilledRoom = (params.get('room') ?? '').toUpperCase();

socket.on('connect', () => {
  void handleSocketConnected();
});

renderLobby(prefilledRoom);

async function joinRoom(roomId: string, name: string): Promise<RoomJoinResult> {
  const local = loadRoomDiagram(roomId);
  return emitWithAck<RoomJoinResult>((cb) =>
    socket.emit(
      'room:join',
      {
        roomId,
        name,
        clientId,
        restoreXml: local?.xml,
        restoreRevision: local?.revision,
        restoreLegend: local?.legend,
      },
      cb
    )
  );
}

async function reconcileWithLocalStorage(
  snapshot: RoomSnapshot,
  name: string
): Promise<RoomSnapshot> {
  const local = loadRoomDiagram(snapshot.roomId);
  touchSavedRoomName(snapshot.roomId, name);

  if (!local) {
    saveRoomDiagram(
      snapshot.roomId,
      snapshot.xml,
      snapshot.revision,
      name,
      snapshot.legend
    );
    return snapshot;
  }

  if (local.revision > snapshot.revision) {
    const restored = await emitWithAck<DiagramUpdateResult>((cb) =>
      socket.emit(
        'diagram:restore',
        {
          roomId: snapshot.roomId,
          xml: local.xml,
          revision: local.revision,
          source: 'restore',
        },
        cb
      )
    );
    if (restored.ok) {
      const legend = local.legend ?? snapshot.legend;
      saveRoomDiagram(
        snapshot.roomId,
        local.xml,
        restored.revision,
        name,
        legend
      );
      if (legend) {
        socket.emit('legend:update', {
          roomId: snapshot.roomId,
          legend,
        });
      }
      return {
        ...snapshot,
        xml: local.xml,
        revision: restored.revision,
        legend: legend ?? snapshot.legend,
      };
    }
  }

  saveRoomDiagram(
    snapshot.roomId,
    snapshot.xml,
    snapshot.revision,
    name,
    snapshot.legend
  );
  return snapshot;
}

async function handleSocketConnected(): Promise<void> {
  if (!inEditor || !activeRoomId || !activeName || rejoining) {
    return;
  }

  rejoining = true;
  try {
    const result = await joinRoom(activeRoomId, activeName);
    if (!result.ok) {
      showEditorBanner(result.error);
      clearActiveSession();
      activeRoomId = null;
      activeName = null;
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('room');
      window.history.replaceState({}, '', cleanUrl);
      renderLobby();
      return;
    }

    const reconciled = await reconcileWithLocalStorage(result.snapshot, activeName);
    await collaboration?.applySnapshot(reconciled);
    await collaboration?.flush();
  } catch (error) {
    showEditorBanner(
      error instanceof Error ? error.message : 'Falha ao reconectar à sala.'
    );
  } finally {
    rejoining = false;
  }
}

function renderLobby(initialRoomId = ''): void {
  disposeSession();
  inEditor = false;
  activeRoomId = null;
  activeName = null;

  const savedRooms = listSavedRooms().slice(0, 5);
  const recentHtml =
    savedRooms.length === 0
      ? ''
      : `
      <div class="recent-rooms">
        <p class="recent-title">Salas salvas neste navegador</p>
        <ul>
          ${savedRooms
            .map(
              (room) => `
            <li>
              <button type="button" class="recent-room-btn" data-room="${escapeAttr(room.roomId)}">
                <span class="recent-code">${escapeHtml(room.roomId)}</span>
                <span class="recent-meta">rev ${room.revision}</span>
              </button>
            </li>
          `
            )
            .join('')}
        </ul>
      </div>
    `;

  app!.innerHTML = `
    <main class="lobby">
      <div class="lobby-card">
        <h1>BPMN compartilhado</h1>
        <p class="subtitle">Até 5 usuários editam o mesmo diagrama em tempo real. O desenho fica salvo neste navegador e na nuvem quando configurado.</p>
        <label class="field">
          <span>Seu nome</span>
          <input id="name-input" type="text" maxlength="32" placeholder="Ex.: Ana" autocomplete="nickname" />
        </label>
        <div class="actions">
          <button id="create-btn" type="button" class="primary">Criar sessão</button>
        </div>
        <div class="divider"><span>ou entrar</span></div>
        <label class="field">
          <span>Código da sala</span>
          <input id="room-input" type="text" maxlength="8" placeholder="ABC123" value="${escapeAttr(initialRoomId)}" autocomplete="off" />
        </label>
        <div class="actions">
          <button id="join-btn" type="button">Entrar na sessão</button>
        </div>
        ${recentHtml}
        <p id="lobby-error" class="error" hidden></p>
        <p id="lobby-status" class="status">Conectando…</p>
      </div>
    </main>
  `;

  const nameInput = document.querySelector<HTMLInputElement>('#name-input')!;
  const roomInput = document.querySelector<HTMLInputElement>('#room-input')!;
  const createBtn = document.querySelector<HTMLButtonElement>('#create-btn')!;
  const joinBtn = document.querySelector<HTMLButtonElement>('#join-btn')!;
  const errorEl = document.querySelector<HTMLParagraphElement>('#lobby-error')!;
  const statusEl = document.querySelector<HTMLParagraphElement>('#lobby-status')!;

  const storedName = localStorage.getItem('bpmn-display-name') ?? '';
  if (storedName) {
    nameInput.value = storedName;
  }

  const updateStatus = () => {
    statusEl.textContent = socket.connected
      ? 'Conectado ao servidor.'
      : 'Conectando ao servidor…';
  };
  updateStatus();
  socket.off('connect', updateStatus);
  socket.off('disconnect', updateStatus);
  socket.on('connect', updateStatus);
  socket.on('disconnect', updateStatus);

  createBtn.addEventListener('click', async () => {
    errorEl.hidden = true;
    const name = nameInput.value.trim();
    localStorage.setItem('bpmn-display-name', name);
    setBusy(true);
    try {
      const result = await emitWithAck<RoomCreateResult>((cb) =>
        socket.emit('room:create', { name, clientId }, cb)
      );
      if (!result.ok) {
        showError(result.error);
        return;
      }
      await openEditor(result.snapshot, name);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Falha ao criar sessão.');
    } finally {
      setBusy(false);
    }
  });

  const doJoin = async (roomId: string) => {
    errorEl.hidden = true;
    const name = nameInput.value.trim();
    localStorage.setItem('bpmn-display-name', name);
    if (!roomId) {
      showError('Informe o código da sala.');
      return;
    }
    setBusy(true);
    try {
      const result = await joinRoom(roomId, name);
      if (!result.ok) {
        showError(result.error);
        return;
      }
      await openEditor(result.snapshot, name);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Falha ao entrar na sessão.');
    } finally {
      setBusy(false);
    }
  };

  joinBtn.addEventListener('click', () => {
    void doJoin(roomInput.value.trim().toUpperCase());
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>('.recent-room-btn')) {
    btn.addEventListener('click', () => {
      const roomId = btn.dataset.room ?? '';
      roomInput.value = roomId;
      void doJoin(roomId);
    });
  }

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function setBusy(busy: boolean): void {
    createBtn.disabled = busy;
    joinBtn.disabled = busy;
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.recent-room-btn')) {
      btn.disabled = busy;
    }
  }

  const pending = loadActiveSession();
  const resumeRoom =
    initialRoomId ||
    (pending && !initialRoomId ? pending.roomId : '') ||
    '';
  if (pending && resumeRoom && pending.roomId === resumeRoom) {
    nameInput.value = pending.name || nameInput.value;
    void doJoin(pending.roomId);
  } else if (initialRoomId && loadRoomDiagram(initialRoomId)) {
    void doJoin(initialRoomId);
  }
}

async function openEditor(snapshot: RoomSnapshot, name: string): Promise<void> {
  disposeSession();
  inEditor = true;
  activeRoomId = snapshot.roomId;
  activeName = name;
  saveActiveSession(snapshot.roomId, name);

  const reconciled = await reconcileWithLocalStorage(snapshot, name);
  currentLegend = cloneLegend(reconciled.legend);

  const url = new URL(window.location.href);
  url.searchParams.set('room', reconciled.roomId);
  window.history.replaceState({}, '', url);

  app!.innerHTML = `
    <div class="editor-shell">
      <header class="toolbar">
        <div class="toolbar-left">
          <strong class="brand">BPMN compartilhado</strong>
          <span class="room-code" title="Código da sala">${escapeHtml(reconciled.roomId)}</span>
          <button id="copy-link-btn" type="button" class="ghost">Copiar link</button>
        </div>
        <div id="participants" class="participants"></div>
        <div class="toolbar-right">
          <div class="color-palette" id="color-palette" title="Cor do elemento selecionado"></div>
          <button id="legend-btn" type="button" class="ghost">Legenda</button>
          <span id="conn-status" class="pill">Online</span>
          <span id="revision" class="pill muted">rev ${reconciled.revision}</span>
          <button id="import-btn" type="button">Importar .bpmn</button>
          <div class="export-group">
            <button id="download-bpmn-btn" type="button">BPMN</button>
            <button id="download-svg-btn" type="button">SVG</button>
            <button id="download-png-btn" type="button">PNG</button>
          </div>
          <button id="leave-btn" type="button" class="ghost">Sair</button>
          <input id="import-input" type="file" accept=".bpmn,.xml,application/xml,text/xml" hidden />
        </div>
      </header>
      <p id="banner" class="banner" hidden></p>
      <div class="editor-body">
        <div id="canvas" class="canvas"></div>
        <aside id="properties" class="properties-aside"></aside>
      </div>
      <div id="legend-popover" class="legend-popover" hidden></div>
    </div>
  `;

  const canvasEl = document.querySelector<HTMLDivElement>('#canvas')!;
  const propertiesEl = document.querySelector<HTMLElement>('#properties')!;
  const participantsEl = document.querySelector<HTMLDivElement>('#participants')!;
  const revisionEl = document.querySelector<HTMLSpanElement>('#revision')!;
  const connStatusEl = document.querySelector<HTMLSpanElement>('#conn-status')!;
  const bannerEl = document.querySelector<HTMLParagraphElement>('#banner')!;
  const colorPaletteEl = document.querySelector<HTMLDivElement>('#color-palette')!;
  const legendBtn = document.querySelector<HTMLButtonElement>('#legend-btn')!;
  const legendPopover = document.querySelector<HTMLDivElement>('#legend-popover')!;
  const copyLinkBtn = document.querySelector<HTMLButtonElement>('#copy-link-btn')!;
  const importBtn = document.querySelector<HTMLButtonElement>('#import-btn')!;
  const importInput = document.querySelector<HTMLInputElement>('#import-input')!;
  const downloadBpmnBtn = document.querySelector<HTMLButtonElement>('#download-bpmn-btn')!;
  const downloadSvgBtn = document.querySelector<HTMLButtonElement>('#download-svg-btn')!;
  const downloadPngBtn = document.querySelector<HTMLButtonElement>('#download-png-btn')!;
  const leaveBtn = document.querySelector<HTMLButtonElement>('#leave-btn')!;

  modeler = new BpmnModeler({
    container: canvasEl,
    moddleExtensions: {
      camunda: camundaModdle,
    },
  });
  (window as unknown as { __bpmnModeler?: BpmnModeler }).__bpmnModeler = modeler;

  try {
    await modeler.importXML(reconciled.xml);
    const canvas = modeler.get('canvas') as {
      zoom: (mode: string) => void;
      resized: () => void;
    };
    canvas.resized();
    canvas.zoom('fit-viewport');
  } catch (error) {
    console.error(error);
    showBanner('Não foi possível carregar o diagrama inicial.');
  }

  propertiesPanel = attachPropertiesPanel(modeler, propertiesEl);
  renderColorPalette(colorPaletteEl);
  renderLegendPopover(legendPopover, currentLegend);

  renderParticipants(participantsEl, reconciled.participants, clientId);

  collaboration = attachCollaboration({
    modeler,
    socket,
    roomId: reconciled.roomId,
    initialRevision: reconciled.revision,
    initialLegend: currentLegend,
    localClientId: clientId,
    onRevision: (revision) => {
      revisionEl.textContent = `rev ${revision}`;
    },
    onConflict: (message) => {
      showBanner(message);
    },
    onParticipants: (participants) => {
      renderParticipants(participantsEl, participants, clientId);
    },
    onImportOverwrite: () => {
      showBanner('Alguém importou um arquivo e substituiu o diagrama.');
    },
    onLegend: (legend) => {
      currentLegend = cloneLegend(legend);
      renderColorPalette(colorPaletteEl);
      renderLegendPopover(legendPopover, currentLegend);
    },
  });

  const updateConn = () => {
    connStatusEl.textContent = socket.connected ? 'Online' : 'Reconectando…';
    connStatusEl.classList.toggle('warn', !socket.connected);
  };
  updateConn();
  socket.off('connect', updateConn);
  socket.off('disconnect', updateConn);
  socket.on('connect', updateConn);
  socket.on('disconnect', updateConn);

  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showBanner('Link copiado.');
    } catch {
      showBanner(window.location.href);
    }
  });

  legendBtn.addEventListener('click', () => {
    legendPopover.hidden = !legendPopover.hidden;
  });

  if (legendOutsideClickHandler) {
    document.removeEventListener('click', legendOutsideClickHandler);
  }
  legendOutsideClickHandler = (event: MouseEvent) => {
    const target = event.target as Node;
    if (
      !legendPopover.hidden &&
      !legendPopover.contains(target) &&
      target !== legendBtn
    ) {
      legendPopover.hidden = true;
    }
  };
  document.addEventListener('click', legendOutsideClickHandler);

  importBtn.addEventListener('click', () => {
    importInput.value = '';
    importInput.click();
  });

  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (!file) {
      return;
    }
    void importBpmnFile(file);
  });

  downloadBpmnBtn.addEventListener('click', async () => {
    if (!modeler) {
      return;
    }
    try {
      const { xml } = await modeler.saveXML({ format: true });
      if (!xml) {
        return;
      }
      downloadBlob(
        new Blob([xml], { type: 'application/xml' }),
        `diagrama-${reconciled.roomId}.bpmn`
      );
    } catch (error) {
      console.error(error);
      showBanner('Falha ao exportar o diagrama.');
    }
  });

  downloadSvgBtn.addEventListener('click', async () => {
    if (!modeler) {
      return;
    }
    try {
      await exportSvg(modeler, `diagrama-${reconciled.roomId}.svg`);
    } catch (error) {
      console.error(error);
      showBanner('Falha ao exportar SVG.');
    }
  });

  downloadPngBtn.addEventListener('click', async () => {
    if (!modeler) {
      return;
    }
    try {
      await exportPng(modeler, `diagrama-${reconciled.roomId}.png`);
    } catch (error) {
      console.error(error);
      showBanner('Falha ao exportar PNG.');
    }
  });

  leaveBtn.addEventListener('click', async () => {
    const roomId = activeRoomId;
    if (modeler && roomId) {
      try {
        const { xml } = await modeler.saveXML({ format: true });
        if (xml) {
          saveRoomDiagram(
            roomId,
            xml,
            collaboration?.getRevision() ?? 0,
            activeName ?? undefined,
            collaboration?.getLegend()
          );
        }
      } catch {
        // ignore save errors on leave
      }
      socket.emit('room:leave', { roomId, clientId });
    }
    clearActiveSession();
    activeRoomId = null;
    activeName = null;
    inEditor = false;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('room');
    window.history.replaceState({}, '', cleanUrl);
    renderLobby();
  });

  function renderColorPalette(container: HTMLElement): void {
    container.innerHTML = currentLegend
      .map(
        (entry, index) => `
        <button
          type="button"
          class="color-swatch"
          data-index="${index}"
          title="${escapeAttr(entry.label)}"
          style="--swatch:${escapeAttr(entry.fill)};--swatch-stroke:${escapeAttr(entry.stroke ?? entry.fill)}"
          aria-label="${escapeAttr(entry.label)}"
        ></button>
      `
      )
      .join('');

    for (const btn of container.querySelectorAll<HTMLButtonElement>('.color-swatch')) {
      btn.addEventListener('click', () => {
        if (!modeler) {
          return;
        }
        const index = Number(btn.dataset.index);
        const entry = currentLegend[index];
        if (!entry) {
          return;
        }
        const applied = applyElementColor(modeler, entry.fill, entry.stroke);
        if (!applied) {
          showBanner('Selecione um elemento para colorir.');
        }
      });
    }
  }

  function renderLegendPopover(
    container: HTMLElement,
    legend: LegendEntry[]
  ): void {
    container.innerHTML = `
      <p class="legend-title">Legenda das cores</p>
      <ul class="legend-list">
        ${legend
          .map(
            (entry, index) => `
          <li class="legend-item">
            <span class="legend-swatch" style="background:${escapeAttr(entry.fill)};border-color:${escapeAttr(entry.stroke ?? '#94a3b8')}"></span>
            <input
              type="text"
              class="legend-label-input"
              data-index="${index}"
              maxlength="64"
              value="${escapeAttr(entry.label)}"
            />
          </li>
        `
          )
          .join('')}
      </ul>
    `;

    for (const input of container.querySelectorAll<HTMLInputElement>(
      '.legend-label-input'
    )) {
      input.addEventListener('change', () => {
        const index = Number(input.dataset.index);
        if (!Number.isFinite(index) || !currentLegend[index]) {
          return;
        }
        currentLegend = currentLegend.map((entry, i) =>
          i === index ? { ...entry, label: input.value.trim() || entry.label } : entry
        );
        saveRoomLegend(reconciled.roomId, currentLegend);
        collaboration?.setLegend(currentLegend);
        renderColorPalette(colorPaletteEl);
      });
    }
  }

  async function importBpmnFile(file: File): Promise<void> {
    if (!modeler || !activeRoomId) {
      return;
    }

    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.bpmn') && !lower.endsWith('.xml')) {
      showBanner('Selecione um arquivo .bpmn ou .xml.');
      return;
    }

    const currentRevision = collaboration?.getRevision() ?? 0;
    if (currentRevision > 0) {
      const confirmed = window.confirm(
        'Importar este arquivo substitui o diagrama atual para todos na sala. Continuar?'
      );
      if (!confirmed) {
        return;
      }
    }

    let xml: string;
    try {
      xml = await file.text();
    } catch {
      showBanner('Não foi possível ler o arquivo.');
      return;
    }

    if (!xml.trim() || !xml.includes('definitions')) {
      showBanner('Arquivo BPMN inválido.');
      return;
    }

    try {
      await modeler.importXML(xml);
    } catch (error) {
      console.error(error);
      showBanner('Falha ao importar o diagrama BPMN.');
      return;
    }

    const suggestedRevision = (collaboration?.getRevision() ?? 0) + 1;
    try {
      const restored = await emitWithAck<DiagramUpdateResult>((cb) =>
        socket.emit(
          'diagram:restore',
          {
            roomId: activeRoomId!,
            xml,
            revision: suggestedRevision,
            source: 'import',
          },
          cb
        )
      );

      if (!restored.ok) {
        showBanner(restored.error || 'Falha ao sincronizar o diagrama importado.');
        return;
      }

      saveRoomDiagram(
        activeRoomId,
        xml,
        restored.revision,
        activeName ?? undefined,
        currentLegend
      );

      await collaboration?.loadImportedDiagram(xml, restored.revision);
      revisionEl.textContent = `rev ${restored.revision}`;
      showBanner(`Diagrama importado: ${file.name}`);
    } catch (error) {
      console.error(error);
      showBanner(
        error instanceof Error
          ? error.message
          : 'Falha ao sincronizar o diagrama importado.'
      );
    }
  }

  function showBanner(message: string): void {
    bannerEl.textContent = message;
    bannerEl.hidden = false;
    window.setTimeout(() => {
      bannerEl.hidden = true;
    }, 3200);
  }
}

function showEditorBanner(message: string): void {
  const bannerEl = document.querySelector<HTMLParagraphElement>('#banner');
  if (!bannerEl) {
    return;
  }
  bannerEl.textContent = message;
  bannerEl.hidden = false;
}

function renderParticipants(
  container: HTMLElement,
  participants: ParticipantPublic[],
  localId: string
): void {
  container.innerHTML = participants
    .map((participant) => {
      const you = participant.id === localId ? ' (você)' : '';
      return `
        <span class="participant" style="--dot:${participant.color}">
          <span class="dot"></span>
          ${escapeHtml(participant.name)}${you}
        </span>
      `;
    })
    .join('');
}

function disposeSession(): void {
  if (legendOutsideClickHandler) {
    document.removeEventListener('click', legendOutsideClickHandler);
    legendOutsideClickHandler = null;
  }
  propertiesPanel?.dispose();
  propertiesPanel = null;
  collaboration?.dispose();
  collaboration = null;
  if (modeler) {
    modeler.destroy();
    modeler = null;
  }
  delete (window as unknown as { __bpmnModeler?: BpmnModeler }).__bpmnModeler;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

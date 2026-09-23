import BpmnModeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';

import { attachCollaboration } from './editor';
import { createSocket, emitWithAck } from './socket';
import type { ParticipantPublic, RoomSnapshot } from './types';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('#app root missing');
}

const socket = createSocket();
let disposeCollaboration: (() => void) | null = null;
let modeler: BpmnModeler | null = null;

const params = new URLSearchParams(window.location.search);
const prefilledRoom = (params.get('room') ?? '').toUpperCase();

renderLobby(prefilledRoom);

function renderLobby(initialRoomId = ''): void {
  disposeSession();
  app!.innerHTML = `
    <main class="lobby">
      <div class="lobby-card">
        <h1>BPMN compartilhado</h1>
        <p class="subtitle">Dois usuários editam o mesmo diagrama em tempo real.</p>
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
  socket.on('connect', updateStatus);
  socket.on('disconnect', updateStatus);

  createBtn.addEventListener('click', async () => {
    errorEl.hidden = true;
    const name = nameInput.value.trim();
    localStorage.setItem('bpmn-display-name', name);
    setBusy(true);
    try {
      const result = await emitWithAck<
        import('./types').RoomCreateResult
      >((cb) => socket.emit('room:create', { name }, cb));
      if (!result.ok) {
        showError(result.error);
        return;
      }
      await openEditor(result.snapshot);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Falha ao criar sessão.');
    } finally {
      setBusy(false);
    }
  });

  joinBtn.addEventListener('click', async () => {
    errorEl.hidden = true;
    const name = nameInput.value.trim();
    const roomId = roomInput.value.trim().toUpperCase();
    localStorage.setItem('bpmn-display-name', name);
    if (!roomId) {
      showError('Informe o código da sala.');
      return;
    }
    setBusy(true);
    try {
      const result = await emitWithAck<import('./types').RoomJoinResult>((cb) =>
        socket.emit('room:join', { roomId, name }, cb)
      );
      if (!result.ok) {
        showError(result.error);
        return;
      }
      await openEditor(result.snapshot);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Falha ao entrar na sessão.');
    } finally {
      setBusy(false);
    }
  });

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function setBusy(busy: boolean): void {
    createBtn.disabled = busy;
    joinBtn.disabled = busy;
  }
}

async function openEditor(snapshot: RoomSnapshot): Promise<void> {
  const url = new URL(window.location.href);
  url.searchParams.set('room', snapshot.roomId);
  window.history.replaceState({}, '', url);

  app!.innerHTML = `
    <div class="editor-shell">
      <header class="toolbar">
        <div class="toolbar-left">
          <strong class="brand">BPMN compartilhado</strong>
          <span class="room-code" title="Código da sala">${escapeHtml(snapshot.roomId)}</span>
          <button id="copy-link-btn" type="button" class="ghost">Copiar link</button>
        </div>
        <div id="participants" class="participants"></div>
        <div class="toolbar-right">
          <span id="conn-status" class="pill">Online</span>
          <span id="revision" class="pill muted">rev ${snapshot.revision}</span>
          <button id="download-btn" type="button">Baixar .bpmn</button>
          <button id="leave-btn" type="button" class="ghost">Sair</button>
        </div>
      </header>
      <p id="banner" class="banner" hidden></p>
      <div id="canvas" class="canvas"></div>
    </div>
  `;

  const canvasEl = document.querySelector<HTMLDivElement>('#canvas')!;
  const participantsEl = document.querySelector<HTMLDivElement>('#participants')!;
  const revisionEl = document.querySelector<HTMLSpanElement>('#revision')!;
  const connStatusEl = document.querySelector<HTMLSpanElement>('#conn-status')!;
  const bannerEl = document.querySelector<HTMLParagraphElement>('#banner')!;
  const copyLinkBtn = document.querySelector<HTMLButtonElement>('#copy-link-btn')!;
  const downloadBtn = document.querySelector<HTMLButtonElement>('#download-btn')!;
  const leaveBtn = document.querySelector<HTMLButtonElement>('#leave-btn')!;

  modeler = new BpmnModeler({ container: canvasEl });
  (window as unknown as { __bpmnModeler?: BpmnModeler }).__bpmnModeler = modeler;

  try {
    await modeler.importXML(snapshot.xml);
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

  renderParticipants(participantsEl, snapshot.participants, socket.id ?? '');

  disposeCollaboration = attachCollaboration({
    modeler,
    socket,
    roomId: snapshot.roomId,
    initialRevision: snapshot.revision,
    localSocketId: socket.id ?? '',
    onRevision: (revision) => {
      revisionEl.textContent = `rev ${revision}`;
    },
    onConflict: (message) => {
      showBanner(message);
    },
    onParticipants: (participants) => {
      renderParticipants(participantsEl, participants, socket.id ?? '');
    },
  });

  const updateConn = () => {
    connStatusEl.textContent = socket.connected ? 'Online' : 'Reconectando…';
    connStatusEl.classList.toggle('warn', !socket.connected);
  };
  updateConn();
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

  downloadBtn.addEventListener('click', async () => {
    if (!modeler) {
      return;
    }
    try {
      const { xml } = await modeler.saveXML({ format: true });
      if (!xml) {
        return;
      }
      const blob = new Blob([xml], { type: 'application/xml' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `diagrama-${snapshot.roomId}.bpmn`;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      console.error(error);
      showBanner('Falha ao exportar o diagrama.');
    }
  });

  leaveBtn.addEventListener('click', () => {
    socket.disconnect();
    socket.connect();
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('room');
    window.history.replaceState({}, '', cleanUrl);
    renderLobby();
  });

  function showBanner(message: string): void {
    bannerEl.textContent = message;
    bannerEl.hidden = false;
    window.setTimeout(() => {
      bannerEl.hidden = true;
    }, 3200);
  }
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
  disposeCollaboration?.();
  disposeCollaboration = null;
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

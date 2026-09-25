import type BpmnModeler from 'bpmn-js/lib/Modeler';

interface ModdleElement {
  $type?: string;
  text?: string;
  get?: (name: string) => unknown;
  set?: (name: string, value: unknown) => void;
}

interface DiagramElement {
  id: string;
  type?: string;
  businessObject?: ModdleElement & {
    name?: string;
    documentation?: ModdleElement[];
    assignee?: string;
    $attrs?: Record<string, string>;
  };
}

const TASK_TYPES = new Set([
  'bpmn:Task',
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ManualTask',
  'bpmn:ScriptTask',
  'bpmn:BusinessRuleTask',
  'bpmn:SendTask',
  'bpmn:ReceiveTask',
]);

export interface PropertiesPanelHandle {
  dispose: () => void;
}

export function attachPropertiesPanel(
  modeler: BpmnModeler,
  container: HTMLElement
): PropertiesPanelHandle {
  const eventBus = modeler.get('eventBus') as {
    on: (event: string, handler: (e: unknown) => void) => void;
    off: (event: string, handler: (e: unknown) => void) => void;
  };
  const selection = modeler.get('selection') as {
    get: () => DiagramElement[];
  };
  const modeling = modeler.get('modeling') as {
    updateProperties: (element: DiagramElement, props: Record<string, unknown>) => void;
  };
  const moddle = modeler.get('moddle') as {
    create: (type: string, props?: Record<string, unknown>) => ModdleElement;
  };

  let current: DiagramElement | null = null;
  let suppress = false;

  container.innerHTML = `
    <div class="props-panel">
      <h2 class="props-title">Propriedades</h2>
      <p class="props-empty" id="props-empty">Selecione um elemento</p>
      <div class="props-fields" id="props-fields" hidden>
        <label class="props-field">
          <span>Nome</span>
          <input id="props-name" type="text" maxlength="120" />
        </label>
        <label class="props-field">
          <span>Documentação</span>
          <textarea id="props-docs" rows="4" maxlength="2000"></textarea>
        </label>
        <label class="props-field" id="props-assignee-wrap" hidden>
          <span>Responsável</span>
          <input id="props-assignee" type="text" maxlength="120" placeholder="Ex.: ana@empresa.com" />
        </label>
      </div>
    </div>
  `;

  const emptyEl = container.querySelector<HTMLElement>('#props-empty')!;
  const fieldsEl = container.querySelector<HTMLElement>('#props-fields')!;
  const nameInput = container.querySelector<HTMLInputElement>('#props-name')!;
  const docsInput = container.querySelector<HTMLTextAreaElement>('#props-docs')!;
  const assigneeWrap = container.querySelector<HTMLElement>('#props-assignee-wrap')!;
  const assigneeInput = container.querySelector<HTMLInputElement>('#props-assignee')!;

  const onSelectionChanged = () => {
    const selected = selection.get()[0] ?? null;
    current = selected && isEditable(selected) ? selected : null;
    render();
  };

  const onNameInput = () => {
    if (!current || suppress) {
      return;
    }
    modeling.updateProperties(current, { name: nameInput.value });
  };

  const onDocsInput = () => {
    if (!current || suppress) {
      return;
    }
    const documentation = [
      moddle.create('bpmn:Documentation', { text: docsInput.value }),
    ];
    modeling.updateProperties(current, { documentation });
  };

  const onAssigneeInput = () => {
    if (!current || suppress) {
      return;
    }
    modeling.updateProperties(current, {
      'camunda:assignee': assigneeInput.value || undefined,
    });
  };

  nameInput.addEventListener('input', onNameInput);
  docsInput.addEventListener('input', onDocsInput);
  assigneeInput.addEventListener('input', onAssigneeInput);
  eventBus.on('selection.changed', onSelectionChanged);
  eventBus.on('commandStack.changed', onSelectionChanged);
  onSelectionChanged();

  function isEditable(element: DiagramElement): boolean {
    const type = element.type ?? '';
    return Boolean(type) && !type.includes('Label') && type !== 'bpmn:Process';
  }

  function isTask(element: DiagramElement): boolean {
    return TASK_TYPES.has(element.type ?? '');
  }

  function readDocumentation(element: DiagramElement): string {
    const docs = element.businessObject?.documentation;
    if (!Array.isArray(docs) || docs.length === 0) {
      return '';
    }
    return docs.map((doc) => doc.text ?? '').join('\n');
  }

  function readAssignee(element: DiagramElement): string {
    const bo = element.businessObject;
    if (!bo) {
      return '';
    }
    if (typeof bo.assignee === 'string') {
      return bo.assignee;
    }
    const attrs = bo.$attrs;
    if (attrs && typeof attrs['camunda:assignee'] === 'string') {
      return attrs['camunda:assignee'];
    }
    const getter = bo.get?.('camunda:assignee');
    return typeof getter === 'string' ? getter : '';
  }

  function render(): void {
    suppress = true;
    if (!current) {
      emptyEl.hidden = false;
      fieldsEl.hidden = true;
      suppress = false;
      return;
    }

    emptyEl.hidden = true;
    fieldsEl.hidden = false;
    nameInput.value = current.businessObject?.name ?? '';
    docsInput.value = readDocumentation(current);

    const showAssignee = isTask(current);
    assigneeWrap.hidden = !showAssignee;
    assigneeInput.value = showAssignee ? readAssignee(current) : '';
    suppress = false;
  }

  return {
    dispose: () => {
      eventBus.off('selection.changed', onSelectionChanged);
      eventBus.off('commandStack.changed', onSelectionChanged);
      nameInput.removeEventListener('input', onNameInput);
      docsInput.removeEventListener('input', onDocsInput);
      assigneeInput.removeEventListener('input', onAssigneeInput);
      container.innerHTML = '';
    },
  };
}

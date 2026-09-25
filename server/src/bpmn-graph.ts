import { BpmnModdle } from 'bpmn-moddle';
import camundaModdle from 'camunda-bpmn-moddle/resources/camunda.json' with {
  type: 'json',
};

export const MAX_OPERATIONS_PER_REQUEST = 20;
export const MAX_XML_CHARS = 1_500_000;
export const AGENT_CLIENT_ID = 'agent';

export interface GraphElement {
  id: string;
  type: string;
  name: string | null;
  documentation: string | null;
  assignee: string | null;
  incoming: string[];
  outgoing: string[];
  fill: string | null;
  stroke: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}

export interface GraphFlow {
  id: string;
  type: string;
  name: string | null;
  sourceRef: string | null;
  targetRef: string | null;
}

export interface ProcessGraph {
  processId: string | null;
  elements: GraphElement[];
  flows: GraphFlow[];
}

export type GraphOperation =
  | { op: 'add_task'; name: string; afterElementId?: string; x?: number; y?: number }
  | {
      op: 'add_gateway';
      gatewayType: 'exclusive' | 'parallel';
      name?: string;
      afterElementId?: string;
      x?: number;
      y?: number;
    }
  | { op: 'connect'; sourceId: string; targetId: string; name?: string }
  | { op: 'rename_element'; elementId: string; name: string }
  | { op: 'set_documentation'; elementId: string; documentation: string }
  | { op: 'set_assignee'; elementId: string; assignee: string }
  | { op: 'set_color'; elementId: string; fill: string; stroke?: string }
  | { op: 'delete_elements'; elementIds: string[] };

type ModdleElement = {
  $type: string;
  id?: string;
  name?: string;
  documentation?: Array<{ text?: string }>;
  incoming?: ModdleElement[];
  outgoing?: ModdleElement[];
  sourceRef?: ModdleElement | string;
  targetRef?: ModdleElement | string;
  flowElements?: ModdleElement[];
  rootElements?: ModdleElement[];
  diagramElements?: ModdleElement[];
  planeElement?: ModdleElement[];
  bpmnElement?: ModdleElement | string;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  waypoint?: Array<{ x?: number; y?: number }>;
  get?: (name: string) => unknown;
  set?: (name: string, value: unknown) => void;
  $attrs?: Record<string, string>;
};

type Definitions = ModdleElement & {
  rootElements?: ModdleElement[];
  diagrams?: ModdleElement[];
};

function createModdle(): BpmnModdle {
  return new BpmnModdle({ camunda: camundaModdle });
}

async function fromXml(xml: string): Promise<{
  moddle: BpmnModdle;
  definitions: Definitions;
}> {
  if (xml.length > MAX_XML_CHARS) {
    throw new Error(`XML exceeds ${MAX_XML_CHARS} characters.`);
  }
  const moddle = createModdle();
  const { rootElement } = (await moddle.fromXML(xml)) as {
    rootElement: Definitions;
  };
  return { moddle, definitions: rootElement };
}

async function toXml(moddle: BpmnModdle, definitions: Definitions): Promise<string> {
  const { xml } = await moddle.toXML(definitions, { format: true });
  return xml;
}

function getProcess(definitions: Definitions): ModdleElement {
  const process = (definitions.rootElements ?? []).find(
    (el) => el.$type === 'bpmn:Process'
  );
  if (!process) {
    throw new Error('No bpmn:Process found in diagram.');
  }
  if (!process.flowElements) {
    process.flowElements = [];
  }
  return process;
}

function getPlane(definitions: Definitions): ModdleElement {
  const diagram = (definitions.diagrams ?? [])[0];
  if (!diagram) {
    throw new Error('No BPMNDiagram found.');
  }
  const plane = (diagram as { plane?: ModdleElement }).plane;
  if (!plane) {
    throw new Error('No BPMNPlane found.');
  }
  if (!plane.planeElement) {
    plane.planeElement = [];
  }
  return plane;
}

function findFlowElement(
  process: ModdleElement,
  elementId: string
): ModdleElement | undefined {
  return (process.flowElements ?? []).find((el) => el.id === elementId);
}

function refId(ref: ModdleElement | string | undefined | null): string | null {
  if (!ref) {
    return null;
  }
  if (typeof ref === 'string') {
    return ref;
  }
  return ref.id ?? null;
}

function documentationText(el: ModdleElement): string | null {
  const docs = el.documentation;
  if (!Array.isArray(docs) || docs.length === 0) {
    return null;
  }
  const text = docs.map((d) => d.text ?? '').join('\n').trim();
  return text || null;
}

function assigneeOf(el: ModdleElement): string | null {
  const attrs = el.$attrs ?? {};
  if (typeof attrs['camunda:assignee'] === 'string') {
    return attrs['camunda:assignee'];
  }
  const viaGet = el.get?.('camunda:assignee');
  return typeof viaGet === 'string' ? viaGet : null;
}

function shapeFor(
  plane: ModdleElement,
  elementId: string
): ModdleElement | undefined {
  return (plane.planeElement ?? []).find((di) => {
    if (di.$type !== 'bpmndi:BPMNShape') {
      return false;
    }
    return refId(di.bpmnElement as ModdleElement | string) === elementId;
  });
}

function edgeFor(
  plane: ModdleElement,
  elementId: string
): ModdleElement | undefined {
  return (plane.planeElement ?? []).find((di) => {
    if (di.$type !== 'bpmndi:BPMNEdge') {
      return false;
    }
    return refId(di.bpmnElement as ModdleElement | string) === elementId;
  });
}

function colorOf(di: ModdleElement | undefined): {
  fill: string | null;
  stroke: string | null;
} {
  if (!di) {
    return { fill: null, stroke: null };
  }
  const attrs = di.$attrs ?? {};
  const fill =
    (typeof attrs['bioc:fill'] === 'string' && attrs['bioc:fill']) ||
    (typeof di.get?.('bioc:fill') === 'string'
      ? (di.get('bioc:fill') as string)
      : null);
  const stroke =
    (typeof attrs['bioc:stroke'] === 'string' && attrs['bioc:stroke']) ||
    (typeof di.get?.('bioc:stroke') === 'string'
      ? (di.get('bioc:stroke') as string)
      : null);
  return { fill, stroke };
}

function nextId(prefix: string, used: Set<string>): string {
  let i = 1;
  while (used.has(`${prefix}_${i}`)) {
    i += 1;
  }
  const id = `${prefix}_${i}`;
  used.add(id);
  return id;
}

function collectIds(process: ModdleElement, plane: ModdleElement): Set<string> {
  const used = new Set<string>();
  for (const el of process.flowElements ?? []) {
    if (el.id) {
      used.add(el.id);
    }
  }
  for (const di of plane.planeElement ?? []) {
    if (di.id) {
      used.add(di.id);
    }
  }
  return used;
}

function defaultSize(type: string): { width: number; height: number } {
  if (type.includes('Event')) {
    return { width: 36, height: 36 };
  }
  if (type.includes('Gateway')) {
    return { width: 50, height: 50 };
  }
  return { width: 100, height: 80 };
}

function positionAfter(
  plane: ModdleElement,
  afterElementId: string | undefined,
  fallbackX: number,
  fallbackY: number
): { x: number; y: number } {
  if (!afterElementId) {
    return { x: fallbackX, y: fallbackY };
  }
  const shape = shapeFor(plane, afterElementId);
  const bounds = shape?.bounds;
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
    return { x: fallbackX, y: fallbackY };
  }
  return {
    x: bounds.x + (bounds.width ?? 100) + 80,
    y: bounds.y,
  };
}

function ensureBiocNamespace(definitions: Definitions): void {
  const attrs = (definitions.$attrs ??= {});
  if (!attrs['xmlns:bioc']) {
    attrs['xmlns:bioc'] = 'http://bpmn.io/schema/bpmn/biocolor/1.0';
  }
  if (!attrs['xmlns:camunda']) {
    attrs['xmlns:camunda'] = 'http://camunda.org/schema/1.0/bpmn';
  }
}

export async function toGraph(xml: string): Promise<ProcessGraph> {
  const { definitions } = await fromXml(xml);
  const process = getProcess(definitions);
  let plane: ModdleElement | null = null;
  try {
    plane = getPlane(definitions);
  } catch {
    plane = null;
  }

  const flows: GraphFlow[] = [];
  const elements: GraphElement[] = [];

  for (const el of process.flowElements ?? []) {
    if (el.$type === 'bpmn:SequenceFlow') {
      flows.push({
        id: el.id ?? '',
        type: el.$type,
        name: el.name ?? null,
        sourceRef: refId(el.sourceRef),
        targetRef: refId(el.targetRef),
      });
      continue;
    }

    const di = plane ? shapeFor(plane, el.id ?? '') : undefined;
    const colors = colorOf(di);
    elements.push({
      id: el.id ?? '',
      type: el.$type,
      name: el.name ?? null,
      documentation: documentationText(el),
      assignee: assigneeOf(el),
      incoming: (el.incoming ?? [])
        .map((f) => f.id)
        .filter((id): id is string => Boolean(id)),
      outgoing: (el.outgoing ?? [])
        .map((f) => f.id)
        .filter((id): id is string => Boolean(id)),
      fill: colors.fill,
      stroke: colors.stroke,
      x: di?.bounds?.x ?? null,
      y: di?.bounds?.y ?? null,
      width: di?.bounds?.width ?? null,
      height: di?.bounds?.height ?? null,
    });
  }

  return {
    processId: process.id ?? null,
    elements,
    flows,
  };
}

export function summarizeGraph(graph: ProcessGraph): string {
  const lines = [
    `Process: ${graph.processId ?? '(unknown)'}`,
    `Elements (${graph.elements.length}):`,
    ...graph.elements.map((el) => {
      const name = el.name ? `"${el.name}"` : '(unnamed)';
      const assignee = el.assignee ? ` assignee=${el.assignee}` : '';
      return `- ${el.id} ${el.type} ${name}${assignee}`;
    }),
    `Flows (${graph.flows.length}):`,
    ...graph.flows.map(
      (f) =>
        `- ${f.id}: ${f.sourceRef ?? '?'} -> ${f.targetRef ?? '?'}${
          f.name ? ` "${f.name}"` : ''
        }`
    ),
  ];
  return lines.join('\n');
}

function linkSequenceFlow(
  moddle: BpmnModdle,
  process: ModdleElement,
  plane: ModdleElement,
  used: Set<string>,
  source: ModdleElement,
  target: ModdleElement,
  name?: string
): ModdleElement {
  const flowId = nextId('Flow', used);
  const flow = moddle.create('bpmn:SequenceFlow', {
    id: flowId,
    name: name || undefined,
    sourceRef: source,
    targetRef: target,
  }) as ModdleElement;

  source.outgoing = [...(source.outgoing ?? []), flow];
  target.incoming = [...(target.incoming ?? []), flow];
  process.flowElements = [...(process.flowElements ?? []), flow];

  const sourceShape = shapeFor(plane, source.id ?? '');
  const targetShape = shapeFor(plane, target.id ?? '');
  const sx =
    (sourceShape?.bounds?.x ?? 0) + (sourceShape?.bounds?.width ?? 100) / 2;
  const sy =
    (sourceShape?.bounds?.y ?? 0) + (sourceShape?.bounds?.height ?? 80) / 2;
  const tx =
    (targetShape?.bounds?.x ?? sx + 120) +
    (targetShape?.bounds?.width ?? 100) / 2;
  const ty =
    (targetShape?.bounds?.y ?? sy) + (targetShape?.bounds?.height ?? 80) / 2;

  const edge = moddle.create('bpmndi:BPMNEdge', {
    id: `${flowId}_di`,
    bpmnElement: flow,
    waypoint: [
      moddle.create('dc:Point', { x: sx, y: sy }),
      moddle.create('dc:Point', { x: tx, y: ty }),
    ],
  }) as ModdleElement;
  plane.planeElement = [...(plane.planeElement ?? []), edge];
  used.add(edge.id!);
  return flow;
}

function addFlowNode(
  moddle: BpmnModdle,
  process: ModdleElement,
  plane: ModdleElement,
  used: Set<string>,
  type: string,
  name: string | undefined,
  x: number,
  y: number,
  afterElementId?: string
): ModdleElement {
  const prefix = type.replace('bpmn:', '').replace(/[^A-Za-z]/g, '') || 'Element';
  const id = nextId(prefix, used);
  const element = moddle.create(type, {
    id,
    name: name || undefined,
  }) as ModdleElement;
  process.flowElements = [...(process.flowElements ?? []), element];

  const size = defaultSize(type);
  const shape = moddle.create('bpmndi:BPMNShape', {
    id: `${id}_di`,
    bpmnElement: element,
    bounds: moddle.create('dc:Bounds', {
      x,
      y,
      width: size.width,
      height: size.height,
    }),
  }) as ModdleElement;
  plane.planeElement = [...(plane.planeElement ?? []), shape];
  used.add(shape.id!);

  if (afterElementId) {
    const after = findFlowElement(process, afterElementId);
    if (after && after.$type !== 'bpmn:SequenceFlow') {
      linkSequenceFlow(moddle, process, plane, used, after, element);
    }
  }

  return element;
}

function removeElement(
  process: ModdleElement,
  plane: ModdleElement,
  elementId: string
): void {
  const target = findFlowElement(process, elementId);
  if (!target) {
    return;
  }

  const flowsToRemove = new Set<string>();
  if (target.$type === 'bpmn:SequenceFlow') {
    flowsToRemove.add(elementId);
    const source = target.sourceRef as ModdleElement | undefined;
    const dest = target.targetRef as ModdleElement | undefined;
    if (source && typeof source !== 'string') {
      source.outgoing = (source.outgoing ?? []).filter((f) => f.id !== elementId);
    }
    if (dest && typeof dest !== 'string') {
      dest.incoming = (dest.incoming ?? []).filter((f) => f.id !== elementId);
    }
  } else {
    for (const flow of [...(target.incoming ?? []), ...(target.outgoing ?? [])]) {
      if (flow.id) {
        flowsToRemove.add(flow.id);
      }
    }
    for (const flowId of flowsToRemove) {
      const flow = findFlowElement(process, flowId);
      if (!flow) {
        continue;
      }
      const source = flow.sourceRef as ModdleElement | undefined;
      const dest = flow.targetRef as ModdleElement | undefined;
      if (source && typeof source !== 'string') {
        source.outgoing = (source.outgoing ?? []).filter((f) => f.id !== flowId);
      }
      if (dest && typeof dest !== 'string') {
        dest.incoming = (dest.incoming ?? []).filter((f) => f.id !== flowId);
      }
    }
  }

  const removeIds = new Set([elementId, ...flowsToRemove]);
  process.flowElements = (process.flowElements ?? []).filter(
    (el) => !el.id || !removeIds.has(el.id)
  );
  plane.planeElement = (plane.planeElement ?? []).filter((di) => {
    const linked = refId(di.bpmnElement as ModdleElement | string);
    return !linked || !removeIds.has(linked);
  });
}

export async function applyOperations(
  xml: string,
  operations: GraphOperation[]
): Promise<{ xml: string; applied: number }> {
  if (operations.length > MAX_OPERATIONS_PER_REQUEST) {
    throw new Error(
      `At most ${MAX_OPERATIONS_PER_REQUEST} operations per request.`
    );
  }

  const { moddle, definitions } = await fromXml(xml);
  ensureBiocNamespace(definitions);
  const process = getProcess(definitions);
  const plane = getPlane(definitions);
  const used = collectIds(process, plane);
  let applied = 0;

  for (const operation of operations) {
    switch (operation.op) {
      case 'add_task': {
        const pos = positionAfter(
          plane,
          operation.afterElementId,
          operation.x ?? 320,
          operation.y ?? 100
        );
        addFlowNode(
          moddle,
          process,
          plane,
          used,
          'bpmn:Task',
          operation.name,
          operation.x ?? pos.x,
          operation.y ?? pos.y,
          operation.afterElementId
        );
        applied += 1;
        break;
      }
      case 'add_gateway': {
        const type =
          operation.gatewayType === 'parallel'
            ? 'bpmn:ParallelGateway'
            : 'bpmn:ExclusiveGateway';
        const pos = positionAfter(
          plane,
          operation.afterElementId,
          operation.x ?? 320,
          operation.y ?? 100
        );
        addFlowNode(
          moddle,
          process,
          plane,
          used,
          type,
          operation.name,
          operation.x ?? pos.x,
          operation.y ?? pos.y,
          operation.afterElementId
        );
        applied += 1;
        break;
      }
      case 'connect': {
        const source = findFlowElement(process, operation.sourceId);
        const target = findFlowElement(process, operation.targetId);
        if (!source || !target) {
          throw new Error(
            `connect: missing source ${operation.sourceId} or target ${operation.targetId}`
          );
        }
        linkSequenceFlow(
          moddle,
          process,
          plane,
          used,
          source,
          target,
          operation.name
        );
        applied += 1;
        break;
      }
      case 'rename_element': {
        const el = findFlowElement(process, operation.elementId);
        if (!el) {
          throw new Error(`rename_element: ${operation.elementId} not found`);
        }
        el.name = operation.name;
        applied += 1;
        break;
      }
      case 'set_documentation': {
        const el = findFlowElement(process, operation.elementId);
        if (!el) {
          throw new Error(
            `set_documentation: ${operation.elementId} not found`
          );
        }
        el.documentation = [
          moddle.create('bpmn:Documentation', {
            text: operation.documentation,
          }) as { text?: string },
        ];
        applied += 1;
        break;
      }
      case 'set_assignee': {
        const el = findFlowElement(process, operation.elementId);
        if (!el) {
          throw new Error(`set_assignee: ${operation.elementId} not found`);
        }
        el.set?.('camunda:assignee', operation.assignee || undefined);
        if (el.$attrs) {
          if (operation.assignee) {
            el.$attrs['camunda:assignee'] = operation.assignee;
          } else {
            delete el.$attrs['camunda:assignee'];
          }
        }
        applied += 1;
        break;
      }
      case 'set_color': {
        const shape =
          shapeFor(plane, operation.elementId) ??
          edgeFor(plane, operation.elementId);
        if (!shape) {
          throw new Error(`set_color: DI for ${operation.elementId} not found`);
        }
        const stroke = operation.stroke ?? darkenHex(operation.fill);
        shape.set?.('bioc:fill', operation.fill);
        shape.set?.('bioc:stroke', stroke);
        const attrs = (shape.$attrs ??= {});
        attrs['bioc:fill'] = operation.fill;
        attrs['bioc:stroke'] = stroke;
        applied += 1;
        break;
      }
      case 'delete_elements': {
        for (const elementId of operation.elementIds) {
          removeElement(process, plane, elementId);
        }
        applied += 1;
        break;
      }
      default: {
        const _exhaustive: never = operation;
        throw new Error(`Unknown operation: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  const nextXml = await toXml(moddle, definitions);
  return { xml: nextXml, applied };
}

function darkenHex(hex: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) {
    return '#334155';
  }
  const channels = match.slice(1, 4).map((part) => {
    const value = Math.max(0, Math.floor(parseInt(part, 16) * 0.55));
    return value.toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

export function parseOperations(raw: unknown): GraphOperation[] {
  if (!Array.isArray(raw)) {
    throw new Error('operations must be an array');
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || !('op' in item)) {
      throw new Error(`operations[${index}] is invalid`);
    }
    return item as GraphOperation;
  });
}

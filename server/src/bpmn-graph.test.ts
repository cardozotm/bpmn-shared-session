import { describe, expect, it } from 'vitest';
import { applyOperations, summarizeGraph, toGraph } from './bpmn-graph.js';
import { EMPTY_DIAGRAM_XML } from './rooms.js';

describe('bpmn-graph', () => {
  it('extracts start event from empty diagram', async () => {
    const graph = await toGraph(EMPTY_DIAGRAM_XML);
    expect(graph.processId).toBe('Process_1');
    expect(graph.elements.some((el) => el.id === 'StartEvent_1')).toBe(true);
    expect(graph.flows).toEqual([]);
    expect(summarizeGraph(graph)).toContain('StartEvent_1');
  });

  it('adds a task after the start event and connects it', async () => {
    const { xml, applied } = await applyOperations(EMPTY_DIAGRAM_XML, [
      {
        op: 'add_task',
        name: 'Review',
        afterElementId: 'StartEvent_1',
      },
    ]);
    expect(applied).toBe(1);

    const graph = await toGraph(xml);
    const task = graph.elements.find((el) => el.name === 'Review');
    expect(task?.type).toBe('bpmn:Task');
    expect(graph.flows.some((f) => f.sourceRef === 'StartEvent_1')).toBe(true);
  });

  it('renames, documents, assigns, and colors an element', async () => {
    const { xml: withTask } = await applyOperations(EMPTY_DIAGRAM_XML, [
      { op: 'add_task', name: 'Draft', afterElementId: 'StartEvent_1' },
    ]);
    const draft = (await toGraph(withTask)).elements.find(
      (el) => el.name === 'Draft'
    );
    expect(draft).toBeTruthy();

    const { xml } = await applyOperations(withTask, [
      { op: 'rename_element', elementId: draft!.id, name: 'Approve' },
      {
        op: 'set_documentation',
        elementId: draft!.id,
        documentation: 'Manager approval',
      },
      { op: 'set_assignee', elementId: draft!.id, assignee: 'alice' },
      {
        op: 'set_color',
        elementId: draft!.id,
        fill: '#bfdbfe',
        stroke: '#1d4ed8',
      },
    ]);

    const graph = await toGraph(xml);
    const el = graph.elements.find((e) => e.id === draft!.id);
    expect(el?.name).toBe('Approve');
    expect(el?.documentation).toBe('Manager approval');
    expect(el?.assignee).toBe('alice');
    expect(el?.fill).toBe('#bfdbfe');
    expect(el?.stroke).toBe('#1d4ed8');
  });

  it('adds exclusive gateway and connects two targets', async () => {
    const { xml: step1 } = await applyOperations(EMPTY_DIAGRAM_XML, [
      { op: 'add_task', name: 'A', afterElementId: 'StartEvent_1' },
    ]);
    const a = (await toGraph(step1)).elements.find((el) => el.name === 'A')!;

    const { xml: step2 } = await applyOperations(step1, [
      {
        op: 'add_gateway',
        gatewayType: 'exclusive',
        name: 'OK?',
        afterElementId: a.id,
      },
    ]);
    const gw = (await toGraph(step2)).elements.find((el) => el.name === 'OK?')!;

    const { xml } = await applyOperations(step2, [
      { op: 'add_task', name: 'Yes', afterElementId: gw.id, y: 40 },
      { op: 'add_task', name: 'No', x: 520, y: 180 },
    ]);
    const graph = await toGraph(xml);
    const no = graph.elements.find((el) => el.name === 'No')!;
    const { xml: linked } = await applyOperations(xml, [
      { op: 'connect', sourceId: gw.id, targetId: no.id, name: 'No' },
    ]);
    const finalGraph = await toGraph(linked);
    expect(
      finalGraph.flows.some(
        (f) => f.sourceRef === gw.id && f.targetRef === no.id
      )
    ).toBe(true);
  });

  it('deletes an element and its flows', async () => {
    const { xml: withTask } = await applyOperations(EMPTY_DIAGRAM_XML, [
      { op: 'add_task', name: 'Temp', afterElementId: 'StartEvent_1' },
    ]);
    const temp = (await toGraph(withTask)).elements.find(
      (el) => el.name === 'Temp'
    )!;
    const { xml } = await applyOperations(withTask, [
      { op: 'delete_elements', elementIds: [temp.id] },
    ]);
    const graph = await toGraph(xml);
    expect(graph.elements.find((el) => el.id === temp.id)).toBeUndefined();
    expect(graph.flows).toEqual([]);
  });
});

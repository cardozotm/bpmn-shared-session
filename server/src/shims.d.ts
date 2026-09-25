declare module 'bpmn-moddle' {
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    fromXML(xml: string): Promise<{ rootElement: unknown }>;
    toXML(
      element: unknown,
      options?: { format?: boolean }
    ): Promise<{ xml: string }>;
    create(type: string, attrs?: Record<string, unknown>): unknown;
  }
}

declare module 'camunda-bpmn-moddle/resources/camunda.json' {
  const value: Record<string, unknown>;
  export default value;
}

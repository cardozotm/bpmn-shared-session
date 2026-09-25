import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAgentClient } from './agent-client.js';

const baseUrl = process.env.BPMN_SERVER_URL?.trim() || 'http://127.0.0.1:8765';
const token = process.env.BPMN_AGENT_TOKEN?.trim() || '';
let activeRoomId = process.env.BPMN_ROOM_ID?.trim().toUpperCase() || '';

if (!token) {
  console.error(
    '[bpmn-mcp] BPMN_AGENT_TOKEN is required (same value as the server).'
  );
}

const client = createAgentClient({ baseUrl, token });

function requireRoom(roomId?: string): string {
  const id = (roomId ?? activeRoomId).trim().toUpperCase();
  if (!id) {
    throw new Error(
      'No active room. Call set_active_room or set BPMN_ROOM_ID.'
    );
  }
  return id;
}

function text(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorText(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true as const,
  };
}

const server = new McpServer({
  name: 'bpmn-shared-session',
  version: '1.0.0',
});

server.registerTool(
  'set_active_room',
  {
    description: 'Set the default BPMN room id for subsequent tool calls.',
    inputSchema: {
      roomId: z.string().describe('Room code, e.g. ABC123'),
    },
  },
  async ({ roomId }) => {
    activeRoomId = roomId.trim().toUpperCase();
    return text({ ok: true, roomId: activeRoomId });
  }
);

server.registerTool(
  'get_room',
  {
    description:
      'Get room snapshot (revision, legend, participants). XML omitted unless includeXml=true.',
    inputSchema: {
      roomId: z.string().optional(),
      includeXml: z.boolean().optional(),
    },
  },
  async ({ roomId, includeXml }) => {
    try {
      const id = requireRoom(roomId);
      return text(await client.getRoom(id, Boolean(includeXml)));
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'get_process_summary',
  {
    description:
      'Return a compact process graph and human-readable summary for the room.',
    inputSchema: {
      roomId: z.string().optional(),
    },
  },
  async ({ roomId }) => {
    try {
      const id = requireRoom(roomId);
      return text(await client.getGraph(id));
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'find_elements',
  {
    description: 'Filter process elements by name, type, or assignee substring.',
    inputSchema: {
      roomId: z.string().optional(),
      name: z.string().optional(),
      type: z.string().optional(),
      assignee: z.string().optional(),
    },
  },
  async ({ roomId, name, type, assignee }) => {
    try {
      const id = requireRoom(roomId);
      const payload = await client.getGraph(id);
      const nameQ = name?.toLowerCase();
      const typeQ = type?.toLowerCase();
      const assigneeQ = assignee?.toLowerCase();
      const matches = payload.graph.elements.filter((el) => {
        if (nameQ && !(el.name ?? '').toLowerCase().includes(nameQ)) {
          return false;
        }
        if (typeQ && !el.type.toLowerCase().includes(typeQ)) {
          return false;
        }
        if (
          assigneeQ &&
          !(el.assignee ?? '').toLowerCase().includes(assigneeQ)
        ) {
          return false;
        }
        return true;
      });
      return text({ roomId: id, revision: payload.revision, matches });
    } catch (error) {
      return errorText(error);
    }
  }
);

async function mutateTool(operations: unknown[]) {
  const id = requireRoom();
  return text(await client.mutate(id, operations));
}

server.registerTool(
  'add_task',
  {
    description: 'Add a BPMN task, optionally connected after another element.',
    inputSchema: {
      name: z.string(),
      afterElementId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      roomId: z.string().optional(),
    },
  },
  async ({ name, afterElementId, x, y, roomId }) => {
    try {
      if (roomId) {
        activeRoomId = roomId.trim().toUpperCase();
      }
      return await mutateTool([
        { op: 'add_task', name, afterElementId, x, y },
      ]);
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'add_gateway',
  {
    description: 'Add an exclusive or parallel gateway.',
    inputSchema: {
      gatewayType: z.enum(['exclusive', 'parallel']),
      name: z.string().optional(),
      afterElementId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      roomId: z.string().optional(),
    },
  },
  async (args) => {
    try {
      if (args.roomId) {
        activeRoomId = args.roomId.trim().toUpperCase();
      }
      return await mutateTool([
        {
          op: 'add_gateway',
          gatewayType: args.gatewayType,
          name: args.name,
          afterElementId: args.afterElementId,
          x: args.x,
          y: args.y,
        },
      ]);
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'connect',
  {
    description: 'Create a sequence flow between two elements.',
    inputSchema: {
      sourceId: z.string(),
      targetId: z.string(),
      name: z.string().optional(),
      roomId: z.string().optional(),
    },
  },
  async ({ sourceId, targetId, name, roomId }) => {
    try {
      if (roomId) {
        activeRoomId = roomId.trim().toUpperCase();
      }
      return await mutateTool([
        { op: 'connect', sourceId, targetId, name },
      ]);
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'rename_element',
  {
    description: 'Rename a BPMN element.',
    inputSchema: {
      elementId: z.string(),
      name: z.string(),
      roomId: z.string().optional(),
    },
  },
  async ({ elementId, name, roomId }) => {
    try {
      if (roomId) {
        activeRoomId = roomId.trim().toUpperCase();
      }
      return await mutateTool([
        { op: 'rename_element', elementId, name },
      ]);
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'set_documentation',
  {
    description: 'Set bpmn:Documentation text on an element.',
    inputSchema: {
      elementId: z.string(),
      documentation: z.string(),
      roomId: z.string().optional(),
    },
  },
  async ({ elementId, documentation, roomId }) => {
    try {
      if (roomId) {
        activeRoomId = roomId.trim().toUpperCase();
      }
      return await mutateTool([
        { op: 'set_documentation', elementId, documentation },
      ]);
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'set_assignee',
  {
    description: 'Set camunda:assignee on an element.',
    inputSchema: {
      elementId: z.string(),
      assignee: z.string(),
      roomId: z.string().optional(),
    },
  },
  async ({ elementId, assignee, roomId }) => {
    try {
      if (roomId) {
        activeRoomId = roomId.trim().toUpperCase();
      }
      return await mutateTool([{ op: 'set_assignee', elementId, assignee }]);
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'set_color',
  {
    description: 'Set bioc fill/stroke colors on an element DI shape.',
    inputSchema: {
      elementId: z.string(),
      fill: z.string(),
      stroke: z.string().optional(),
      roomId: z.string().optional(),
    },
  },
  async ({ elementId, fill, stroke, roomId }) => {
    try {
      if (roomId) {
        activeRoomId = roomId.trim().toUpperCase();
      }
      return await mutateTool([
        { op: 'set_color', elementId, fill, stroke },
      ]);
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerTool(
  'delete_elements',
  {
    description: 'Delete one or more elements (and their sequence flows).',
    inputSchema: {
      elementIds: z.array(z.string()).min(1),
      roomId: z.string().optional(),
    },
  },
  async ({ elementIds, roomId }) => {
    try {
      if (roomId) {
        activeRoomId = roomId.trim().toUpperCase();
      }
      return await mutateTool([{ op: 'delete_elements', elementIds }]);
    } catch (error) {
      return errorText(error);
    }
  }
);

server.registerResource(
  'room-graph',
  'bpmn://room/active/graph',
  {
    description: 'Structured graph for the active room',
    mimeType: 'application/json',
  },
  async () => {
    const id = requireRoom();
    const payload = await client.getGraph(id);
    return {
      contents: [
        {
          uri: `bpmn://room/${id}/graph`,
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
);

server.registerResource(
  'room-xml',
  'bpmn://room/active/xml',
  {
    description: 'Raw BPMN XML for the active room',
    mimeType: 'application/xml',
  },
  async () => {
    const id = requireRoom();
    const payload = await client.getRoom(id, true);
    return {
      contents: [
        {
          uri: `bpmn://room/${id}/xml`,
          mimeType: 'application/xml',
          text: String(payload.xml ?? ''),
        },
      ],
    };
  }
);

server.registerPrompt(
  'review_process',
  {
    description: 'Ask the model to review the active BPMN process for issues.',
    argsSchema: {
      roomId: z.string().optional(),
    },
  },
  async ({ roomId }) => {
    const id = requireRoom(roomId);
    const payload = await client.getGraph(id);
    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Review this BPMN process in room ${id} (revision ${payload.revision}). List dead ends, missing names, missing assignees on user tasks, and unclear gateways.\n\n${payload.summary}`,
          },
        },
      ],
    };
  }
);

server.registerPrompt(
  'find_dead_ends',
  {
    description: 'Focus the model on finding dead-end paths in the active room.',
    argsSchema: {
      roomId: z.string().optional(),
    },
  },
  async ({ roomId }) => {
    const id = requireRoom(roomId);
    const payload = await client.getGraph(id);
    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Find dead ends and unreachable elements in room ${id}.\n\n${payload.summary}\n\nGraph JSON:\n${JSON.stringify(payload.graph, null, 2)}`,
          },
        },
      ],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[bpmn-mcp] connected (server=${baseUrl} room=${activeRoomId || '(none)'})`
  );
}

main().catch((error) => {
  console.error('[bpmn-mcp] fatal', error);
  process.exit(1);
});

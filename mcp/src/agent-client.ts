export interface AgentClientOptions {
  baseUrl: string;
  token: string;
}

async function request<T>(
  options: AgentClientOptions,
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${options.baseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const body = (await response.json().catch(() => ({}))) as T & {
    ok?: boolean;
    error?: string;
  };

  if (!response.ok || body.ok === false) {
    throw new Error(
      body.error ?? `HTTP ${response.status} for ${path}`
    );
  }

  return body;
}

export function createAgentClient(options: AgentClientOptions) {
  return {
    getRoom(roomId: string, includeXml = false) {
      const q = includeXml ? '' : '?includeXml=0';
      return request<Record<string, unknown>>(
        options,
        `/agent/rooms/${encodeURIComponent(roomId)}${q}`
      );
    },
    getGraph(roomId: string) {
      return request<{
        roomId: string;
        revision: number;
        graph: {
          elements: Array<{
            id: string;
            type: string;
            name: string | null;
            assignee: string | null;
            documentation: string | null;
          }>;
          flows: Array<{
            id: string;
            sourceRef: string | null;
            targetRef: string | null;
            name: string | null;
          }>;
        };
        summary: string;
      }>(options, `/agent/rooms/${encodeURIComponent(roomId)}/graph`);
    },
    mutate(roomId: string, operations: unknown[]) {
      return request<Record<string, unknown>>(
        options,
        `/agent/rooms/${encodeURIComponent(roomId)}/mutations`,
        {
          method: 'POST',
          body: JSON.stringify({ operations }),
        }
      );
    },
  };
}

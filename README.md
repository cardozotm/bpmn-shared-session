# Shared BPMN session

Web app where up to five users join the same room and edit a [bpmn-js](https://bpmn.io/toolkit/bpmn-js/) diagram together in real time.

## Stack

- **Client**: Vite, TypeScript, bpmn-js Modeler, Socket.IO client
- **Server**: Node.js, Express, Socket.IO (in-memory rooms + optional Supabase persistence)
- **MCP**: Cursor stdio server (`mcp/`) talking to the agent HTTP API for local-model edits
- **Host**: [Render](https://render.com) (single Web Service serves the built client + API)

No login. Rooms live in server memory while the process is awake. When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, the latest XML, revision, and color legend for each room are upserted to Postgres so the diagram survives Render sleep.

### Resilience

- Each browser gets a stable `clientId` in `localStorage`. Reconnects reuse the same seat (not an extra user).
- Transport disconnects keep the seat for **45 seconds** so a refresh or brief network blip can rejoin.
- After the last participant leaves (or grace expires), the room XML is kept for **24 hours** while the process stays awake.
- Diagram XML is also persisted in the browser `localStorage` (per room code). Leaving and returning — even after a Render sleep — restores the drawing from local storage (and from Supabase when configured) and recreates the room on the server when needed.
- Active session and a short list of recent rooms are kept in `localStorage`.
- **Limit:** without Supabase, local persistence is per browser/device; another device only sees what the live server still has.

## Quick start (local)

```bash
npm install
npm run dev
```

- App: http://localhost:5173  
- API / Socket.IO: http://localhost:8765  

Optional persistence (apply [`supabase/migrations/20260325140000_rooms.sql`](supabase/migrations/20260325140000_rooms.sql) in your project, then set vars in `server/.env` — see [`.env.example`](.env.example)):

```bash
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
BPMN_AGENT_TOKEN=dev-agent-token
```

Open two or more browser windows. In the first, enter a name and click **Criar sessão**. Copy the link or room code. In the others, enter a name and the code, then **Entrar na sessão**. Draw on either side; the other clients update after a short debounce.

A sixth join attempt for the same room is rejected (room full, max 5).

## Cursor MCP (local model)

Edit diagrams from Cursor with a local model via the project MCP server.

1. Put `BPMN_AGENT_TOKEN` in `server/.env` (same value as in [`.cursor/mcp.json`](.cursor/mcp.json)).
2. `npm run dev` (API on `:8765`).
3. Create or join a room in the browser; copy the room code.
4. In Cursor: enable the `bpmn-shared-session` MCP, then either set `BPMN_ROOM_ID` in `.cursor/mcp.json` or call tool `set_active_room`.
5. Ask the model to inspect or mutate the diagram (`get_process_summary`, `add_task`, `rename_element`, …). Changes broadcast to live browsers over Socket.IO.

Agent HTTP routes (Bearer token required):

- `GET /agent/rooms/:roomId`
- `GET /agent/rooms/:roomId/graph`
- `POST /agent/rooms/:roomId/mutations`

```bash
npm run mcp   # stdio MCP only (Cursor usually spawns this itself)
```

## Production build

```bash
npm install
npm run build
NODE_ENV=production npm start
```

The Express server serves `client/dist` and Socket.IO on the same origin (port from `PORT`, default `8765`).

## Deploy (GitHub + Render)

- **Repo:** https://github.com/cardozotm/bpmn-shared-session  
- **Live app:** https://bpmn-shared-session.onrender.com  
- **Dashboard:** https://dashboard.render.com/web/srv-daq1p960tbcc73fgi03g  

**One-click Blueprint (new environments):** [Deploy to Render](https://dashboard.render.com/blueprint/new?repo=https://github.com/cardozotm/bpmn-shared-session)

Render runs `npm install --include=dev && npm run build`, then `npm start`, with `NODE_ENV=production`. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the Render dashboard for cloud persistence.

On the free tier the service sleeps when idle; in-memory rooms are cleared when the process stops (Supabase keeps the last snapshot when configured).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start API and Vite together |
| `npm test` | Run server unit tests |
| `npm run build` | Build client and server |
| `npm start` | Run the production server |
| `npm run mcp` | Run the Cursor MCP server over stdio |

## How sync works

1. Local edits fire `commandStack.changed`.
2. After ~250 ms the client exports XML and sends `diagram:update` with `baseRevision`.
3. The server accepts the update only if `baseRevision` matches the canonical revision, then broadcasts `diagram:state` and upserts the room row when Supabase is enabled.
4. Remote clients `importXML` with a flag so the import does not echo back; the canvas viewbox is restored so zoom does not jump.
5. Selection changes are shared as presence so the peer outline can highlight the selected element.
6. On Socket.IO reconnect the client re-joins with the same `clientId` and applies the server snapshot if the revision advanced.
7. Element colors live in the BPMN DI; the editable color legend is synced via `legend:update` / `legend:state`.

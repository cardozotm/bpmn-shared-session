# Shared BPMN session

Web app where two users join the same room and edit a [bpmn-js](https://bpmn.io/toolkit/bpmn-js/) diagram together in real time.

## Stack

- **Client**: Vite, TypeScript, bpmn-js Modeler, Socket.IO client
- **Server**: Node.js, Express, Socket.IO (in-memory rooms)
- **Host**: [Render](https://render.com) (single Web Service serves the built client + API)

No login and no database. Rooms live in server memory while someone is connected (plus a short idle grace period after the last participant leaves, so a refresh can rejoin).

## Quick start (local)

```bash
npm install
npm run dev
```

- App: http://localhost:5173  
- API / Socket.IO: http://localhost:8765  

Open two browser windows (or one normal + one private window). In the first, enter a name and click **Criar sessão**. Copy the link or room code. In the second, enter a name and the code, then **Entrar na sessão**. Draw on either side; the other client updates after a short debounce.

A third join attempt for the same room is rejected (room full).

## Production build

```bash
npm install
npm run build
NODE_ENV=production npm start
```

The Express server serves `client/dist` and Socket.IO on the same origin (port from `PORT`, default `8765`).

## Deploy (GitHub + Render)

1. Push this repo to GitHub (already wired via `render.yaml`).
2. In the [Render Dashboard](https://dashboard.render.com), create a new **Blueprint** and select this repository.
3. Render runs `npm install && npm run build`, then `npm start`, with `NODE_ENV=production`.
4. Open the public URL, hit `/health`, and share a room between two browsers.

On the free tier the service sleeps when idle; in-memory rooms are cleared when the process stops.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start API and Vite together |
| `npm test` | Run room store unit tests |
| `npm run build` | Build client and server |
| `npm start` | Run the production server |

## How sync works

1. Local edits fire `commandStack.changed`.
2. After ~250 ms the client exports XML and sends `diagram:update` with `baseRevision`.
3. The server accepts the update only if `baseRevision` matches the canonical revision, then broadcasts `diagram:state`.
4. Remote clients `importXML` with a flag so the import does not echo back; the canvas viewbox is restored so zoom does not jump.
5. Selection changes are shared as presence so the peer outline can highlight the selected element.

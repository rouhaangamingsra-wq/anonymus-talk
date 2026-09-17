# privet — ephemeral private rooms

A self-destructing, real-time communication platform. Rooms live **only in server
memory** — no database, no logs of content, nothing on disk. When a room dies,
every trace of it is purged.

## 1. System Architecture

```
┌──────────┐   Socket.io (WebSocket)   ┌───────────────┐   Socket.io   ┌──────────┐
│ Browser A│ ◄───────────────────────► │  Node/Express │ ◄───────────► │ Browser B│
│          │   signaling + chat + TTL  │  Socket.io    │               │          │
│          │ ◄═══════════════════════► │               │               │          │
└──────────┘   WebRTC P2P: A/V media   └───────────────┘               └──────────┘
        └────────────────── + files (RTCDataChannel) ──────────────────┘
```

**Two planes:**

| Plane | Transport | Carries | Sees content? |
|---|---|---|---|
| Signaling & control | Socket.io over WebSocket | SDP offer/answer, ICE candidates, chat messages, room commands | Yes (relay only, never stored) |
| Media & files | WebRTC P2P (SRTP) + RTCDataChannel | Audio/video tracks, file chunks | **No** — server never sees it |

**Connection flow:**
1. Host creates a room → server returns a 6-char access code + a secret `hostToken`.
2. Guest joins with the code → server broadcasts `room:member-joined`.
3. Each *existing* member creates an `RTCPeerConnection` and sends an SDP **offer**
   to the newcomer via `webrtc:signal`. The newcomer answers. ICE candidates are
   trickled the same way.
4. `STUN stun.l.google.com:19302` resolves each peer's public IP:port so ICE can
   find a usable candidate pair. (On a LAN demo it picks host candidates instantly.)
5. File drop uses an `RTCDataChannel` created by the offerer — 16 KB binary chunks
   with buffered-amount backpressure, reassembled to a Blob on the receiver.

**Ephemeral lifecycle (`server/rooms.js`):**
- `lastActivity` is reset by joins, messages, host actions, and throttled
  presence pings (`room:activity` on real user input — mouse/keyboard).
- A sweeper runs every 5 s: idle `> ttlMs` → `destroy('inactivity')`.
- Last member leaving → `destroy('empty')`. Host can `destroy('host-ended')`.
- **Code rotation** instantly deletes the old code from `codeIndex` (blocks new
  joins). With `forceReauth`, all non-host members get a 30 s deadline to resubmit
  the *new* code or they're kicked by the sweeper.
- Host disconnect → host privileges migrate to the longest-standing member.

> Note on honesty for the presentation: chat *text* does pass through the server
> (it must, to be relayed). It is held in memory only as long as it takes to
> broadcast — never written anywhere. Media and files genuinely never touch it.

## 2. Run it

```bash
# terminal 1 — signaling server (Node 18+)
cd server && npm install && npm run dev        # http://localhost:3001

# terminal 2 — client
cd client && npm install && npm run dev        # http://localhost:5173
```

Open `http://localhost:5173` in **two browser windows** (or two machines on the
same network for chat; camera/mic via `getUserMedia` requires `localhost` or HTTPS).

Env vars: `PORT` (default 3001), `ROOM_TTL_MS` (default 900000 = 15 min),
`VITE_SERVER_URL` for the client.

## Deploy for real users

The client is static (Vercel). The server needs a host that supports
long-lived WebSockets — **not** Vercel serverless. Render/Railway work.

1. **Server → Render:** New → Blueprint → this repo (`render.yaml` is ready),
   or New → Web Service → root dir `server`, build `npm install`,
   start `npm start`. You'll get `https://<name>.onrender.com`.
2. **Client → Vercel:** import repo, root dir `client`, framework Vite.
   Add env var `VITE_SERVER_URL=https://<name>.onrender.com`, then deploy.
3. Done — sockets and API calls go to your Render server automatically.
   (Free Render tiers sleep after idle — first connect may take ~30 s.)

## 3. Live demo guide (accelerated self-destruct)

**Setup:** start the server with an accelerated TTL so the self-destruct is
watchable live:

```bash
ROOM_TTL_MS=30000 npm run dev   # 30-second rooms (Windows: set ROOM_TTL_MS=30000 first)
```

(Per-room TTL overrides are still accepted via the socket API — clamped to
10 s–15 min — if you want to wire a debug control back in.)

**Script:**

1. **Host:** create room → read out the 6-char code. Point at the
   `self-destruct mm:ss` countdown in the header.
2. **Guest window:** join with the code → video tiles appear. Mention the
   offer/answer handshake just happened through the socket.
3. Send chat messages, toggle mic/cam, **drag a file** into the chat panel —
   watch the progress bar and the download link appear on the other side.
   *"Those bytes never touched the server."*
4. **Host:** click **Rotate code** → try joining with the *old* code from a third
   window → rejected. Old code is dead instantly.
5. **Host:** click **Rotate + force re-auth** → guest sees the re-auth modal with
   a 30 s deadline. Either enter the new code (stays) or let it expire (kicked).
6. **Finalé:** stop touching the mouse/keyboard and let the countdown hit zero
   → `room:destroyed` fires on every client, all windows return to the home
   screen, server logs `destroyed ... — state purged`. Then `ls` the project —
   there is no database file, no log, nothing. That's the pitch.
7. **Alt ending:** close every tab → `destroyed (empty)` in the server console.

**Backup if WebRTC is blocked** (strict campus network): chat + the full
lifecycle demo still work — they only need WebSocket.

## 4. File map

```
server/
  index.js    Express + Socket.io wiring, event surface, signaling relay
  rooms.js    RoomManager — in-memory state, TTL sweeper, host controls
client/
  src/lib/socket.js   socket.io-client singleton
  src/lib/mesh.js     WebRTC full-mesh + data-channel file transfer
  src/components/Home.jsx  create/join + demo TTL field
  src/components/Room.jsx  video grid, chat, host controls, re-auth modal
```

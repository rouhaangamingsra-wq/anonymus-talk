# privet — ephemeral private rooms

A self-destructing, real-time communication platform. Rooms, messages, signaling
and accounts live in **Firestore with enforced TTL-style expiry** — every room
doc carries `lastActivity`, and any client that witnesses expiry purges the room
and all its subcollections. Media and files are pure peer-to-peer.

## 1. System Architecture

```
┌──────────┐   Firestore listeners    ┌───────────────┐   Firestore    ┌──────────┐
│ Browser A│ ◄───────────────────────► │   Firestore   │ ◄────────────► │ Browser B│
│          │  rooms/members/messages/  │  + Anon Auth  │                │          │
│          │  signals (SDP + ICE)      │  (serverless) │                │          │
│          │ ◄═══════════════════════► │               │                │          │
└──────────┘   WebRTC P2P: A/V media   └───────────────┘                └──────────┘
        └────────────────── + files (RTCDataChannel) ──────────────────┘
```

**Two planes:**

| Plane | Transport | Carries |
|---|---|---|
| Signaling & state | Firestore realtime listeners | SDP offer/answer, ICE candidates, messages, room docs |
| Media & files | WebRTC P2P (SRTP) + RTCDataChannel | Audio/video tracks, file chunks — never touch Firestore |

**Connection flow:**
1. Host creates a room → a `rooms` doc gets a 6-char access code + `hostUid`.
2. Guest joins with the code → writes a `members/{clientId}` doc.
3. Every member watches `members/`; the *newer* member sends SDP **offers** to all
   older members via `signals/` docs (read-once — deleted on delivery). ICE
   candidates trickle through the same collection.
4. `STUN stun.l.google.com:19302` resolves public IP:port for NAT traversal.
5. File drop uses `RTCDataChannel` — 16 KB chunks with backpressure, reassembled
   into a Blob on the receiver.

**Ephemeral lifecycle:**
- `lastActivity` is bumped by joins, messages, host actions, and throttled input
  pings (pointer/keyboard). `expiresAt = lastActivity + ttlMs` (15 min).
- Any client observing an expired room purges it + all subcollections. Chat-log
  entries watch their room doc — that's what powers the live countdown and the
  guaranteed cleanup.
- **Code rotation** overwrites `code` instantly (old code stops matching).
  `forceReauth` sets `reauthDeadline` + `reauthPending`; members who don't
  resubmit the new code in 30 s remove themselves.
- Host leaving → `hostUid` migrates to the longest-standing member.
- **DMs** are hostless 2-person rooms (`dm_<a>_<b>` deterministic id). The record
  persists for the chat log; message data is purged when both leave.

> Honest framing for the presentation: data *is* written to Firestore, but with
> a hard expiry contract — TTL is enforced by watchers, and the delete is a real
> `deleteDoc` purge of the whole subtree. Media/files still never touch it.

## 2. Firebase setup (one-time, ~3 min)

In [console.firebase.google.com](https://console.firebase.google.com) → project
`privet-chat-1311f`:

1. **Build → Firestore Database** → Create database → Production mode → pick a
   region.
2. **Firestore → Rules** → paste the contents of `firestore.rules` → Publish.
3. **Build → Authentication → Sign-in method** → enable **Anonymous**.

That's it — the config in `client/src/lib/firebase.js` is already wired.

## 3. Run it

```bash
cd client && npm install && npm run dev   # http://localhost:5173
```

No server process needed — open two windows and go.

## 4. Deploy (Vercel only — no env vars needed)

Import the repo in Vercel → **Root Directory: `client`** → framework **Vite** →
Deploy. Firebase config is public-by-design; there is no server to point at.

## 5. Live demo guide (accelerated self-destruct)

Open the app with a **`?ttl=30`** query param to create 30-second rooms:

```
http://localhost:5173/?ttl=30        (or your Vercel URL)
```

**Script:**

1. **Host:** create a room → read out the code → show the `self-destruct mm:ss`
   countdown in the header.
2. **Guest window:** join with the code → video tiles appear. The offer/answer
   handshake just happened through `signals/` docs.
3. Chat, react (hover a message), delete your own message, **drag a file** in —
   P2P, never touches Firestore.
4. **Host:** **Rotate code** → old code rejected instantly in a third window.
5. **Host:** **Rotate + force re-auth** → guests get a 30 s re-auth modal.
6. **Finalé:** hands off mouse/keyboard → countdown hits zero → the room doc and
   every subcollection is purged → everyone lands back on the home screen.
   Check the Firestore console live: the doc is *gone*, not flagged.
7. **DMs:** send a chat request from Requests → accept → hostless 2-person room.
   Leave it → entry stays in the chat log; **Remove** severs your link entirely.

**Fallback if WebRTC is blocked** (strict campus network): chat, DMs and the
full lifecycle still work — they only need Firestore.

## 6. File map

```
client/
  src/lib/firebase.js   app init + analytics
  src/lib/db.js         the whole backend: auth, rooms, TTL, DMs, signaling
  src/lib/mesh.js       WebRTC full-mesh + data-channel file transfer
  src/components/       Auth, Sidebar, Home, Requests, Settings, ChatLog, Room
server/                 legacy Socket.io backend — kept as a local/demo variant
firestore.rules         paste into Firebase console → Firestore → Rules
render.yaml             legacy Render blueprint for the server variant
```

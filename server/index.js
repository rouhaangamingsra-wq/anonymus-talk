import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import cors from 'cors';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';
import { AuthStore } from './auth.js';

// ---------------------------------------------------------------------------
// Config — set ROOM_TTL_MS=30000 (or DEMO_TTL via the client's demo field) to
// compress the 15-minute self-destruct for a live presentation.
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 15 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json());
const auth = new AuthStore();

app.get('/health', (_req, res) => res.json({ ok: true, defaultTtlMs: ROOM_TTL_MS }));

// ---- anonymous accounts (in-memory, wiped on restart) -----------------------
app.post('/api/register', (req, res) => {
  const r = auth.register(req.body?.username, req.body?.password);
  res.status(r.error ? 400 : 200).json(r);
});
app.post('/api/login', (req, res) => {
  const r = auth.login(req.body?.username, req.body?.password);
  res.status(r.error ? 401 : 200).json(r);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const manager = new RoomManager(io, { defaultTtlMs: ROOM_TTL_MS });

const ack = (cb, val) => typeof cb === 'function' && cb(val);

const roomSnapshot = (room, socket, extra = {}) => ({
  roomId: room.id,
  roomName: room.name,
  kind: room.kind || 'room',
  code: room.code,
  hostId: room.hostId,
  ttlMs: room.ttlMs,
  expiresAt: room.lastActivity + room.ttlMs,
  members: manager.publicMembers(room),
  selfId: socket.id,
  ...extra,
});

const online = new Map(); // username -> socketId (presence for DM requests)
const requests = new Map(); // requestId -> { from, to }

io.on('connection', (socket) => {
  const room = () => manager.roomOf(socket);

  // ---- identity (binds the anonymous account to this socket) ------------------
  socket.on('user:identify', ({ token } = {}) => {
    const uname = auth.resolve(token);
    if (!uname) return;
    socket.data.username = uname;
    online.set(uname, socket.id);
  });

  // Persist ONLY theme preference on the account — nothing else is stored.
  socket.on('user:prefs', ({ token, prefs } = {}) => {
    const uname = auth.resolve(token);
    if (uname) auth.setPrefs(uname, prefs);
  });

  // ---- room lifecycle ------------------------------------------------------
  socket.on('room:create', (payload = {}, cb) => {
    const r = manager.createRoom(socket, {
      name: auth.resolve(payload.token) || payload.name,
      roomName: payload.roomName,
      ttlMs: payload.ttlMs,
    });
    ack(cb, roomSnapshot(r, socket, { hostToken: r.hostToken }));
  });

  socket.on('room:join', (payload = {}, cb) => {
    const res = manager.joinRoom(socket, {
      code: payload.code,
      name: auth.resolve(payload.token) || payload.name,
    });
    if (res.error) return ack(cb, { error: res.error });
    ack(cb, roomSnapshot(res.room, socket));
  });

  socket.on('room:leave', () => manager.leave(socket));
  socket.on('disconnect', () => {
    const uname = socket.data.username;
    if (uname && online.get(uname) === socket.id) online.delete(uname);
    manager.leave(socket);
  });

  // Works from inside the room OR from the chat log (hostToken is the credential).
  socket.on('room:end', ({ roomId, hostToken } = {}) => {
    const r = room() || manager.rooms.get(roomId);
    if (!r || r.kind === 'dm' || r.hostToken !== hostToken) return;
    manager.destroy(r.id, 'host-ended');
  });

  // Chat-log polling: live countdowns / existence for rooms you left and DMs.
  socket.on('room:status', ({ roomIds } = {}, cb) => {
    ack(cb, manager.status(Array.isArray(roomIds) ? roomIds.slice(0, 30) : []));
  });

  // ---- host controls ---------------------------------------------------------
  socket.on('room:regenerate-code', (payload, cb) => ack(cb, manager.regenerateCode(socket, payload)));
  socket.on('room:reauth', (payload, cb) => ack(cb, manager.reauth(socket, payload)));
  socket.on('room:kick', (payload, cb) => ack(cb, manager.kick(socket, payload)));

  // ---- chat + presence -------------------------------------------------------
  socket.on('chat:message', ({ text } = {}) => {
    const r = room();
    const member = r?.members.get(socket.id);
    const clean = String(text || '').slice(0, 2000).trim();
    if (!member || !clean) return;
    manager.touch(r);
    io.to(r.id).emit('chat:message', {
      id: `${socket.id}:${Date.now()}`,
      from: socket.id,
      name: member.name,
      text: clean,
      ts: Date.now(),
    });
  });

  // "Active presence": client emits this (throttled) on real user interaction.
  socket.on('room:activity', () => {
    const r = room();
    if (r) manager.touch(r);
  });

  // ---- message delete + reactions (relay-only, nothing stored) ---------------
  socket.on('chat:delete', ({ id } = {}) => {
    const r = room();
    // Message ids are `${socketId}:${ts}` — only the author can delete.
    if (!r || !String(id).startsWith(`${socket.id}:`)) return;
    io.to(r.id).emit('chat:deleted', { id });
  });

  socket.on('chat:react', ({ id, emoji } = {}) => {
    const r = room();
    if (!r || !id || String(emoji).length > 8) return;
    io.to(r.id).emit('chat:reaction', { id, emoji: String(emoji), from: socket.id });
  });

  // ---- DM requests: ask a user to chat; accept opens a hostless 2-person room --
  socket.on('dm:request', ({ to } = {}, cb) => {
    const from = socket.data.username;
    const target = String(to || '').trim().toLowerCase();
    if (!from) return ack(cb, { error: 'Identify first.' });
    if (target === from) return ack(cb, { error: "You can't DM yourself." });
    const targetId = online.get(target);
    if (!targetId) return ack(cb, { error: 'User is offline or does not exist.' });
    const id = crypto.randomBytes(6).toString('hex');
    requests.set(id, { from, to: target });
    io.to(targetId).emit('dm:incoming', { id, from });
    ack(cb, { ok: true, id, to: target });
  });

  socket.on('dm:accept', ({ id } = {}, cb) => {
    const req = requests.get(id);
    if (!req || req.to !== socket.data.username) return ack(cb, { error: 'Request expired.' });
    requests.delete(id);
    const dm = manager.getOrCreateDm(req.from, req.to);
    const fromSocket = io.sockets.sockets.get(online.get(req.from));
    manager.enterDm(socket, dm.id, req.to);
    if (fromSocket) {
      manager.enterDm(fromSocket, dm.id, req.from);
      fromSocket.emit('dm:open', roomSnapshot(dm, fromSocket));
    }
    ack(cb, roomSnapshot(dm, socket));
  });

  socket.on('dm:decline', ({ id } = {}, cb) => {
    const req = requests.get(id);
    if (!req || req.to !== socket.data.username) return ack(cb, { error: 'Request expired.' });
    requests.delete(id);
    const fromId = online.get(req.from);
    if (fromId) io.to(fromId).emit('dm:declined', { to: req.to });
    ack(cb, { ok: true });
  });

  // Re-enter a DM from the chat log (participant check happens server-side).
  socket.on('dm:enter', ({ roomId } = {}, cb) => {
    const res = manager.enterDm(socket, roomId, socket.data.username);
    if (res.error) return ack(cb, { error: res.error });
    ack(cb, roomSnapshot(res.room, socket));
  });

  // Remove a DM from YOUR account — participant link is severed server-side,
  // so nothing on your side shows it existed. When both remove it, the record
  // is destroyed entirely.
  socket.on('dm:remove', ({ roomId } = {}, cb) => {
    const r = manager.rooms.get(roomId);
    const uname = socket.data.username;
    if (!r || r.kind !== 'dm' || !r.participants.includes(uname)) {
      return ack(cb, { error: 'Not found.' });
    }
    manager.leave(socket); // no-op unless you're currently inside it
    r.participants = r.participants.filter((u) => u !== uname);
    if (r.participants.length === 0) manager.destroy(r.id, 'dm-removed');
    ack(cb, { ok: true });
  });

  // ---- WebRTC signaling relay --------------------------------------------------
  // Server only relays SDP/ICE envelopes. Media + file bytes flow P2P and are
  // never visible here — and intentionally do NOT reset the inactivity timer.
  socket.on('webrtc:signal', ({ to, data } = {}) => {
    const r = room();
    if (r?.members.has(to)) io.to(to).emit('webrtc:signal', { from: socket.id, data });
  });
});

server.listen(PORT, () => {
  console.log(`[privet] signaling server on http://localhost:${PORT}`);
  console.log(`[privet] default room TTL: ${ROOM_TTL_MS / 1000}s (override per-room in demo mode)`);
});

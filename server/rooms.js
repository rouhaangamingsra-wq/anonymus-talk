import crypto from 'node:crypto';

// Alphabet without ambiguous characters (no 0/O, 1/I/L) — easy to read aloud in a demo.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 15 * 60 * 1000;

export const generateCode = (len = 6) =>
  Array.from(crypto.randomBytes(len), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

/**
 * RoomManager owns ALL room state in memory. Nothing is persisted — when a room
 * is destroyed every trace (code index, members, timers) is removed from the Maps.
 *
 * Lifecycle:
 *   - activity (join, message, host action, presence ping) resets lastActivity
 *   - sweeper checks every `sweepMs`: idle > ttlMs  -> destroy('inactivity')
 *   - last member leaves                          -> destroy('empty')
 *   - host ends room                              -> destroy('host-ended')
 *   - force re-auth: members must resubmit the NEW code before `deadline`
 *     or the sweeper kicks them.
 */
export class RoomManager {
  constructor(io, { defaultTtlMs = MAX_TTL_MS, sweepMs = 5_000, reauthGraceMs = 30_000 } = {}) {
    this.io = io;
    this.defaultTtlMs = defaultTtlMs;
    this.reauthGraceMs = reauthGraceMs;
    this.rooms = new Map(); // roomId -> room
    this.codeIndex = new Map(); // accessCode -> roomId
    this.dmIndex = new Map(); // "userA|userB" -> roomId (DMs have no code)
    this.sweeper = setInterval(() => this.sweep(), sweepMs);
  }

  _uniqueCode() {
    let code;
    do {
      code = generateCode();
    } while (this.codeIndex.has(code));
    return code;
  }

  publicMembers(room) {
    return [...room.members.entries()].map(([id, m]) => ({
      id,
      name: m.name,
      isHost: id === room.hostId,
    }));
  }

  _emitExpires(room) {
    this.io.to(room.id).emit('room:expires', {
      expiresAt: room.lastActivity + room.ttlMs,
      ttlMs: room.ttlMs,
    });
  }

  touch(room) {
    room.lastActivity = Date.now();
    this._emitExpires(room);
  }

  createRoom(socket, { name, roomName, ttlMs } = {}) {
    const room = {
      id: crypto.randomBytes(4).toString('hex'),
      kind: 'room',
      name: String(roomName || '').slice(0, 40).trim() || 'untitled room',
      code: this._uniqueCode(),
      hostId: socket.id,
      hostToken: crypto.randomBytes(16).toString('hex'),
      members: new Map(), // socketId -> { name }
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ttlMs: Math.min(Math.max(Number(ttlMs) || this.defaultTtlMs, MIN_TTL_MS), MAX_TTL_MS),
      reauth: null, // { deadline, pending:Set<socketId> }
    };
    this.rooms.set(room.id, room);
    this.codeIndex.set(room.code, room.id);
    this._addMember(socket, room, name);
    console.log(`[rooms] created ${room.id} ttl=${room.ttlMs / 1000}s code=${room.code}`);
    return room;
  }

  _addMember(socket, room, name) {
    room.members.set(socket.id, { name: String(name || 'anon').slice(0, 24).trim() || 'anon' });
    socket.data.roomId = room.id;
    socket.join(room.id);
  }

  joinRoom(socket, { code, name } = {}) {
    const roomId = this.codeIndex.get(String(code || '').toUpperCase().trim());
    const room = roomId && this.rooms.get(roomId);
    if (!room) return { error: 'Invalid access code.' };
    this._addMember(socket, room, name);
    socket.to(room.id).emit('room:member-joined', { id: socket.id, name: room.members.get(socket.id).name });
    this.touch(room);
    return { room };
  }

  // ---- DMs: exactly 2 participants, no host, no code -------------------------
  // The record persists so it stays in each user's chat log; message data is
  // relay-only, so the moment both are offline nothing exists but this record.
  getOrCreateDm(userA, userB) {
    const key = [userA, userB].sort().join('|');
    const existing = this.dmIndex.get(key);
    if (existing && this.rooms.has(existing)) {
      const room = this.rooms.get(existing);
      // A user who previously removed this DM gets re-added if they accept again.
      for (const u of [userA, userB]) if (!room.participants.includes(u)) room.participants.push(u);
      return room;
    }
    const room = {
      id: crypto.randomBytes(4).toString('hex'),
      kind: 'dm',
      dmKey: key,
      name: `${userA} ↔ ${userB}`,
      participants: [userA, userB],
      code: null,
      hostId: null,
      hostToken: null,
      members: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ttlMs: Infinity, // DMs are not swept — record survives, data does not
      reauth: null,
    };
    this.rooms.set(room.id, room);
    this.dmIndex.set(key, room.id);
    console.log(`[rooms] dm ${room.id} for ${key}`);
    return room;
  }

  enterDm(socket, roomId, username) {
    const room = this.rooms.get(roomId);
    if (!room || room.kind !== 'dm' || !room.participants.includes(username)) {
      return { error: 'Not a participant of this DM.' };
    }
    if (!room.members.has(socket.id)) {
      this._addMember(socket, room, username);
      socket.to(room.id).emit('room:member-joined', { id: socket.id, name: username });
      this.touch(room);
    }
    return { room };
  }

  status(roomIds) {
    return roomIds.map((id) => {
      const r = this.rooms.get(id);
      if (!r) return { roomId: id, exists: false };
      return {
        roomId: id,
        exists: true,
        kind: r.kind || 'room',
        name: r.name,
        members: r.members.size,
        expiresAt: r.ttlMs === Infinity ? null : r.lastActivity + r.ttlMs,
      };
    });
  }

  roomOf(socket) {
    return this.rooms.get(socket.data.roomId);
  }

  isHost(room, socket, hostToken) {
    return Boolean(room) && room.hostId === socket.id && room.hostToken === hostToken;
  }

  leave(socket) {
    const room = this.roomOf(socket);
    if (!room || !room.members.has(socket.id)) return;
    room.members.delete(socket.id);
    room.reauth?.pending.delete(socket.id);
    socket.leave(room.id);
    socket.data.roomId = null;
    this.io.to(room.id).emit('room:member-left', { id: socket.id });
    if (room.kind === 'dm') {
      // DM record persists in both users' chat logs; nothing else is stored,
      // so all message data is gone the moment both are offline.
      room.lastActivity = Date.now();
      return;
    }
    if (room.members.size === 0) {
      // Room survives empty until the inactivity TTL fires — ex-members watch
      // the countdown in their chat log and can rejoin with the code.
      room.lastActivity = Date.now();
      this._emitExpires(room);
      return;
    }
    if (room.hostId === socket.id) this._migrateHost(room);
    this.touch(room);
  }

  _migrateHost(room) {
    const [newHostId] = room.members.keys(); // longest-standing member
    room.hostId = newHostId;
    room.hostToken = crypto.randomBytes(16).toString('hex');
    this.io.to(room.id).emit('room:host-changed', { hostId: newHostId });
    this.io.to(newHostId).emit('room:you-are-host', { hostToken: room.hostToken });
  }

  regenerateCode(socket, { hostToken, forceReauth } = {}) {
    const room = this.roomOf(socket);
    if (!this.isHost(room, socket, hostToken)) return { error: 'Host privileges required.' };
    this.codeIndex.delete(room.code); // old code dies instantly -> blocks new joins
    room.code = this._uniqueCode();
    this.codeIndex.set(room.code, room.id);
    if (forceReauth) {
      const pending = new Set([...room.members.keys()].filter((id) => id !== room.hostId));
      if (pending.size > 0) {
        room.reauth = { deadline: Date.now() + this.reauthGraceMs, pending };
        socket.to(room.id).emit('room:reauth-required', {
          deadline: room.reauth.deadline,
          graceMs: this.reauthGraceMs,
        });
      }
    }
    this.touch(room);
    return { code: room.code };
  }

  reauth(socket, { code } = {}) {
    const room = this.roomOf(socket);
    if (!room?.reauth || !room.reauth.pending.has(socket.id)) {
      return { error: 'No re-authentication required.' };
    }
    if (String(code || '').toUpperCase().trim() !== room.code) {
      return { error: 'Wrong code — ask the host and try again.' };
    }
    room.reauth.pending.delete(socket.id);
    this.touch(room);
    return { ok: true };
  }

  kick(socket, { hostToken, targetId } = {}) {
    const room = this.roomOf(socket);
    if (!this.isHost(room, socket, hostToken)) return { error: 'Host privileges required.' };
    if (targetId === socket.id || !room.members.has(targetId)) return { error: 'Invalid target.' };
    const target = this.io.sockets.sockets.get(targetId);
    target?.emit('room:kicked', {});
    if (target) this.leave(target);
    this.touch(room);
    return { ok: true };
  }

  destroy(roomId, reason) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.io.to(room.id).emit('room:destroyed', { reason });
    for (const id of room.members.keys()) {
      const s = this.io.sockets.sockets.get(id);
      if (s) {
        s.leave(room.id);
        s.data.roomId = null;
      }
    }
    if (room.code) this.codeIndex.delete(room.code);
    if (room.dmKey) this.dmIndex.delete(room.dmKey);
    this.rooms.delete(roomId);
    console.log(`[rooms] destroyed ${roomId} (${reason}) — state purged`);
  }

  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.reauth && now >= room.reauth.deadline) {
        for (const id of room.reauth.pending) {
          const s = this.io.sockets.sockets.get(id);
          s?.emit('room:kicked', { reason: 'reauth-expired' });
          if (s) this.leave(s);
        }
        room.reauth = null;
      }
      if (now - room.lastActivity >= room.ttlMs) this.destroy(room.id, 'inactivity');
    }
  }
}

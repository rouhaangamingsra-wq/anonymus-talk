// db.js — the entire backend, on Firestore.
//
// Data model:
//   users/{username}                     passHash, salt, prefs — the only stored user data
//   presence/{username}                  lastSeen heartbeat (online = fresh <60s)
//   rooms/{roomId}                       code, hostUid, lastActivity, ttlMs, reauth…
//   rooms/{id}/members/{clientId}        name, uid, joinedAt, lastSeen
//   rooms/{id}/messages/{auto}           authorId, name, text, ts, reactions{}
//   rooms/{id}/signals/{auto}            WebRTC envelopes {to, from, data} — deleted on read
//   requests/{auto}                      DM requests {from, to, status, roomId}
//
// Self-destruct: every client that observes an expired room purges it (and its
// subcollections) — the "sweeper" is whoever is watching. Optionally add a
// Firestore TTL policy on `lastActivity` for belt-and-suspenders cleanup.

import {
  collection, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit, increment, arrayUnion, arrayRemove,
} from 'firebase/firestore';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { auth, db } from './firebase.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode = (len = 6) =>
  Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

// Stable per-tab identity for membership + signaling.
export const clientId = sessionStorage.getItem('cid') || crypto.randomUUID();
sessionStorage.setItem('cid', clientId);

export const myUid = () => auth.currentUser?.uid;

let authReady;
export const ensureAuth = () =>
  (authReady ??= new Promise((res, rej) => {
    const stop = onAuthStateChanged(auth, (u) => {
      if (u) {
        stop();
        res(u);
      }
    });
    signInAnonymously(auth).catch(rej);
  }));

// ---------- users (anonymous accounts — username + salted SHA-256) ----------

const hash = async (salt, pw) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pw}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export async function register(username, password) {
  await ensureAuth();
  const uname = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,20}$/.test(uname)) return { error: 'Username must be 3–20 chars (a–z, 0–9, _ . -).' };
  if (String(password).length < 4) return { error: 'Password must be at least 4 characters.' };
  const ref = doc(db, 'users', uname);
  if ((await getDoc(ref)).exists()) return { error: 'Username already taken.' };
  const salt = crypto.randomUUID();
  await setDoc(ref, { passHash: await hash(salt, password), salt, prefs: null, createdAt: Date.now() });
  return { username: uname, prefs: null };
}

export async function login(username, password) {
  await ensureAuth();
  const uname = String(username || '').trim().toLowerCase();
  const snap = await getDoc(doc(db, 'users', uname));
  if (!snap.exists()) return { error: 'Unknown username — create an account first.' };
  const u = snap.data();
  if (u.passHash !== (await hash(u.salt, password))) return { error: 'Wrong password.' };
  return { username: uname, prefs: u.prefs || null };
}

export const savePrefs = (username, prefs) =>
  updateDoc(doc(db, 'users', username), { prefs }).catch(() => {});

// ---------- presence ----------

let presenceTimer = null;
export function startPresence(username) {
  const ref = doc(db, 'presence', username);
  const beat = () => setDoc(ref, { lastSeen: Date.now() }, { merge: true }).catch(() => {});
  beat();
  presenceTimer = setInterval(beat, 20_000);
}
export const stopPresence = () => clearInterval(presenceTimer);

const isOnline = async (username) => {
  const s = await getDoc(doc(db, 'presence', username));
  return s.exists() && Date.now() - s.data().lastSeen < 60_000;
};

// ---------- rooms ----------

const clampTtl = (ms) => Math.min(Math.max(Number(ms) || 900_000, 10_000), 900_000);
const roomRef = (id) => doc(db, 'rooms', id);
const sub = (id, name) => collection(db, 'rooms', id, name);

const snap = (ref, r) => ({
  roomId: ref.id,
  roomName: r.name,
  kind: r.kind || 'room',
  code: r.code || null,
  hostUid: r.hostUid || null,
  ttlMs: r.ttlMs || null,
  expiresAt: r.ttlMs ? r.lastActivity + r.ttlMs : null,
  selfId: clientId,
});

export async function createRoom({ name, roomName, ttlMs }) {
  await ensureAuth();
  const r = {
    kind: 'room',
    name: String(roomName || '').slice(0, 40).trim() || 'untitled room',
    code: genCode(),
    hostUid: myUid(),
    hostName: name,
    memberCount: 0,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    ttlMs: clampTtl(ttlMs),
    reauthDeadline: null,
    reauthPending: [],
  };
  const ref = await addDoc(collection(db, 'rooms'), r);
  return joinRoomById(ref.id, name, r.code);
}

export async function joinRoom({ name, code }) {
  const q = query(
    collection(db, 'rooms'),
    where('code', '==', String(code || '').toUpperCase().trim()),
    limit(1)
  );
  const res = await getDocs(q);
  if (res.empty) return { error: 'Invalid access code.' };
  const r = res.docs[0].data();
  if (r.kind !== 'room') return { error: 'Invalid access code.' };
  return joinRoomById(res.docs[0].id, name, code);
}

export async function joinRoomById(roomId, name, code) {
  await ensureAuth();
  const ref = roomRef(roomId);
  const s = await getDoc(ref);
  if (!s.exists()) return { error: 'Room no longer exists.' };
  const r = s.data();
  if (r.kind === 'dm') {
    if (!(r.participants || []).includes(name)) return { error: 'Not a participant.' };
  } else {
    if (r.ttlMs && Date.now() - r.lastActivity >= r.ttlMs) {
      await purgeRoom(roomId);
      return { error: 'That room already self-destructed.' };
    }
    if (String(code || '').toUpperCase().trim() !== r.code) return { error: 'Invalid access code.' };
  }
  await setDoc(doc(sub(roomId, 'members'), clientId), {
    name,
    uid: myUid(),
    joinedAt: Date.now(),
    lastSeen: Date.now(),
  });
  await updateDoc(ref, { memberCount: increment(1), lastActivity: Date.now() });
  return snap(ref, r);
}

export const touch = (roomId) =>
  updateDoc(roomRef(roomId), { lastActivity: Date.now() }).catch(() => {});

export const memberHeartbeat = (roomId) =>
  setDoc(doc(sub(roomId, 'members'), clientId), { lastSeen: Date.now() }, { merge: true }).catch(() => {});

const purgeSub = async (roomId, name) => {
  const s = await getDocs(sub(roomId, name));
  await Promise.all(s.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
};

export async function purgeRoom(roomId) {
  await Promise.all(['messages', 'signals', 'members'].map((n) => purgeSub(roomId, n)));
  await deleteDoc(roomRef(roomId)).catch(() => {});
}

export async function leaveRoom(roomId) {
  const s = await getDoc(roomRef(roomId));
  if (!s.exists()) return;
  const r = s.data();
  const myRef = doc(sub(roomId, 'members'), clientId);
  if (!(await getDoc(myRef)).exists()) return;
  await deleteDoc(myRef);
  const rest = await getDocs(sub(roomId, 'members'));
  await updateDoc(roomRef(roomId), { memberCount: increment(-1), lastActivity: Date.now() }).catch(() => {});
  if (r.kind === 'dm') {
    // Both offline → purge all message/signal data; the record stays for the log.
    if (rest.empty) {
      await purgeSub(roomId, 'messages');
      await purgeSub(roomId, 'signals');
    }
    return;
  }
  if (rest.empty) return; // room survives empty until TTL — chat log counts down
  if (r.hostUid === myUid()) {
    const oldest = rest.docs.map((d) => d.data()).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (oldest) await updateDoc(roomRef(roomId), { hostUid: oldest.uid, hostName: oldest.name });
  }
}

// ---------- host controls ----------

export async function regenerateCode(roomId, forceReauth, memberIds) {
  const updates = { code: genCode(), lastActivity: Date.now() };
  if (forceReauth) {
    updates.reauthDeadline = Date.now() + 30_000;
    updates.reauthPending = memberIds.filter((id) => id !== clientId);
  }
  await updateDoc(roomRef(roomId), updates);
  return (await getDoc(roomRef(roomId))).data().code;
}

export async function submitReauth(roomId, code) {
  const s = await getDoc(roomRef(roomId));
  const r = s.data();
  if (!r?.reauthDeadline) return { error: 'No re-authentication required.' };
  if (String(code).toUpperCase().trim() !== r.code) return { error: 'Wrong code — ask the host and try again.' };
  await updateDoc(roomRef(roomId), { reauthPending: arrayRemove(clientId) });
  await touch(roomId);
  return { ok: true };
}

export const kickMember = (roomId, memberId) =>
  deleteDoc(doc(sub(roomId, 'members'), memberId)).catch(() => {});

// ---------- messages + signaling ----------

export async function sendMessage(roomId, name, text) {
  const clean = String(text || '').slice(0, 2000).trim();
  if (!clean) return;
  await addDoc(sub(roomId, 'messages'), { authorId: clientId, name, text: clean, ts: Date.now(), reactions: {} });
  touch(roomId);
}

export const deleteMessage = (roomId, msgId) =>
  deleteDoc(doc(sub(roomId, 'messages'), msgId)).catch(() => {});

export const reactMessage = (roomId, msgId, emoji) =>
  updateDoc(doc(sub(roomId, 'messages'), msgId), { [`reactions.${emoji}`]: increment(1) }).catch(() => {});

export const sendSignal = (roomId, to, data) =>
  addDoc(sub(roomId, 'signals'), {
    to,
    from: clientId,
    data: JSON.parse(JSON.stringify(data)),
    ts: Date.now(),
  }).catch(() => {});

// ---------- DMs (2 participants, no host, deterministic id) ----------

const dmId = (a, b) => `dm_${[a, b].sort().join('_')}`;

export async function getOrCreateDm(a, b) {
  const id = dmId(a, b);
  const ref = roomRef(id);
  const s = await getDoc(ref);
  if (!s.exists()) {
    await setDoc(ref, {
      kind: 'dm',
      name: `${a} ↔ ${b}`,
      participants: [a, b],
      memberCount: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ttlMs: null,
      reauthDeadline: null,
      reauthPending: [],
    });
  } else {
    const missing = [a, b].filter((u) => !(s.data().participants || []).includes(u));
    if (missing.length) await updateDoc(ref, { participants: arrayUnion(...missing) });
  }
  return id;
}

export const enterDm = (roomId, username) => joinRoomById(roomId, username);

// Removes YOU as a participant — no trace on your account. Record dies when
// the last participant removes it.
export async function removeDm(roomId, username) {
  const ref = roomRef(roomId);
  const s = await getDoc(ref);
  if (!s.exists() || s.data().kind !== 'dm') return;
  const participants = (s.data().participants || []).filter((u) => u !== username);
  if (participants.length === 0) await purgeRoom(roomId);
  else await updateDoc(ref, { participants });
}

// ---------- DM requests ----------

export async function sendRequest(from, to) {
  const target = String(to || '').trim().toLowerCase();
  if (target === from) return { error: "You can't DM yourself." };
  if (!(await getDoc(doc(db, 'users', target))).exists()) return { error: 'User does not exist.' };
  if (!(await isOnline(target))) return { error: 'User is offline right now.' };
  await addDoc(collection(db, 'requests'), { from, to: target, status: 'pending', ts: Date.now() });
  return { ok: true };
}

export async function acceptRequest(reqId, me) {
  const ref = doc(db, 'requests', reqId);
  const s = await getDoc(ref);
  const req = s.data();
  if (!s.exists() || !req || req.to !== me || req.status !== 'pending') return { error: 'Request expired.' };
  const roomId = await getOrCreateDm(req.from, req.to);
  await updateDoc(ref, { status: 'accepted', roomId });
  return joinRoomById(roomId, me);
}

export const declineRequest = (reqId) =>
  updateDoc(doc(db, 'requests', reqId), { status: 'declined' }).catch(() => {});
export const deleteRequest = (reqId) => deleteDoc(doc(db, 'requests', reqId)).catch(() => {});

// ---------- watchers (all return unsubscribe fns) ----------

export const watchRoom = (roomId, cb) =>
  onSnapshot(roomRef(roomId), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null));

export const watchMembers = (roomId, cb) =>
  onSnapshot(sub(roomId, 'members'), (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));

export const watchMessages = (roomId, cb) =>
  onSnapshot(query(sub(roomId, 'messages'), orderBy('ts'), limit(200)), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() })))
  );

// Signal docs are consumed once — deleted on read so nothing accumulates.
export const watchSignals = (roomId, cb) =>
  onSnapshot(query(sub(roomId, 'signals'), where('to', '==', clientId)), (s) =>
    s.docChanges().forEach((c) => {
      if (c.type !== 'added') return;
      const { from, data } = c.doc.data();
      cb({ from, data });
      deleteDoc(c.doc.ref).catch(() => {});
    })
  );

export const watchIncoming = (me, cb) =>
  onSnapshot(query(collection(db, 'requests'), where('to', '==', me)), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.status === 'pending'))
  );

export const watchOutgoing = (me, cb) =>
  onSnapshot(query(collection(db, 'requests'), where('from', '==', me)), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() })))
  );

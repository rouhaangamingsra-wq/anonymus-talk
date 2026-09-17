import { useEffect, useRef, useState } from 'react';
import { Mesh } from '../lib/mesh.js';
import * as api from '../lib/db.js';

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const EMOJIS = ['👍', '❤️', '😂', '🔥', '😮'];

function VideoTile({ stream, label, muted = false, mirrored = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="tile">
      <video ref={ref} autoPlay playsInline muted={muted} style={mirrored ? { transform: 'scaleX(-1)' } : undefined} />
      <span className="tile-label">{label}</span>
    </div>
  );
}

export default function Room({ session, onExit }) {
  const roomId = session.roomId;
  const isDm = session.kind === 'dm';
  const clientId = api.clientId;

  const [room, setRoom] = useState(null);
  const [members, setMembers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [streams, setStreams] = useState(new Map()); // remoteId -> MediaStream
  const [localStream, setLocalStream] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [reauth, setReauth] = useState(null); // { deadline }
  const [reauthCode, setReauthCode] = useState('');
  const [reauthError, setReauthError] = useState('');
  const [transfers, setTransfers] = useState(new Map());
  const [files, setFiles] = useState([]);
  const [draft, setDraft] = useState('');
  const [banner, setBanner] = useState('');
  const [dragging, setDragging] = useState(false);

  const meshRef = useRef(null);
  const wasMemberRef = useRef(false);
  const chatEndRef = useRef(null);
  const isHost = room ? room.hostUid === api.myUid() : session.isHost;

  // ---- Firestore watchers + WebRTC wiring ------------------------------------
  useEffect(() => {
    const mesh = new Mesh({
      sendSignal: (to, data) => api.sendSignal(roomId, to, data),
      onRemoteStream: (id, stream) => setStreams((p) => new Map(p).set(id, stream)),
      onPeerGone: (id) =>
        setStreams((p) => {
          const n = new Map(p);
          n.delete(id);
          return n;
        }),
      onFileProgress: (t) => setTransfers((p) => new Map(p).set(t.key, t)),
      onFileReceived: ({ key, name, blob }) => {
        setTransfers((p) => {
          const n = new Map(p);
          n.delete(key);
          return n;
        });
        setFiles((p) => [...p, { key, name, url: URL.createObjectURL(blob), size: blob.size }]);
      },
    });
    meshRef.current = mesh;
    mesh.initMedia().then((s) => {
      setLocalStream(s);
      setMicOn(s.getAudioTracks().some((t) => t.enabled));
      setCamOn(s.getVideoTracks().some((t) => t.enabled));
    });

    const unRoom = api.watchRoom(roomId, async (r) => {
      if (!r) return onExit('Room self-destructed — all data purged.');
      setRoom(r);
      // Witnessed expiry → I perform the sweep (idempotent across clients).
      if (r.ttlMs && Date.now() - r.lastActivity >= r.ttlMs) {
        await api.purgeRoom(roomId);
        return; // next snapshot reports !exists → exit above
      }
      // Force re-auth: I'm in the pending list and the deadline passed → self-kick.
      const pending = r.reauthDeadline && (r.reauthPending || []).includes(clientId);
      if (pending && Date.now() >= r.reauthDeadline) {
        await api.leaveRoom(roomId);
        return onExit('Re-authentication expired — you were removed.');
      }
      setReauth(pending ? { deadline: r.reauthDeadline } : null);
    });

    const unMembers = api.watchMembers(roomId, (list) => {
      const active = list.filter((m) => Date.now() - m.lastSeen < 90_000);
      setMembers(active);
      const me = active.find((m) => m.id === clientId);
      if (me) {
        wasMemberRef.current = true;
        // The newer member initiates offers to everyone older — no glare.
        for (const m of active) {
          if (m.id !== clientId && m.joinedAt < me.joinedAt && !mesh.peers.has(m.id)) mesh.call(m.id);
        }
      } else if (wasMemberRef.current) {
        return onExit('You were removed from the room.');
      }
      for (const id of [...mesh.peers.keys()]) {
        if (!active.find((m) => m.id === id)) mesh.dropPeer(id);
      }
    });

    const unMessages = api.watchMessages(roomId, setMessages);
    const unSignals = api.watchSignals(roomId, ({ from, data }) => mesh.handleSignal(from, data));

    // Presence heartbeat (member freshness) + activity ping (resets TTL).
    const hb = setInterval(() => api.memberHeartbeat(roomId), 20_000);
    let lastPing = 0;
    const ping = () => {
      const t = Date.now();
      if (t - lastPing > 15_000) {
        lastPing = t;
        api.touch(roomId);
      }
    };
    window.addEventListener('pointermove', ping);
    window.addEventListener('keydown', ping);
    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      clearInterval(hb);
      clearInterval(tick);
      window.removeEventListener('pointermove', ping);
      window.removeEventListener('keydown', ping);
      unRoom();
      unMembers();
      unMessages();
      unSignals();
      mesh.destroy();
      files.forEach((f) => URL.revokeObjectURL(f.url));
      api.leaveRoom(roomId); // safety net — explicit Leave calls it too
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  // ---- actions ----------------------------------------------------------------
  const sendMessage = () => {
    const text = draft.trim();
    if (!text) return;
    api.sendMessage(roomId, session.name, text);
    setDraft('');
  };

  const toggleMic = () => {
    const next = !micOn;
    meshRef.current?.setTrackEnabled('audio', next);
    setMicOn(next);
    api.touch(roomId);
  };
  const toggleCam = () => {
    const next = !camOn;
    meshRef.current?.setTrackEnabled('video', next);
    setCamOn(next);
    api.touch(roomId);
  };

  const regenerate = async (forceReauth) => {
    const newCode = await api.regenerateCode(roomId, forceReauth, members.map((m) => m.id));
    setBanner(
      forceReauth ? `Code rotated — members must re-authenticate: ${newCode}` : `New code: ${newCode}`
    );
    setTimeout(() => setBanner(''), 8000);
  };

  const submitReauth = async () => {
    const res = await api.submitReauth(roomId, reauthCode);
    if (res?.error) return setReauthError(res.error);
    setReauth(null);
    setReauthCode('');
    setReauthError('');
  };

  const endRoom = async () => {
    await api.purgeRoom(roomId);
    onExit('You ended the room — all data purged.');
  };

  const leave = async () => {
    await api.leaveRoom(roomId);
    onExit(
      '',
      isDm
        ? { kind: 'dm' }
        : {
            kind: 'room',
            roomId,
            roomName: room?.name || session.roomName,
            code: room?.code || session.code,
            canDelete: isHost,
          }
    );
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    for (const f of e.dataTransfer.files) meshRef.current?.sendFile(f);
    api.touch(roomId);
  };

  const expiresAt = room?.ttlMs ? room.lastActivity + room.ttlMs : session.expiresAt;
  const remaining = expiresAt ? expiresAt - now : null;
  const code = room?.code || session.code;

  return (
    <div className="room">
      <header>
        <div className="brand">privet <span className="badge">EPHEMERAL</span></div>
        <span className="room-name">{room?.name || session.roomName}</span>
        {isDm ? (
          <span className="code dm-tag">direct message · no host</span>
        ) : (
          <button className="code" title="Click to copy" onClick={() => navigator.clipboard?.writeText(code)}>
            CODE {isHost ? code : '••••••'}
          </button>
        )}
        {isDm ? (
          <div className="countdown" title="Data is purged when both sides leave">data purges when both leave</div>
        ) : (
          <div className={`countdown ${remaining != null && remaining < 30_000 ? 'danger' : ''}`} title="Time until self-destruct">
            self-destruct {remaining != null ? fmt(remaining) : '—'}
          </div>
        )}
        <button className="leave" onClick={leave}>Leave</button>
      </header>

      {banner && <div className="banner">{banner}</div>}

      <main>
        <section className="stage">
          <div className="grid">
            {localStream && <VideoTile stream={localStream} label={`${session.name} (you)`} muted mirrored />}
            {[...streams.entries()].map(([id, stream]) => (
              <VideoTile key={id} stream={stream} label={members.find((m) => m.id === id)?.name || 'peer'} />
            ))}
            {streams.size === 0 && <div className="alone">You're alone — share the code to invite peers.</div>}
          </div>

          <div className="controls">
            <button onClick={toggleMic} className={micOn ? '' : 'off'}>{micOn ? 'Mute mic' : 'Unmute mic'}</button>
            <button onClick={toggleCam} className={camOn ? '' : 'off'}>{camOn ? 'Camera off' : 'Camera on'}</button>
            {isHost && (
              <>
                <button onClick={() => regenerate(false)}>Rotate code</button>
                <button onClick={() => regenerate(true)} className="warn">Rotate + force re-auth</button>
                <button onClick={endRoom} className="warn">End room</button>
              </>
            )}
          </div>

          <ul className="members">
            {members.map((m) => (
              <li key={m.id}>
                {m.name} {m.uid === room?.hostUid && <em>(host)</em>} {m.id === clientId && <em>(you)</em>}
                {isHost && m.id !== clientId && (
                  <button className="kick" onClick={() => api.kickMember(roomId, m.id)}>kick</button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section
          className={`chat ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="messages">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.authorId === clientId ? 'mine' : ''}`}>
                <div className="msg-body">
                  <b>{m.name}</b> <span>{m.text}</span>
                </div>
                <div className="msg-tools">
                  {EMOJIS.map((e) => (
                    <button key={e} className="react-btn" onClick={() => api.reactMessage(roomId, m.id, e)}>{e}</button>
                  ))}
                  {m.authorId === clientId && (
                    <button className="del-btn" title="Delete message" onClick={() => api.deleteMessage(roomId, m.id)}>×</button>
                  )}
                </div>
                {m.reactions && Object.keys(m.reactions).length > 0 && (
                  <div className="reactions">
                    {Object.entries(m.reactions).map(([e, n]) => (
                      <span key={e} className="reaction-chip">{e} {n}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {messages.length === 0 && <div className="hint">No messages yet. This history will vanish when the room dies.</div>}
            <div ref={chatEndRef} />
          </div>

          {transfers.size > 0 && (
            <div className="transfers">
              {[...transfers.values()].map((t) => (
                <div key={t.key} className="transfer">
                  <span>{t.dir === 'in' ? '↓' : '↑'} {t.name}</span>
                  <progress value={t.received} max={t.total} />
                </div>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="files">
              {files.map((f) => (
                <a key={f.key} href={f.url} download={f.name}>⬇ {f.name} ({Math.ceil(f.size / 1024)} KB)</a>
              ))}
            </div>
          )}

          <div className="composer">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              placeholder="Message… or drop a file anywhere here (P2P)"
            />
            <button onClick={sendMessage}>Send</button>
          </div>
          <div className="hint">Drag &amp; drop files — they transfer peer-to-peer, never touching Firestore.</div>
        </section>
      </main>

      {reauth && (
        <div className="modal">
          <div className="modal-card">
            <h2>Re-authentication required</h2>
            <p>The host rotated the access code. Enter the <b>new</b> code within {fmt(reauth.deadline - now)} or you'll be removed.</p>
            <input
              className="code-input"
              value={reauthCode}
              onChange={(e) => setReauthCode(e.target.value.toUpperCase())}
              maxLength={6}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && submitReauth()}
            />
            {reauthError && <div className="error">{reauthError}</div>}
            <button onClick={submitReauth}>Verify</button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { socket } from '../lib/socket.js';
import { Mesh } from '../lib/mesh.js';

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
  const [members, setMembers] = useState(session.members);
  const [messages, setMessages] = useState([]);
  const [streams, setStreams] = useState(new Map()); // remoteId -> MediaStream
  const [localStream, setLocalStream] = useState(null);
  const [expiresAt, setExpiresAt] = useState(session.expiresAt);
  const [now, setNow] = useState(Date.now());
  const [code, setCode] = useState(session.code);
  const [hostToken, setHostToken] = useState(session.hostToken);
  const [hostId, setHostId] = useState(session.hostId);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [reauth, setReauth] = useState(null); // { deadline }
  const [reauthCode, setReauthCode] = useState('');
  const [reauthError, setReauthError] = useState('');
  const [transfers, setTransfers] = useState(new Map()); // key -> {dir,name,received,total}
  const [files, setFiles] = useState([]); // received files {key,name,url}
  const [draft, setDraft] = useState('');
  const [banner, setBanner] = useState('');
  const [dragging, setDragging] = useState(false);

  const meshRef = useRef(null);
  const chatEndRef = useRef(null);
  const isHost = hostId === session.selfId;

  // ---- socket + WebRTC wiring -------------------------------------------------
  useEffect(() => {
    const mesh = new Mesh({
      socket,
      onRemoteStream: (id, stream) => setStreams((p) => new Map(p).set(id, stream)),
      onPeerGone: (id) => setStreams((p) => { const n = new Map(p); n.delete(id); return n; }),
      onFileProgress: (t) => setTransfers((p) => new Map(p).set(t.key, t)),
      onFileReceived: ({ key, name, blob }) => {
        setTransfers((p) => { const n = new Map(p); n.delete(key); return n; });
        setFiles((p) => [...p, { key, name, url: URL.createObjectURL(blob), size: blob.size }]);
      },
    });
    meshRef.current = mesh;
    mesh.initMedia().then((s) => {
      setLocalStream(s);
      setMicOn(s.getAudioTracks().some((t) => t.enabled));
      setCamOn(s.getVideoTracks().some((t) => t.enabled));
    });

    const flash = (msg) => {
      setBanner(msg);
      setTimeout(() => setBanner(''), 4000);
    };

    const onJoined = ({ id, name }) => {
      setMembers((p) => [...p, { id, name, isHost: false }]);
      mesh.call(id); // existing member offers to the newcomer
      flash(`${name} joined`);
    };
    const onLeft = ({ id }) => {
      setMembers((p) => p.filter((m) => m.id !== id));
      mesh.dropPeer(id);
    };
    const onSignal = ({ from, data }) => mesh.handleSignal(from, data);
    const onMsg = (m) => setMessages((p) => [...p.slice(-199), m]);
    const onDeleted = ({ id }) => setMessages((p) => p.filter((m) => m.id !== id));
    const onReaction = ({ id, emoji }) =>
      setMessages((p) =>
        p.map((m) =>
          m.id === id ? { ...m, reactions: { ...m.reactions, [emoji]: (m.reactions?.[emoji] || 0) + 1 } } : m
        )
      );
    const onExpires = ({ expiresAt }) => setExpiresAt(expiresAt);
    const onDestroyed = ({ reason }) =>
      onExit(
        reason === 'inactivity'
          ? 'Room self-destructed after inactivity — all state purged.'
          : reason === 'host-ended'
            ? 'The host ended the room — all state purged.'
            : 'Room closed — all state purged.'
      );
    const onKicked = () => onExit('You were removed from the room.');
    const onReauth = ({ deadline }) => setReauth({ deadline });
    const onHostChanged = ({ hostId }) => setHostId(hostId);
    const onYouAreHost = ({ hostToken }) => {
      setHostToken(hostToken);
      flash('You are now the host.');
    };

    socket.on('room:member-joined', onJoined);
    socket.on('room:member-left', onLeft);
    socket.on('webrtc:signal', onSignal);
    socket.on('chat:message', onMsg);
    socket.on('chat:deleted', onDeleted);
    socket.on('chat:reaction', onReaction);
    socket.on('room:expires', onExpires);
    socket.on('room:destroyed', onDestroyed);
    socket.on('room:kicked', onKicked);
    socket.on('room:reauth-required', onReauth);
    socket.on('room:host-changed', onHostChanged);
    socket.on('room:you-are-host', onYouAreHost);

    // "Active presence": real interaction (throttled) resets the inactivity timer.
    let lastPing = 0;
    const ping = () => {
      const t = Date.now();
      if (t - lastPing > 15_000) {
        lastPing = t;
        socket.emit('room:activity');
      }
    };
    window.addEventListener('pointermove', ping);
    window.addEventListener('keydown', ping);

    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      clearInterval(tick);
      window.removeEventListener('pointermove', ping);
      window.removeEventListener('keydown', ping);
      socket.off('room:member-joined', onJoined);
      socket.off('room:member-left', onLeft);
      socket.off('webrtc:signal', onSignal);
      socket.off('chat:message', onMsg);
      socket.off('chat:deleted', onDeleted);
      socket.off('chat:reaction', onReaction);
      socket.off('room:expires', onExpires);
      socket.off('room:destroyed', onDestroyed);
      socket.off('room:kicked', onKicked);
      socket.off('room:reauth-required', onReauth);
      socket.off('room:host-changed', onHostChanged);
      socket.off('room:you-are-host', onYouAreHost);
      mesh.destroy();
      files.forEach((f) => URL.revokeObjectURL(f.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  // ---- actions ----------------------------------------------------------------
  const sendMessage = () => {
    const text = draft.trim();
    if (!text) return;
    socket.emit('chat:message', { text });
    setDraft('');
  };

  const deleteMessage = (id) => socket.emit('chat:delete', { id });
  const react = (id, emoji) => socket.emit('chat:react', { id, emoji });

  const toggleMic = () => {
    const next = !micOn;
    meshRef.current?.setTrackEnabled('audio', next);
    setMicOn(next);
    socket.emit('room:activity');
  };
  const toggleCam = () => {
    const next = !camOn;
    meshRef.current?.setTrackEnabled('video', next);
    setCamOn(next);
    socket.emit('room:activity');
  };

  const regenerate = (forceReauth) =>
    socket.emit('room:regenerate-code', { hostToken, forceReauth }, (res) => {
      if (res?.error) return setBanner(res.error);
      setCode(res.code);
      setBanner(forceReauth ? `Code rotated — members must re-authenticate: ${res.code}` : `New code: ${res.code}`);
    });

  const kick = (targetId) => socket.emit('room:kick', { hostToken, targetId }, () => {});
  const endRoom = () => socket.emit('room:end', { hostToken });
  const leave = () => {
    socket.emit('room:leave');
    onExit('', {
      roomId: session.roomId,
      roomName: session.roomName,
      code: session.code,
      hostToken,
      isHost,
      kind: session.kind || 'room',
      expiresAt,
    });
  };

  const submitReauth = () =>
    socket.emit('room:reauth', { code: reauthCode }, (res) => {
      if (res?.error) return setReauthError(res.error);
      setReauth(null);
      setReauthCode('');
      setReauthError('');
    });

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    for (const f of e.dataTransfer.files) meshRef.current?.sendFile(f);
    socket.emit('room:activity');
  };

  const remaining = expiresAt - now;

  return (
    <div className="room">
      <header>
        <div className="brand">privet <span className="badge">EPHEMERAL</span></div>
        <span className="room-name">{session.roomName}</span>
        {session.kind === 'dm' ? (
          <span className="code dm-tag">direct message · no host</span>
        ) : (
          <button className="code" title="Click to copy" onClick={() => navigator.clipboard?.writeText(code)}>
            CODE {isHost ? code : '••••••'}
          </button>
        )}
        {session.kind === 'dm' ? (
          <div className="countdown" title="Data is purged when both sides leave">data purges when both leave</div>
        ) : (
          <div className={`countdown ${remaining < 30_000 ? 'danger' : ''}`} title="Time until self-destruct">
            self-destruct {fmt(remaining)}
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
              <VideoTile key={id} stream={stream} label={members.find((m) => m.id === id)?.name || id.slice(0, 5)} />
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
                {m.name} {m.id === hostId && <em>(host)</em>} {m.id === session.selfId && <em>(you)</em>}
                {isHost && m.id !== session.selfId && (
                  <button className="kick" onClick={() => kick(m.id)}>kick</button>
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
              <div key={m.id} className={`msg ${m.from === session.selfId ? 'mine' : ''}`}>
                <div className="msg-body">
                  <b>{m.name}</b> <span>{m.text}</span>
                </div>
                <div className="msg-tools">
                  {EMOJIS.map((e) => (
                    <button key={e} className="react-btn" onClick={() => react(m.id, e)}>{e}</button>
                  ))}
                  {m.from === session.selfId && (
                    <button className="del-btn" title="Delete message" onClick={() => deleteMessage(m.id)}>×</button>
                  )}
                </div>
                {m.reactions && (
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
          <div className="hint">Drag &amp; drop files — they transfer peer-to-peer, never touching the server.</div>
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

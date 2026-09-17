import { useState } from 'react';
import { socket } from '../lib/socket.js';
import { track } from '../lib/firebase.js';
import ChatLog from './ChatLog.jsx';

export default function Home({ user, onJoined, notice, chatLog = [], onOpenEntry, onRemoveEntry }) {
  const [name, setName] = useState(user.username);
  const [roomName, setRoomName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = (event, payload, extra) => {
    if (busy) return;
    setBusy(true);
    setError('');
    socket.timeout(5000).emit(event, { ...payload, token: user.token }, (err, res) => {
      setBusy(false);
      if (err || res?.error) return setError(res?.error || 'Server unreachable.');
      track(event === 'room:create' ? 'room_create' : 'room_join');
      onJoined({ ...res, name: payload.name, isHost: res.selfId === res.hostId, hostToken: res.hostToken || null, ...extra });
    });
  };

  const create = () => submit('room:create', { name: name || user.username, roomName });
  const join = () => submit('room:join', { name: name || user.username, code });

  return (
    <div className="home-content">
      <div className="card">
        <h2 className="page-title">Rooms</h2>
        <p className="tagline">Create a private multi-person room or join one with an access code.</p>

        {notice && <div className="notice">{notice}</div>}
        {error && <div className="error">{error}</div>}

        <label>
          Display name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="username" maxLength={24} />
        </label>

        <div className="split">
          <section>
            <h2>Create a room</h2>
            <label>
              Room name <small>(optional)</small>
              <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="xyz" maxLength={40} />
            </label>
            <button className="primary" onClick={create} disabled={busy}>
              Generate access code
            </button>
          </section>

          <section>
            <h2>Join a room</h2>
            <label>
              Access code
              <input
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXXXX"
                maxLength={6}
                onKeyDown={(e) => e.key === 'Enter' && join()}
              />
            </label>
            <button className="primary" onClick={join} disabled={busy || code.length !== 6}>
              Enter room
            </button>
          </section>
        </div>
      </div>

      <ChatLog entries={chatLog} onOpen={onOpenEntry} onRemove={onRemoveEntry} />
    </div>
  );
}

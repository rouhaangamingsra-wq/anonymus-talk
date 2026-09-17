import { useState } from 'react';
import ChatLog from './ChatLog.jsx';

export default function Requests({ requests, onSend, onAccept, onDecline, chatLog, onOpenEntry, onRemoveEntry }) {
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const send = () => {
    const target = to.trim().toLowerCase();
    if (!target || busy) return;
    setBusy(true);
    setError('');
    onSend(target, (res) => {
      setBusy(false);
      if (res?.error) return setError(res.error);
      setTo('');
    });
  };

  return (
    <div className="settings">
      <h2>Chat requests</h2>

      <section className="settings-block">
        <h3>Start a DM</h3>
        <p className="tagline">
          Send a request by username. If they accept, you both enter a hostless 2-person room —
          either of you can leave anytime, and all data is gone the moment you're both offline.
        </p>
        {error && <div className="error">{error}</div>}
        <div className="composer inline">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="username"
            maxLength={20}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          <button className="primary" onClick={send} disabled={busy || !to.trim()}>
            Send request
          </button>
        </div>
      </section>

      <section className="settings-block">
        <h3>Incoming</h3>
        {requests.incoming.length === 0 && <p className="tagline">No pending requests.</p>}
        {requests.incoming.map((r) => (
          <div key={r.id} className="setting-row">
            <div>
              <b>{r.from}</b>
              <p>wants to start a DM with you</p>
            </div>
            <div className="row-actions">
              <button className="primary" onClick={() => onAccept(r.id)}>Accept</button>
              <button onClick={() => onDecline(r.id)}>Decline</button>
            </div>
          </div>
        ))}
      </section>

      <section className="settings-block">
        <h3>Outgoing</h3>
        {requests.outgoing.length === 0 && <p className="tagline">Nothing sent yet.</p>}
        {requests.outgoing.map((r) => (
          <div key={r.id} className="setting-row">
            <div>
              <b>{r.to}</b>
              <p>request pending…</p>
            </div>
            <span className="pill">waiting</span>
          </div>
        ))}
      </section>

      <ChatLog entries={chatLog} onOpen={onOpenEntry} onRemove={onRemoveEntry} />
    </div>
  );
}

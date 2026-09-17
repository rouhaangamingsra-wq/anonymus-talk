import { useEffect, useState } from 'react';

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Lists every conversation tied to your account: DMs (persistent, hostless,
// 2-person) and private rooms you left (multi-person, still counting down to
// self-destruct). "Remove" severs the link so nothing shows it existed.
export default function ChatLog({ entries, onOpen, onRemove }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const dmCount = entries.filter((e) => e.type === 'dm').length;
  const roomCount = entries.length - dmCount;

  return (
    <div className="card chatlog">
      <h2 className="page-title">Chat log</h2>
      <p className="tagline">
        {dmCount} direct {dmCount === 1 ? 'message' : 'messages'} · {roomCount}{' '}
        {roomCount === 1 ? 'room' : 'rooms'} left
      </p>

      {entries.length === 0 && <p className="tagline">Nothing yet — DMs and rooms you leave will appear here.</p>}

      {entries.map((e) => (
        <div key={e.roomId} className="log-row">
          <div className="log-info">
            <b>
              {e.type === 'dm' ? '◈ ' : '# '}
              {e.roomName}
            </b>
            <span>
              {e.type === 'dm'
                ? `DM · ${e.members ? `${e.members} online` : 'offline — data purged'}`
                : `self-destructs in ${e.expiresAt ? fmt(e.expiresAt - now) : '—'}`}
            </span>
          </div>
          <div className="row-actions">
            <button className="primary" onClick={() => onOpen(e)}>
              {e.type === 'dm' ? 'Open' : 'Rejoin'}
            </button>
            {e.type === 'room' && e.hostToken ? (
              <button className="warn" title="Destroy this room for everyone" onClick={() => onRemove(e)}>
                Delete
              </button>
            ) : (
              <button title="Remove from your account — no trace left" onClick={() => onRemove(e)}>
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

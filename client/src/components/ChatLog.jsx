import { useEffect, useState } from 'react';
import * as api from '../lib/db.js';

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Each entry watches its own room doc — live countdown, drops itself when the
// room is destroyed, and performs the purge when it witnesses expiry.
function Entry({ e, onOpen, onRemove }) {
  const [info, setInfo] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(
    () =>
      api.watchRoom(e.roomId, (r) => {
        if (!r) return onRemove(e); // destroyed — drop from the log
        if (r.ttlMs && Date.now() - r.lastActivity >= r.ttlMs) {
          api.purgeRoom(e.roomId); // I witnessed the expiry → I sweep it
          return;
        }
        setInfo(r);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [e.roomId]
  );

  const expiresAt = info?.ttlMs ? info.lastActivity + info.ttlMs : null;
  const inside = info?.memberCount ?? 0;

  return (
    <div className="log-row">
      <div className="log-info">
        <b>
          {e.type === 'dm' ? '◈ ' : '# '}
          {info?.name || e.roomName}
        </b>
        <span>
          {e.type === 'dm'
            ? `DM · ${inside > 0 ? `${inside} inside` : 'empty — data purged'}`
            : `self-destructs in ${expiresAt ? fmt(expiresAt - now) : '—'} · ${inside} inside`}
        </span>
      </div>
      <div className="row-actions">
        <button className="primary" onClick={() => onOpen(e)}>
          {e.type === 'dm' ? 'Open' : 'Rejoin'}
        </button>
        {e.type === 'room' && e.canDelete ? (
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
  );
}

// DMs (persistent, hostless, 2-person) and private rooms you left
// (multi-person, still counting down to self-destruct).
export default function ChatLog({ entries, onOpen, onRemove }) {
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
        <Entry key={e.roomId} e={e} onOpen={onOpen} onRemove={onRemove} />
      ))}
    </div>
  );
}

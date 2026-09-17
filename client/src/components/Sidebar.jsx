export default function Sidebar({ user, view, onNav, onLogout, requestCount = 0 }) {
  return (
    <aside className="sidebar">
      <div className="side-brand">
        privet <span className="badge">EPHEMERAL</span>
      </div>

      <nav className="side-nav">
        <button className={view === 'rooms' ? 'active' : ''} onClick={() => onNav('rooms')}>
          Rooms
        </button>
        <button className={view === 'requests' ? 'active' : ''} onClick={() => onNav('requests')}>
          Requests
          {requestCount > 0 && <span className="nav-badge">{requestCount}</span>}
        </button>
        <button className={view === 'settings' ? 'active' : ''} onClick={() => onNav('settings')}>
          Settings
        </button>
      </nav>

      <div className="side-user">
        <div className="avatar">{user.username[0].toUpperCase()}</div>
        <div className="side-user-info">
          <b>{user.username}</b>
          <span>anonymous session</span>
        </div>
        <button className="logout" onClick={onLogout} title="Log out">
          ⏻
        </button>
      </div>
    </aside>
  );
}

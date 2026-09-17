const ACCENTS = [
  { id: 'green', color: '#6ee7b7', label: 'Mint' },
  { id: 'blue', color: '#60a5fa', label: 'Sky' },
  { id: 'purple', color: '#a78bfa', label: 'Violet' },
  { id: 'amber', color: '#fbbf24', label: 'Amber' },
  { id: 'rose', color: '#fb7185', label: 'Rose' },
];

export default function Settings({ theme, setTheme, accent, setAccent }) {
  return (
    <div className="settings">
      <h2>Settings</h2>

      <section className="settings-block">
        <h3>Appearance</h3>
        <div className="setting-row">
          <div>
            <b>Theme</b>
            <p>Interface color scheme</p>
          </div>
          <div className="segmented">
            <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
              Dark
            </button>
            <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
              Light
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <b>Accent color</b>
            <p>Highlights, buttons, your name in chat</p>
          </div>
          <div className="swatches">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                className={`swatch ${accent === a.id ? 'active' : ''}`}
                style={{ background: a.color }}
                title={a.label}
                onClick={() => setAccent(a.id)}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="settings-block">
        <h3>Privacy</h3>
        <div className="setting-row">
          <div>
            <b>Ephemeral storage</b>
            <p>Rooms, messages and accounts live in memory only — gone when the server stops.</p>
          </div>
          <span className="pill">always on</span>
        </div>
      </section>
    </div>
  );
}

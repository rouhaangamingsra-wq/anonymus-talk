import { useState } from 'react';
import { login, register } from '../lib/api.js';
import { track } from '../lib/firebase.js';

export default function Auth({ onAuth }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await (mode === 'login' ? login : register)(username, password);
      if (res.error) setError(res.error);
      else {
        track(mode === 'login' ? 'login' : 'sign_up');
        onAuth(res); // { token, username, prefs }
      }
    } catch {
      setError('Server unreachable.');
    }
    setBusy(false);
  };

  return (
    <div className="home">
      <div className="card auth-card">
        <h1>
          privet<span className="badge">EPHEMERAL</span>
        </h1>
        <p className="tagline">
          Self-destructing private rooms. Accounts are anonymous — no email, wiped on restart.
        </p>

        <h2 className="auth-title">{mode === 'login' ? 'Log in to your account' : 'Create an account'}</h2>

        <p className="auth-note">⚠ Do not use your real name — pick an alias. This platform is built for anonymity.</p>

        {error && <div className="error">{error}</div>}

        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            maxLength={20}
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••"
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        <button className="primary" onClick={submit} disabled={busy || !username.trim() || password.length < 4}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <button className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? 'Need an account? Create one' : 'Have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}

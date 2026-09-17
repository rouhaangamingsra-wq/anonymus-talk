const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

async function post(path, body) {
  const r = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

export const register = (username, password) => post('/api/register', { username, password });
export const login = (username, password) => post('/api/login', { username, password });

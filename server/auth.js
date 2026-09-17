import crypto from 'node:crypto';

/**
 * AuthStore — anonymous, in-memory accounts.
 * No email, no database: usernames + scrypt-hashed passwords live in a Map and
 * vanish on server restart. A token maps back to a username for room joins.
 */
export class AuthStore {
  constructor() {
    this.users = new Map(); // username -> { salt, hash }
    this.tokens = new Map(); // token -> username
  }

  register(username, password) {
    const uname = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,20}$/.test(uname)) {
      return { error: 'Username must be 3–20 chars (a–z, 0–9, _ . -).' };
    }
    if (this.users.has(uname)) return { error: 'Username already taken.' };
    if (String(password || '').length < 4) return { error: 'Password must be at least 4 characters.' };
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 32);
    this.users.set(uname, { salt, hash, prefs: null });
    return this._issue(uname);
  }

  login(username, password) {
    const uname = String(username || '').trim().toLowerCase();
    const u = this.users.get(uname);
    if (!u) return { error: 'Unknown username — create an account first.' };
    const hash = crypto.scryptSync(String(password), u.salt, 32);
    if (!crypto.timingSafeEqual(hash, u.hash)) return { error: 'Wrong password.' };
    return this._issue(uname);
  }

  _issue(username) {
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, username);
    return { token, username, prefs: this.users.get(username)?.prefs || null };
  }

  // The ONLY thing we store per user besides credentials — theme choice.
  setPrefs(username, prefs) {
    const u = this.users.get(username);
    if (!u) return;
    u.prefs = {
      theme: String(prefs?.theme || '').slice(0, 10),
      accent: String(prefs?.accent || '').slice(0, 10),
    };
  }

  resolve(token) {
    return this.tokens.get(token);
  }
}

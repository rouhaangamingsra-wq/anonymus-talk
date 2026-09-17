import { useEffect, useRef, useState } from 'react';
import * as api from './lib/db.js';
import Auth from './components/Auth.jsx';
import Sidebar from './components/Sidebar.jsx';
import Home from './components/Home.jsx';
import Settings from './components/Settings.jsx';
import Requests from './components/Requests.jsx';
import Room from './components/Room.jsx';

export default function App() {
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem('privet_user'));
    } catch {
      return null;
    }
  });
  const [view, setView] = useState('rooms'); // 'rooms' | 'requests' | 'settings'
  const [session, setSession] = useState(null);
  const [notice, setNotice] = useState('');
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [chatLog, setChatLog] = useState([]); // {type:'room'|'dm', roomId, roomName, code?, canDelete?}
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [accent, setAccent] = useState(() => localStorage.getItem('accent') || 'green');

  const sessionRef = useRef(null);
  sessionRef.current = session;
  const userRef = useRef(null);
  userRef.current = user;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    localStorage.setItem('theme', theme);
    localStorage.setItem('accent', accent);
    // The only per-user data stored: theme preference.
    if (userRef.current) api.savePrefs(userRef.current.username, { theme, accent });
  }, [theme, accent]);

  const openDm = (snap) => {
    setChatLog((log) => [
      { type: 'dm', roomId: snap.roomId, roomName: snap.roomName },
      ...log.filter((e) => e.roomId !== snap.roomId),
    ]);
    if (!sessionRef.current) setSession({ ...snap, name: userRef.current.username, isHost: false });
    else setNotice(`${snap.roomName} is ready — open it from your chat log.`);
  };

  // Presence heartbeat + DM request listeners ----------------------------------
  useEffect(() => {
    if (!user) return;
    api.startPresence(user.username);

    const unIn = api.watchIncoming(user.username, (list) =>
      setRequests((r) => ({ ...r, incoming: list }))
    );
    const unOut = api.watchOutgoing(user.username, async (list) => {
      setRequests((r) => ({ ...r, outgoing: list.filter((x) => x.status === 'pending') }));
      for (const x of list) {
        if (x.status === 'accepted' && x.roomId) {
          api.deleteRequest(x.id);
          const res = await api.enterDm(x.roomId, userRef.current.username);
          if (!res.error) openDm(res);
        } else if (x.status === 'declined') {
          api.deleteRequest(x.id);
          setNotice(`${x.to} declined your chat request.`);
        }
      }
    });
    return () => {
      unIn();
      unOut();
      api.stopPresence();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ---- request actions -------------------------------------------------------
  const sendRequest = (to, cb) => api.sendRequest(user.username, to).then(cb).catch(() => cb({ error: 'Failed.' }));

  const acceptRequest = async (id) => {
    const res = await api.acceptRequest(id, user.username);
    if (res?.error) return setNotice(res.error);
    api.deleteRequest(id);
    openDm(res);
  };

  const declineRequest = (id) => api.declineRequest(id); // pending filter drops it

  // ---- chat log actions --------------------------------------------------------
  const openEntry = async (e) => {
    const res =
      e.type === 'dm'
        ? await api.enterDm(e.roomId, user.username)
        : await api.joinRoomById(e.roomId, user.username, e.code);
    if (res?.error) {
      setChatLog((l) => l.filter((x) => x.roomId !== e.roomId));
      return setNotice(res.error);
    }
    setSession({ ...res, name: user.username, isHost: res.hostUid === api.myUid() });
  };

  const removeEntry = (e) => {
    if (e.type === 'dm') api.removeDm(e.roomId, user.username); // sever participant link
    else if (e.canDelete) api.purgeRoom(e.roomId); // host: destroy for everyone
    setChatLog((l) => l.filter((x) => x.roomId !== e.roomId));
  };

  const handleAuth = (u) => {
    sessionStorage.setItem('privet_user', JSON.stringify(u));
    setUser(u);
    if (u.prefs?.theme) setTheme(u.prefs.theme);
    if (u.prefs?.accent) setAccent(u.prefs.accent);
  };

  const logout = () => {
    sessionStorage.removeItem('privet_user');
    setUser(null);
    setView('rooms');
    setChatLog([]);
    setRequests({ incoming: [], outgoing: [] });
  };

  if (!user) return <Auth onAuth={handleAuth} />;

  if (session) {
    return (
      <Room
        session={session}
        onExit={(reason, leftRoom) => {
          setSession(null);
          setNotice(reason);
          setView('rooms');
          if (leftRoom?.kind === 'room') {
            setChatLog((log) => [
              {
                type: 'room',
                roomId: leftRoom.roomId,
                roomName: leftRoom.roomName,
                code: leftRoom.code,
                canDelete: leftRoom.canDelete,
              },
              ...log.filter((e) => e.roomId !== leftRoom.roomId),
            ]);
          }
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <Sidebar user={user} view={view} onNav={setView} requestCount={requests.incoming.length} onLogout={logout} />
      <div className="app-main">
        {view === 'settings' ? (
          <Settings theme={theme} setTheme={setTheme} accent={accent} setAccent={setAccent} />
        ) : view === 'requests' ? (
          <Requests
            requests={requests}
            onSend={sendRequest}
            onAccept={acceptRequest}
            onDecline={declineRequest}
            chatLog={chatLog}
            onOpenEntry={openEntry}
            onRemoveEntry={removeEntry}
          />
        ) : (
          <Home
            user={user}
            onJoined={setSession}
            notice={notice}
            chatLog={chatLog}
            onOpenEntry={openEntry}
            onRemoveEntry={removeEntry}
          />
        )}
      </div>
    </div>
  );
}

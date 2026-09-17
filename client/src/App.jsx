import { useEffect, useRef, useState } from 'react';
import { socket } from './lib/socket.js';
import Auth from './components/Auth.jsx';
import Sidebar from './components/Sidebar.jsx';
import Home from './components/Home.jsx';
import Settings from './components/Settings.jsx';
import Requests from './components/Requests.jsx';
import Room from './components/Room.jsx';

export default function App() {
  const [user, setUser] = useState(null); // { token, username }
  const [view, setView] = useState('rooms'); // 'rooms' | 'requests' | 'settings'
  const [session, setSession] = useState(null);
  const [notice, setNotice] = useState('');
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [chatLog, setChatLog] = useState([]); // {type:'room'|'dm', roomId, roomName, code?, hostToken?, expiresAt?, members?}
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
    // Save theme pref on the account — the only per-user data the server keeps.
    if (userRef.current) {
      socket.emit('user:prefs', { token: userRef.current.token, prefs: { theme, accent } });
    }
  }, [theme, accent]);

  // Bind account to socket + global DM listeners ------------------------------
  useEffect(() => {
    if (!user) return;
    const identify = () => socket.emit('user:identify', { token: user.token });
    identify();
    socket.on('connect', identify);

    const addDmToLog = (snap) =>
      setChatLog((log) => {
        const rest = log.filter((e) => e.roomId !== snap.roomId);
        return [{ type: 'dm', roomId: snap.roomId, roomName: snap.roomName, members: snap.members.length }, ...rest];
      });

    const onIncoming = ({ id, from }) =>
      setRequests((r) => ({ ...r, incoming: [...r.incoming.filter((x) => x.id !== id), { id, from }] }));
    const onDeclined = ({ to }) => {
      setRequests((r) => ({ ...r, outgoing: r.outgoing.filter((x) => x.to !== to) }));
      setNotice(`${to} declined your chat request.`);
    };
    const onOpen = (snap) => {
      addDmToLog(snap);
      // Jump straight into the DM unless we're busy inside another room.
      if (!sessionRef.current) {
        setSession({ ...snap, name: userRef.current.username, isHost: false });
      } else {
        setNotice(`${snap.roomName} is ready — open it from your chat log.`);
      }
    };

    socket.on('dm:incoming', onIncoming);
    socket.on('dm:declined', onDeclined);
    socket.on('dm:open', onOpen);
    return () => {
      socket.off('connect', identify);
      socket.off('dm:incoming', onIncoming);
      socket.off('dm:declined', onDeclined);
      socket.off('dm:open', onOpen);
    };
  }, [user]);

  // Poll room:status so chat-log countdowns stay live --------------------------
  useEffect(() => {
    if (!user || chatLog.length === 0) return;
    const poll = () =>
      socket.emit('room:status', { roomIds: chatLog.map((e) => e.roomId) }, (res) => {
        if (!Array.isArray(res)) return;
        setChatLog((log) =>
          log
            .map((e) => {
              const s = res.find((x) => x.roomId === e.roomId);
              return s?.exists ? { ...e, roomName: s.name, expiresAt: s.expiresAt, members: s.members } : null;
            })
            .filter(Boolean)
        );
      });
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [user, chatLog.length]);

  // ---- request actions --------------------------------------------------------
  const sendRequest = (to, cb) =>
    socket.emit('dm:request', { to }, (res) => {
      if (res?.ok) setRequests((r) => ({ ...r, outgoing: [...r.outgoing, { id: res.id, to: res.to }] }));
      cb?.(res);
    });
  const acceptRequest = (id) =>
    socket.emit('dm:accept', { id }, (res) => {
      setRequests((r) => ({ ...r, incoming: r.incoming.filter((x) => x.id !== id) }));
      if (res && !res.error) {
        setSession({ ...res, name: user.username, isHost: false });
      }
    });
  const declineRequest = (id) => {
    socket.emit('dm:decline', { id }, () => {});
    setRequests((r) => ({ ...r, incoming: r.incoming.filter((x) => x.id !== id) }));
  };

  // ---- chat log actions ---------------------------------------------------------
  const openEntry = (entry) => {
    if (entry.type === 'dm') {
      socket.emit('dm:enter', { roomId: entry.roomId }, (res) => {
        if (res?.error) return setChatLog((l) => l.filter((e) => e.roomId !== entry.roomId));
        setSession({ ...res, name: user.username, isHost: false });
      });
    } else {
      socket.emit('room:join', { code: entry.code, name: user.username, token: user.token }, (res) => {
        if (res?.error) return setChatLog((l) => l.filter((e) => e.roomId !== entry.roomId));
        setSession({ ...res, name: user.username, isHost: res.selfId === res.hostId, hostToken: entry.hostToken });
      });
    }
  };
  const removeEntry = (entry) => {
    if (entry.type === 'dm') {
      // Sever the participant link server-side — no trace on your account.
      socket.emit('dm:remove', { roomId: entry.roomId });
    } else if (entry.hostToken) {
      // Host: destroy the room for everyone.
      socket.emit('room:end', { roomId: entry.roomId, hostToken: entry.hostToken });
    }
    // Otherwise it's just dropped from your view — nothing ties you to it.
    setChatLog((l) => l.filter((e) => e.roomId !== entry.roomId));
  };

  const handleAuth = (u) => {
    setUser(u);
    if (u.prefs?.theme) setTheme(u.prefs.theme);
    if (u.prefs?.accent) setAccent(u.prefs.accent);
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
          if (leftRoom?.kind !== 'dm' && leftRoom) {
            setChatLog((log) => [
              {
                type: 'room',
                roomId: leftRoom.roomId,
                roomName: leftRoom.roomName,
                code: leftRoom.code,
                hostToken: leftRoom.hostToken,
                expiresAt: leftRoom.expiresAt,
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
      <Sidebar
        user={user}
        view={view}
        onNav={setView}
        requestCount={requests.incoming.length}
        onLogout={() => {
          setUser(null);
          setView('rooms');
          setChatLog([]);
          setRequests({ incoming: [], outgoing: [] });
        }}
      />
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

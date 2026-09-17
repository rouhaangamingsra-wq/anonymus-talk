// Mesh — WebRTC full-mesh manager.
//
// The server is ONLY a signaling relay: SDP offers/answers and ICE candidates
// pass through `webrtc:signal` socket events. Once a peer connection is up,
// media tracks (mic/camera) and file bytes travel directly browser-to-browser.
// STUN (Google's public servers) lets peers discover their public IP:port so
// ICE can punch through NATs; on a LAN demo it resolves to host candidates.

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }];
const CHUNK = 16 * 1024;
const MAX_BUFFERED = 1024 * 1024;

export class Mesh {
  constructor({ socket, onRemoteStream, onPeerGone, onFileProgress, onFileReceived }) {
    Object.assign(this, { socket, onRemoteStream, onPeerGone, onFileProgress, onFileReceived });
    this.peers = new Map(); // remoteSocketId -> { pc, dc, stream, iceQueue }
    this.incoming = new Map(); // `${from}:${fileId}` -> { meta, chunks, received }
    this.localStream = null;
  }

  async initMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch {
      // Camera/mic denied or absent — still join with an empty stream (chat works).
      this.localStream = new MediaStream();
    }
    return this.localStream;
  }

  // Called by an EXISTING member when a newcomer joins: we initiate the offer.
  call(remoteId) {
    this._peer(remoteId, true);
  }

  _peer(remoteId, initiator) {
    if (this.peers.has(remoteId)) return this.peers.get(remoteId);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { pc, dc: null, stream: new MediaStream(), iceQueue: [] };
    this.peers.set(remoteId, peer);

    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream));

    pc.ontrack = (e) => {
      peer.stream.addTrack(e.track);
      this.onRemoteStream?.(remoteId, peer.stream);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('webrtc:signal', { to: remoteId, data: { candidate } });
    };
    pc.ondatachannel = (e) => this._setupChannel(remoteId, e.channel);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.dropPeer(remoteId);
    };

    if (initiator) {
      this._setupChannel(remoteId, pc.createDataChannel('file'));
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() =>
          this.socket.emit('webrtc:signal', { to: remoteId, data: { description: pc.localDescription } })
        );
    }
    return peer;
  }

  async handleSignal(from, { description, candidate } = {}) {
    const peer = this._peer(from, false);
    if (description) {
      await peer.pc.setRemoteDescription(description);
      for (const c of peer.iceQueue.splice(0)) {
        await peer.pc.addIceCandidate(c).catch(() => {});
      }
      if (description.type === 'offer') {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.socket.emit('webrtc:signal', { to: from, data: { description: peer.pc.localDescription } });
      }
    } else if (candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate).catch(() => {});
      else peer.iceQueue.push(candidate); // arrived before the offer — queue it
    }
  }

  // ---- P2P file transfer over RTCDataChannel --------------------------------
  _setupChannel(remoteId, dc) {
    const peer = this.peers.get(remoteId);
    if (peer) peer.dc = dc;
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onmessage = (e) => this._onChannelMessage(remoteId, e.data);
  }

  _onChannelMessage(from, data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      const key = `${from}:${msg.id}`;
      if (msg.kind === 'file-meta') {
        this.incoming.set(key, { meta: msg, chunks: [], received: 0 });
        this.onFileProgress?.({ key, dir: 'in', name: msg.name, received: 0, total: msg.size });
      } else if (msg.kind === 'file-end') {
        const f = this.incoming.get(key);
        if (!f) return;
        this.incoming.delete(key);
        this.onFileReceived?.({ key, from, name: f.meta.name, blob: new Blob(f.chunks, { type: f.meta.type }) });
      }
    } else {
      // Binary chunk: belongs to the active incoming file from this peer
      // (sends are serialized per channel, so at most one is in flight).
      for (const [key, f] of this.incoming) {
        if (!key.startsWith(`${from}:`)) continue;
        f.chunks.push(data);
        f.received += data.byteLength;
        this.onFileProgress?.({ key, dir: 'in', name: f.meta.name, received: f.received, total: f.meta.size });
        break;
      }
    }
  }

  async sendFile(file) {
    const id = crypto.randomUUID();
    for (const [remoteId, peer] of this.peers) {
      const dc = peer.dc;
      if (!dc || dc.readyState !== 'open') continue;
      const key = `out:${remoteId}:${id}`;
      dc.send(JSON.stringify({ kind: 'file-meta', id, name: file.name, size: file.size, type: file.type }));
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        if (dc.bufferedAmount > MAX_BUFFERED) await this._waitDrain(dc);
        const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
        dc.send(buf);
        this.onFileProgress?.({ key, dir: 'out', name: file.name, received: offset + buf.byteLength, total: file.size });
      }
      dc.send(JSON.stringify({ kind: 'file-end', id }));
    }
    return id;
  }

  _waitDrain(dc) {
    return new Promise((res) => {
      const h = () => {
        dc.removeEventListener('bufferedamountlow', h);
        res();
      };
      dc.addEventListener('bufferedamountlow', h);
    });
  }

  setTrackEnabled(kind, enabled) {
    this.localStream?.getTracks().filter((t) => t.kind === kind).forEach((t) => (t.enabled = enabled));
  }

  dropPeer(remoteId) {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(remoteId);
    this.onPeerGone?.(remoteId);
  }

  destroy() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}

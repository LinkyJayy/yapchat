// Voice & video over WebRTC (mesh). Signaling goes through the Socket.IO server.
import { $, el, esc, toast, errToast } from '../dom.js';
import { icon } from '../icons.js';
import { state, on, emit, displayName, getUser, channelById, dmName } from '../store.js';
import { socket } from '../realtime.js';
import { avatarHtml } from './components.js';
import { playSound, stopRing } from '../notifications.js';
import { navigate, channelPath } from '../router.js';

const PREFS_KEY = 'yapper_voice';
let prefsCache = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; } })();
export const prefs = () => prefsCache;
export function setPrefs(p) {
  prefsCache = { ...prefsCache, ...p };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefsCache)); } catch { /* ignore */ }
  if (('inputId' in p || 'echoCancellation' in p || 'noiseSuppression' in p || 'autoGainControl' in p) && cur) restartMic();
  if ('outputId' in p) document.querySelectorAll('#audio-sinks audio').forEach((a) => a.setSinkId?.(p.outputId || '').catch(() => {}));
  if ('mode' in p) applyMute();
  emit('voice_prefs');
}

let cur = null;
// cur = { channelId, connecting, mySocket, ice, peers: Map(socketId -> peer), mic, cam, screen, self }
const speaking = new Set();
export const isSpeaking = (userId) => speaking.has(userId);
export const current = () => cur && {
  channelId: cur.channelId, connecting: cur.connecting, video: !!cur.cam, screen: !!cur.screen,
};

let audioCtx = null;
const ctx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());

function micConstraints() {
  const p = prefsCache;
  return {
    audio: {
      deviceId: p.inputId ? { exact: p.inputId } : undefined,
      echoCancellation: p.echoCancellation !== false,
      noiseSuppression: p.noiseSuppression !== false,
      autoGainControl: p.autoGainControl !== false,
    },
  };
}

// ---------- Speaking detection ----------
const meters = new Map(); // key -> stop()
function watchLevel(key, stream, userId) {
  meters.get(key)?.();
  if (!stream.getAudioTracks().length) return;
  try {
    const src = ctx().createMediaStreamSource(stream);
    const an = ctx().createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let on_ = false, last = 0;
    const iv = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      const rms = Math.sqrt(sum / buf.length) / 128;
      const now = Date.now();
      const muted = userId === state.user.id && (prefsCache.muted || !cur?.mic?.getAudioTracks()[0]?.enabled);
      const talking = rms > 0.04 && !muted;
      if (talking) last = now;
      const next = talking || now - last < 300;
      if (next !== on_) {
        on_ = next;
        next ? speaking.add(userId) : speaking.delete(userId);
        emit('speaking', userId);
      }
    }, 80);
    meters.set(key, () => { clearInterval(iv); src.disconnect(); speaking.delete(userId); emit('speaking', userId); });
  } catch { /* ignore */ }
}

// ---------- Peers ----------
function makePeer(socketId, userId) {
  const pc = new RTCPeerConnection({ iceServers: cur.ice });
  const peer = { pc, userId, socketId, polite: cur.mySocket < socketId, makingOffer: false, ignoreOffer: false, streams: new Map() };
  cur.peers.set(socketId, peer);
  const send = (data) => socket.emit('voice_signal', { to: socketId, data });
  pc.onicecandidate = (e) => { if (e.candidate) send({ candidate: e.candidate }); };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send({ description: pc.localDescription });
    } catch (e) { console.warn(e); } finally { peer.makingOffer = false; }
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    peer.streams.set(stream.id, stream);
    if (e.track.kind === 'audio') attachAudio(peer, stream);
    e.track.onended = () => { emit('voice_media'); };
    stream.onremovetrack = () => { if (!stream.getTracks().length) peer.streams.delete(stream.id); emit('voice_media'); };
    emit('voice_media');
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce?.();
  };
  for (const s of [cur.mic, cur.cam, cur.screen]) if (s) for (const t of s.getTracks()) pc.addTrack(t, s);
  if (!cur.mic) pc.addTransceiver('audio', { direction: 'recvonly' });
  return peer;
}

function attachAudio(peer, stream) {
  const sinks = document.getElementById('audio-sinks');
  let a = sinks.querySelector(`audio[data-s="${peer.socketId}-${stream.id}"]`);
  if (!a) {
    a = document.createElement('audio');
    a.dataset.s = `${peer.socketId}-${stream.id}`;
    a.dataset.peer = peer.socketId;
    a.autoplay = true;
    sinks.append(a);
  }
  a.srcObject = stream;
  a.muted = !!prefsCache.deafened;
  if (prefsCache.outputId) a.setSinkId?.(prefsCache.outputId).catch(() => {});
  a.play().catch(() => {});
  watchLevel(`peer:${peer.socketId}:${stream.id}`, stream, peer.userId);
}

async function onSignal({ from, user_id, data }) {
  if (!cur) return;
  let peer = cur.peers.get(from);
  if (!peer) peer = makePeer(from, user_id);
  const { pc } = peer;
  try {
    if (data.description) {
      const offerCollision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('voice_signal', { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) console.warn(e); }
    }
  } catch (e) { console.warn('signal error', e); }
}

function closePeer(socketId) {
  const p = cur?.peers.get(socketId);
  if (!p) return;
  p.pc.close();
  cur.peers.delete(socketId);
  document.querySelectorAll(`#audio-sinks audio[data-peer="${socketId}"]`).forEach((a) => a.remove());
  for (const [k, stop] of meters) if (k.startsWith(`peer:${socketId}:`)) { stop(); meters.delete(k); }
  emit('voice_media');
}

// ---------- Join / leave ----------
export async function join(channelId, { video = false } = {}) {
  if (!socket?.connected) return toast("You're offline.", 'error');
  if (cur?.channelId === channelId) return;
  if (cur) leave(true);
  stopRing();
  cur = { channelId, connecting: true, peers: new Map(), mic: null, cam: null, screen: null, mySocket: socket.id, ice: [] };
  emit('voice_changed');
  try {
    cur.mic = await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch {
    toast("Couldn't access your microphone — you joined listen-only.", 'error');
  }
  if (!cur || cur.channelId !== channelId) { cur?.mic?.getTracks().forEach((t) => t.stop()); return; }
  ctx().resume?.();
  socket.emit('voice_join', channelId, (res) => {
    if (!cur || cur.channelId !== channelId) return;
    if (!res || res.error) { toast(res?.error || 'Could not join voice.', 'error'); cleanup(); return; }
    cur.ice = res.ice_servers;
    cur.self = res.self;
    cur.connecting = false;
    cur.mySocket = socket.id;
    if (cur.mic) watchLevel('local', cur.mic, state.user.id);
    applyMute();
    for (const p of res.peers) makePeer(p.socket_id, p.user_id);
    playSound('join');
    emit('voice_changed');
    if (video) toggleVideo();
  });
}

export function leave(silent = false) {
  if (!cur) return;
  socket?.emit('voice_leave');
  if (!silent) playSound('leave');
  cleanup();
}

function cleanup() {
  if (!cur) return;
  for (const id of [...cur.peers.keys()]) closePeer(id);
  for (const s of [cur.mic, cur.cam, cur.screen]) s?.getTracks().forEach((t) => t.stop());
  for (const stop of meters.values()) stop();
  meters.clear();
  speaking.clear();
  cur = null;
  emit('voice_changed');
  emit('voice_media');
}

async function restartMic() {
  if (!cur) return;
  try {
    const fresh = await navigator.mediaDevices.getUserMedia(micConstraints());
    const track = fresh.getAudioTracks()[0];
    const old = cur.mic;
    for (const p of cur.peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(track);
      else p.pc.addTrack(track, fresh);
    }
    old?.getTracks().forEach((t) => t.stop());
    cur.mic = fresh;
    watchLevel('local', fresh, state.user.id);
    applyMute();
  } catch (e) { errToast(e); }
}

// ---------- Controls ----------
let pttDown = false;
function applyMute() {
  const t = cur?.mic?.getAudioTracks()[0];
  const ptt = prefsCache.mode === 'ptt';
  const enabled = !prefsCache.muted && !prefsCache.deafened && !cur?.self?.server_muted && cur?.self?.can_speak !== false && (!ptt || pttDown);
  if (t) t.enabled = enabled;
  document.querySelectorAll('#audio-sinks audio').forEach((a) => { a.muted = !!prefsCache.deafened; });
  if (cur && !cur.connecting) socket.emit('voice_update', { muted: !!prefsCache.muted || !cur.mic, deafened: !!prefsCache.deafened });
}

export function toggleMute() {
  const p = { muted: !prefsCache.muted };
  if (!p.muted && prefsCache.deafened) p.deafened = false;
  setPrefs(p);
  applyMute();
  playSound(p.muted ? 'mute' : 'unmute');
}
export function toggleDeafen() {
  const d = !prefsCache.deafened;
  setPrefs({ deafened: d, muted: d ? prefsCache.muted : prefsCache.muted });
  applyMute();
  playSound(d ? 'mute' : 'unmute');
}

async function addStream(kind) {
  const stream = kind === 'cam'
    ? await navigator.mediaDevices.getUserMedia({ video: { deviceId: prefsCache.videoId ? { exact: prefsCache.videoId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } })
    : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  cur[kind] = stream;
  for (const p of cur.peers.values()) for (const t of stream.getTracks()) p.pc.addTrack(t, stream);
  stream.getVideoTracks()[0].onended = () => removeStream(kind);
  socket.emit('voice_update', { video: !!cur.cam, screen: !!cur.screen });
  emit('voice_changed');
  emit('voice_media');
}
function removeStream(kind) {
  const s = cur?.[kind];
  if (!s) return;
  for (const p of cur.peers.values()) for (const sender of p.pc.getSenders()) if (sender.track && s.getTracks().includes(sender.track)) p.pc.removeTrack(sender);
  s.getTracks().forEach((t) => t.stop());
  cur[kind] = null;
  socket.emit('voice_update', { video: !!cur.cam, screen: !!cur.screen });
  emit('voice_changed');
  emit('voice_media');
}
export async function toggleVideo() {
  if (!cur) return;
  if (cur.self && !cur.self.can_video) return toast("You don't have permission to use video here.", 'error');
  try { cur.cam ? removeStream('cam') : await addStream('cam'); } catch (e) { errToast(new Error(`Camera unavailable: ${e.message}`)); }
}
export async function toggleScreen() {
  if (!cur) return;
  if (!navigator.mediaDevices?.getDisplayMedia) return toast("Screen sharing isn't supported on this device.", 'error');
  if (cur.self && !cur.self.can_video) return toast("You don't have permission to share your screen here.", 'error');
  try { cur.screen ? removeStream('screen') : await addStream('screen'); } catch (e) { if (e.name !== 'NotAllowedError') errToast(e); }
}

export async function listDevices() {
  try {
    // Labels are only available after permission is granted.
    const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    const list = await navigator.mediaDevices.enumerateDevices();
    s?.getTracks().forEach((t) => t.stop());
    return list;
  } catch { return []; }
}

export async function micTest(onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints());
  const src = ctx().createMediaStreamSource(stream);
  const an = ctx().createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  const iv = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) ** 2;
    onLevel(Math.sqrt(sum / buf.length) / 128 * 4);
  }, 50);
  return () => { clearInterval(iv); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); };
}

// Push to talk on the backtick key.
document.addEventListener('keydown', (e) => {
  if (e.key === '`' && prefsCache.mode === 'ptt' && cur && !e.repeat && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { pttDown = true; applyMute(); }
});
document.addEventListener('keyup', (e) => { if (e.key === '`' && pttDown) { pttDown = false; applyMute(); } });

// ---------- Server events ----------
on('voice_snapshot', (list) => {
  state.voice.clear();
  for (const v of list) state.voice.set(v.channel_id, v.states);
  emit('voice_changed');
});
on('voice_states', ({ channel_id, states }) => {
  const prev = state.voice.get(channel_id) || [];
  if (states.length) state.voice.set(channel_id, states); else state.voice.delete(channel_id);
  if (cur?.channelId === channel_id) {
    const me = states.find((s) => s.socket_id === cur.mySocket);
    if (me) { const wasMuted = cur.self?.server_muted; cur.self = me; if (wasMuted !== me.server_muted) applyMute(); }
    if (states.length > prev.length && prev.length) playSound('join');
    else if (states.length < prev.length) playSound('leave');
  }
  // Stop ringing when the call ends.
  if (!states.length) stopRing();
  emit('voice_changed');
});
on('voice_signal', onSignal);
on('voice_peer_left', ({ socket_id }) => closePeer(socket_id));
on('voice_kicked', ({ reason }) => { if (cur) { toast(reason || 'Disconnected from voice.'); cleanup(); } });
on('voice_move', ({ channel_id }) => join(channel_id));
on('connection', (ok) => { if (!ok && cur) cleanup(); });

on('call_ring', ({ channel_id, caller }) => {
  if (cur?.channelId === channel_id || state.user.set_status === 'dnd') return;
  const ch = channelById(channel_id);
  const ring = el(`<div class="ring" role="alertdialog">${avatarHtml(caller, { size: 's40' })}
    <div class="grow"><b>${esc(caller.display_name || caller.username)}</b><div class="small muted">Incoming ${ch?.type === 'group' ? `group call · ${esc(dmName(ch))}` : 'call'}…</div></div>
    <button class="round-btn hang" data-no title="Decline">${icon('phoneOff')}</button><button class="round-btn accept" data-yes title="Accept">${icon('phone')}</button></div>`);
  document.getElementById('layers').append(ring);
  playSound('ring');
  const close = () => { ring.remove(); stopRing(); offStates(); };
  const timer = setTimeout(close, 30_000);
  const offStates = on('voice_states', ({ channel_id: c, states }) => { if (c === channel_id && !states.length) { clearTimeout(timer); close(); } });
  ring.onclick = (e) => {
    if (e.target.closest('[data-no]')) { clearTimeout(timer); close(); }
    if (e.target.closest('[data-yes]')) { clearTimeout(timer); close(); navigate(channelPath('@me', channel_id)); join(channel_id); }
  };
});

// ---------- Voice room view ----------
export function mountVoiceRoom(slot, ch, { compact = false } = {}) {
  const sid = ch.server_id || null;
  const root = el(`<div class="voice-room" ${compact ? 'style="max-height:55vh;min-height:300px"' : ''}>
    ${compact ? '' : `<header class="chat-header" style="background:#070b09;border-color:#1b2420;color:#fff"><button class="icon-btn menu-btn" data-nav>${icon('menu')}</button>
      <div class="title" style="color:#fff">${icon('volume')}<span>${esc(ch.name)}</span></div><div class="grow"></div></header>`}
    <div class="voice-grid"></div><div class="voice-bar"></div></div>`);
  slot.append(root);
  const grid = $('.voice-grid', root);
  const bar = $('.voice-bar', root);
  let focus = null;

  const tileKey = (userId, kind) => `${userId}:${kind}`;
  function render() {
    const inThis = cur?.channelId === ch.id;
    const states = state.voice.get(ch.id) || [];
    if (!inThis) {
      grid.innerHTML = `<div class="voice-empty" style="grid-column:1/-1;align-self:center">
        <h2 style="color:#fff;margin:0 0 8px">${esc(sid ? ch.name : dmName(ch))}</h2>
        <p>${states.length ? `${states.map((s) => esc(displayName(s.user_id, sid))).join(', ')} ${states.length === 1 ? 'is' : 'are'} here.` : 'No one is here yet.'}</p>
        <button class="btn" data-join>${icon('phone')} Join ${sid ? 'Voice' : 'Call'}</button></div>`;
      bar.innerHTML = '';
      return;
    }
    // Tiles: one per participant + one per video stream.
    const tiles = [];
    for (const s of states) {
      const me = s.user_id === state.user.id;
      const peer = me ? null : [...cur.peers.values()].find((p) => p.socketId === s.socket_id);
      const videoStreams = me ? [cur.cam && ['cam', cur.cam], cur.screen && ['screen', cur.screen]].filter(Boolean)
        : [...(peer?.streams.values() || [])].filter((st) => st.getVideoTracks().some((t) => t.readyState === 'live')).map((st, i) => [`v${i}`, st]);
      tiles.push({ key: tileKey(s.user_id, 'av'), s, stream: null });
      for (const [k, st] of videoStreams) tiles.push({ key: tileKey(s.user_id, `${k}-${st.id}`), s, stream: st, screen: k === 'screen' || (videoStreams.length > 1 && k !== 'v0') });
    }
    // Hide avatar tile when the user has a camera tile.
    const filtered = tiles.filter((t) => t.stream || !tiles.some((o) => o.s.user_id === t.s.user_id && o.stream && !o.screen));
    const existing = new Map([...grid.children].map((n) => [n.dataset.key, n]));
    const keep = new Set();
    for (const t of filtered) {
      keep.add(t.key);
      let node = existing.get(t.key);
      const u = getUser(t.s.user_id) || { id: t.s.user_id };
      const tag = `${t.s.muted || t.s.server_muted ? icon('micOff') : ''}${t.s.deafened ? icon('headphonesOff') : ''}${esc(displayName(t.s.user_id, sid))}${t.screen ? ' (screen)' : ''}`;
      if (!node) {
        node = el(`<div class="voice-tile" data-key="${t.key}" data-user="${t.s.user_id}">${t.stream ? '<video autoplay playsinline muted></video>' : avatarHtml(u)}<div class="tag"></div></div>`);
        if (t.stream) { const v = node.querySelector('video'); v.srcObject = t.stream; v.play().catch(() => {}); }
        grid.append(node);
      }
      node.querySelector('.tag').innerHTML = tag;
      node.classList.toggle('speaking', speaking.has(t.s.user_id));
      node.classList.toggle('focus', focus === t.key);
    }
    for (const [k, n] of existing) if (!keep.has(k)) n.remove();
    const p = prefsCache;
    bar.innerHTML = `
      <button class="round-btn ${p.muted ? 'off' : ''}" data-mute title="${p.muted ? 'Unmute' : 'Mute'}">${icon(p.muted ? 'micOff' : 'mic')}</button>
      <button class="round-btn ${p.deafened ? 'off' : ''}" data-deaf title="${p.deafened ? 'Undeafen' : 'Deafen'}">${icon(p.deafened ? 'headphonesOff' : 'headphones')}</button>
      <button class="round-btn ${cur.cam ? 'on' : ''}" data-video title="Camera">${icon(cur.cam ? 'video' : 'videoOff')}</button>
      <button class="round-btn ${cur.screen ? 'on' : ''}" data-screen title="Share Screen">${icon('screen')}</button>
      <button class="round-btn hang" data-leave title="Disconnect">${icon('phoneOff')}</button>`;
  }
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-nav]')) return emit('open_nav');
    if (e.target.closest('[data-join]')) return join(ch.id);
    if (e.target.closest('[data-mute]')) { toggleMute(); return render(); }
    if (e.target.closest('[data-deaf]')) { toggleDeafen(); return render(); }
    if (e.target.closest('[data-video]')) return toggleVideo();
    if (e.target.closest('[data-screen]')) return toggleScreen();
    if (e.target.closest('[data-leave]')) return leave();
    const tile = e.target.closest('.voice-tile');
    if (tile) { focus = focus === tile.dataset.key ? null : tile.dataset.key; render(); }
  });
  const unsubs = [on('voice_changed', render), on('voice_media', render), on('voice_prefs', render), on('speaking', (uid) => {
    grid.querySelectorAll(`.voice-tile[data-user="${uid}"]`).forEach((n) => n.classList.toggle('speaking', speaking.has(uid)));
    document.querySelectorAll(`.voice-user[data-user="${uid}"] .avatar`).forEach((n) => n.classList.toggle('speaking', speaking.has(uid)));
  })];
  render();
  return { destroy: () => unsubs.forEach((u) => u()) };
}

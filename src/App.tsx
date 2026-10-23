import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import "./App.css";

type CaptureSource = { id: string; name: string; thumbnail: string; displayId: string };
type RoomRole = "host" | "participant";
type RemotePeerStream = { peerId: string; stream: MediaStream };
type SignalPayload = { kind?: "offer" | "answer" | "candidate"; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type ServerMessage = { type: string; roomCode?: string; clientId?: string; participantId?: string; participantCount?: number; from?: string; payload?: SignalPayload; message?: string; maxParticipants?: number };
type TestState = { state: "idle" | "testing" | "ok" | "fail"; message: string };
type ThemeChoice = "dark" | "light" | "system";
type Quality = "economia" | "equilibrada" | "alta";

declare global {
  interface Window { telalink: { getSources: () => Promise<CaptureSource[]>; setTheme?: (theme: "dark" | "light") => Promise<void> } }
  interface ImportMetaEnv { readonly VITE_SIGNALING_URL?: string }
  interface ImportMeta { readonly env: ImportMetaEnv }
}

const DEFAULT_SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "ws://localhost:3001";
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
const MAX_VIEWERS = 5;
const URL_KEY = "telalink:signaling-url";
const VOLUME_KEY = "telalink:volume";
const MUTED_KEY = "telalink:muted";
const THEME_KEY = "telalink:theme";
const QUALITY_KEY = "telalink:quality";
// Cada espectador recebe um envio próprio: o consumo de internet e de processador cresce com o número de pessoas.
const QUALITY_PRESETS: Record<Quality, { label: string; desc: string; width: number; height: number; fps: number; bitrate: number }> = {
  economia: { label: "Economia", desc: "720p · 15 fps", width: 1280, height: 720, fps: 15, bitrate: 1_200_000 },
  equilibrada: { label: "Equilibrada", desc: "1080p · 30 fps", width: 1920, height: 1080, fps: 30, bitrate: 3_500_000 },
  alta: { label: "Alta", desc: "1080p · 60 fps", width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};
const AVATAR_COLORS = ["#3ba55c", "#faa61a", "#eb459e", "#ed4245", "#9b59b6", "#1abc9c"];

/* ---------- utilidades ---------- */
function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* armazenamento indisponível */ }
}
function isLocalUrl(url: string) {
  return /localhost|127\.0\.0\.1/.test(url);
}
// Aceita https://..., wss://..., ou só o domínio, e devolve um endereço WebSocket válido.
function normalizeServerUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  value = value.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  if (!/^wss?:\/\//i.test(value)) value = `${isLocalUrl(value) ? "ws" : "wss"}://${value}`;
  value = value.replace(/\/health\/?$/i, "").replace(/\/+$/, "");
  try { if (!new URL(value).hostname) return ""; } catch { return ""; }
  return value;
}
function readStoredQuality(): Quality {
  const stored = readStored(QUALITY_KEY);
  return stored === "economia" || stored === "alta" ? stored : "equilibrada";
}
function formatMbps(bitrate: number) {
  return (bitrate / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}
function readStoredVolume() {
  const stored = Number(readStored(VOLUME_KEY));
  return Number.isFinite(stored) && readStored(VOLUME_KEY) !== null ? Math.min(100, Math.max(0, stored)) : 100;
}

/* ---------- ícones ---------- */
const PATHS = {
  home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  volumeUp: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  volumeDown: "M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z",
  volumeMute: "M7 9v6h4l5 5V4l-5 5H7z",
  volumeOff: "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z",
  fullscreen: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  fullscreenExit: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  hangup: "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z",
  copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  play: "M8 5v14l11-7z",
  settings: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  signal: "M17 4h3v16h-3V4zM5 14h3v6H5v-6zm6-5h3v11h-3V9z",
  info: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  lock: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z",
  warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  refresh: "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  eyeOff: "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z",
  eye: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
};

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={d} /></svg>;
}
function ScreenIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
}
function LinkIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" /></svg>;
}
function Avatar({ label, color, live, online }: { label: string; color: string; live?: boolean; online?: boolean }) {
  return (
    <span className={`avatar ${live ? "live" : ""}`} style={{ background: color }}>
      {label}
      {online !== undefined && <span className={`dot ${online ? "online" : ""}`} />}
    </span>
  );
}

function QualityPicker({ value, onChange }: { value: Quality; onChange: (next: Quality) => void }) {
  return (
    <div className="quality-picker" role="radiogroup" aria-label="Qualidade da transmissão">
      {(Object.keys(QUALITY_PRESETS) as Quality[]).map((key) => {
        const preset = QUALITY_PRESETS[key];
        return (
          <button key={key} type="button" role="radio" aria-checked={value === key} className={`quality-option ${value === key ? "selected" : ""}`} onClick={() => onChange(key)}>
            <span className="quality-name">{preset.label}</span>
            <span className="quality-desc">{preset.desc}</span>
            <span className="quality-net">até ~{formatMbps(preset.bitrate)} Mbps por pessoa</span>
          </button>
        );
      })}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<"home" | "transmit" | "connect">("home");
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceTab, setSourceTab] = useState<"screen" | "window">("screen");
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [loadingSources, setLoadingSources] = useState(false);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [role, setRole] = useState<RoomRole | null>(null);
  const [status, setStatus] = useState("Pronto para conectar");
  const [error, setError] = useState("");
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<RemotePeerStream[]>([]);
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // controles do espectador
  const [volume, setVolume] = useState(readStoredVolume);
  const [muted, setMuted] = useState(() => readStored(MUTED_KEY) === "1");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [uiIdle, setUiIdle] = useState(false);

  // aparência e qualidade
  const [theme, setTheme] = useState<ThemeChoice>(() => { const stored = readStored(THEME_KEY); return stored === "light" || stored === "system" ? stored : "dark"; });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [quality, setQuality] = useState<Quality>(readStoredQuality);
  const [showPreview, setShowPreview] = useState(true);

  // servidor de salas
  const [serverUrl, setServerUrl] = useState(() => normalizeServerUrl(readStored(URL_KEY) ?? "") || DEFAULT_SIGNALING_URL);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInput, setSettingsInput] = useState("");
  const [testResult, setTestResult] = useState<TestState>({ state: "idle", message: "" });

  const socketRef = useRef<WebSocket | null>(null);
  const serverUrlRef = useRef(serverUrl);
  const qualityRef = useRef(quality);
  const roleRef = useRef<RoomRole | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const participantsRef = useRef(new Set<string>());
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef(new Map<string, HTMLVideoElement>());
  const waitersRef = useRef(new Map<string, (message: ServerMessage) => void>());
  const startCaptureAfterCreateRef = useRef(false);
  const viewerStageRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<number | undefined>(undefined);
  const barHoverRef = useRef(false);

  const updateRole = (next: RoomRole | null) => {
    roleRef.current = next;
    setRole(next);
  };

  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    setError("");
    try {
      const items = await window.telalink.getSources();
      setSources(items);
      setSelectedSourceId((current) => items.some((item) => item.id === current) ? current : (items.find((item) => item.id.startsWith("screen:"))?.id ?? items[0]?.id ?? ""));
    } catch (e) {
      console.error(e);
      setError("Não foi possível listar as telas. Feche e abra o TelaLink novamente.");
    } finally { setLoadingSources(false); }
  }, []);

  function closePeerConnections() {
    for (const pc of peerConnectionsRef.current.values()) {
      pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close();
    }
    peerConnectionsRef.current.clear();
    pendingCandidatesRef.current.clear();
    participantsRef.current.clear();
    setParticipantIds([]);
    setRemoteStreams([]);
    setAudioPlaybackBlocked(false);
    remoteVideoRefs.current.clear();
  }

  function disconnectSocket(sendLeave = true) {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN && sendLeave) {
      try { socket.send(JSON.stringify({ type: "leave-room" })); } catch { /* socket is closing */ }
    }
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  function connectSocket(): Promise<WebSocket> {
    const existing = socketRef.current;
    if (existing?.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (existing?.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        existing.addEventListener("open", () => resolve(existing), { once: true });
        existing.addEventListener("error", () => reject(new Error("Não foi possível conectar ao serviço de salas.")), { once: true });
      });
    }
    const url = serverUrlRef.current;
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try { socket = new WebSocket(url); }
      catch { reject(new Error("Endereço do serviço de salas inválido. Confira em Configurações → Avançado.")); return; }
      socketRef.current = socket;
      let keepAliveInterval: number | undefined;
      const openTimeout = window.setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          socket.close();
          reject(new Error("Tempo esgotado ao conectar. Verifique a internet e o endereço do servidor. Se estiver usando o Render gratuito, aguarde o serviço iniciar e tente novamente."));
        }
      }, isLocalUrl(url) ? 12000 : 90000);
      socket.addEventListener("open", () => {
        window.clearTimeout(openTimeout);
        keepAliveInterval = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "keep-alive" }));
          }
        }, 5 * 60 * 1000);
        setStatus("Conectado ao serviço");
        resolve(socket);
      }, { once: true });
      socket.addEventListener("error", () => {
        window.clearTimeout(openTimeout);
        if (socketRef.current === socket) socketRef.current = null;
        reject(new Error(`Não foi possível acessar o serviço de salas (${url}).`));
      });
      socket.addEventListener("message", (event) => {
        let message: ServerMessage;
        try { message = JSON.parse(String(event.data)) as ServerMessage; }
        catch { return; }
        const waiterKey = message.type === "error" ? "__error__" : message.type;
        const waiter = waitersRef.current.get(waiterKey);
        if (waiter) { waitersRef.current.delete(waiterKey); waiter(message); }
        void handleServerMessage(message);
      });
      socket.addEventListener("close", () => {
        window.clearTimeout(openTimeout);
        if (keepAliveInterval !== undefined) window.clearInterval(keepAliveInterval);
        if (socketRef.current === socket) {
          socketRef.current = null;
          closePeerConnections();
          updateRole(null);
          setRoomCode("");
          if (mediaStreamRef.current) setStatus("Transmissão local ativa · conexão encerrada");
          else setStatus("Desconectado");
        }
      });
    });
  }

  function waitForMessage(type: string, timeoutMs = 10000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        waitersRef.current.delete(type);
        reject(new Error("O serviço não respondeu a tempo. Tente novamente."));
      }, timeoutMs);
      const finish = (message: ServerMessage) => {
        window.clearTimeout(timer);
        waitersRef.current.delete(type);
        waitersRef.current.delete("__error__");
        resolve(message);
      };
      waitersRef.current.set(type, finish);
      waitersRef.current.set("__error__", finish);
    });
  }

  async function createRoomAndShare() {
    setError("");
    if (!selectedSourceId) { setError("Selecione uma tela ou janela primeiro."); return; }
    setBusy(true);
    try {
      closePeerConnections();
      const socket = await connectSocket();
      const response = waitForMessage("room-created");
      startCaptureAfterCreateRef.current = true;
      socket.send(JSON.stringify({ type: "create-room", maxParticipants: MAX_VIEWERS }));
      const message = await response;
      if (message.type === "error") throw new Error(message.message ?? "Não foi possível criar a sala.");
      if (!message.roomCode) throw new Error("O serviço não retornou um código de sala.");
      setRoomCode(message.roomCode);
      updateRole("host");
      setSources([]); // libera as miniaturas da memória enquanto transmite
      setScreen("transmit");
      setStatus("Sala criada · iniciando captura");
    } catch (e) {
      startCaptureAfterCreateRef.current = false;
      setError(e instanceof Error ? e.message : "Não foi possível criar a sala.");
      disconnectSocket(false);
    } finally { setBusy(false); }
  }

  async function joinRoom() {
    const code = roomCodeInput.trim().toUpperCase();
    if (!code) { setError("Digite o código da transmissão."); return; }
    setError(""); setBusy(true);
    try {
      closePeerConnections();
      const socket = await connectSocket();
      const response = waitForMessage("room-joined");
      socket.send(JSON.stringify({ type: "join-room", roomCode: code }));
      const message = await response;
      if (message.type === "error") throw new Error(message.message ?? "Não foi possível entrar na sala.");
      setRoomCode(message.roomCode ?? code);
      updateRole("participant");
      setScreen("connect");
      setStatus("Entrando na transmissão…");
      setRoomCodeInput(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível entrar na sala.");
      disconnectSocket(false);
    } finally { setBusy(false); }
  }

  function sendSignal(payload: SignalPayload, to?: string) {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "signal", ...(to ? { to } : {}), payload }));
  }

  function createPeerConnection(peerId: string) {
    const existing = peerConnectionsRef.current.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ kind: "candidate", candidate: event.candidate.toJSON() }, roleRef.current === "host" ? peerId : undefined);
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      setRemoteStreams((current) => {
        const previous = current.find((item) => item.peerId === peerId);
        return previous ? current.map((item) => item.peerId === peerId ? { ...item, stream } : item) : [...current, { peerId, stream }];
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setStatus(roleRef.current === "host" ? "Ao vivo" : "Conectado à transmissão");
      if (pc.connectionState === "failed") setStatus("Conexão instável · tente entrar novamente");
    };
    peerConnectionsRef.current.set(peerId, pc);
    return pc;
  }

  async function addPendingCandidates(peerId: string, pc: RTCPeerConnection) {
    const candidates = pendingCandidatesRef.current.get(peerId) ?? [];
    pendingCandidatesRef.current.delete(peerId);
    for (const candidate of candidates) {
      try { await pc.addIceCandidate(candidate); } catch (e) { console.warn("Candidato ICE ignorado", e); }
    }
  }

  // Limita banda e quadros por segundo conforme a qualidade escolhida (menos upload e menos CPU).
  async function applyVideoLimits(pc: RTCPeerConnection) {
    const sender = pc.getSenders().find((item) => item.track?.kind === "video");
    if (!sender) return;
    try {
      const preset = QUALITY_PRESETS[qualityRef.current];
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = preset.bitrate;
      params.encodings[0].maxFramerate = preset.fps;
      await sender.setParameters(params);
    } catch (e) { console.warn("Não foi possível aplicar o limite de qualidade", e); }
  }

  async function startHostConnection(participantId: string) {
    const stream = mediaStreamRef.current;
    if (!stream) { setStatus("Espectador conectado · aguardando início da transmissão"); return; }
    const pc = createPeerConnection(participantId);
    if (pc.signalingState !== "stable") return;
    stream.getTracks().forEach((track) => {
      if (!pc.getSenders().some((sender) => sender.track?.id === track.id)) pc.addTrack(track, stream);
    });
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await applyVideoLimits(pc);
      sendSignal({ kind: "offer", description: pc.localDescription ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : undefined }, participantId);
    } catch (e) { console.error(e); setStatus("Não foi possível iniciar uma conexão com um espectador"); }
  }

  async function handleSignal(from: string, payload: SignalPayload) {
    if (!roleRef.current || !payload.kind) return;
    const peerId = roleRef.current === "host" ? from : "host";
    const pc = createPeerConnection(peerId);
    try {
      if (payload.kind === "offer" && payload.description) {
        await pc.setRemoteDescription(payload.description);
        await addPendingCandidates(peerId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ kind: "answer", description: pc.localDescription ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : undefined });
      } else if (payload.kind === "answer" && payload.description) {
        await pc.setRemoteDescription(payload.description);
        await addPendingCandidates(peerId, pc);
      } else if (payload.kind === "candidate" && payload.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
        else {
          const list = pendingCandidatesRef.current.get(peerId) ?? [];
          list.push(payload.candidate); pendingCandidatesRef.current.set(peerId, list);
        }
      }
    } catch (e) { console.error("Erro na negociação WebRTC", e); }
  }

  async function handleServerMessage(message: ServerMessage) {
    switch (message.type) {
      case "room-created":
        if (startCaptureAfterCreateRef.current) {
          startCaptureAfterCreateRef.current = false;
          void startCapture();
        }
        break;
      case "participant-joined":
        if (message.participantId) {
          const id = message.participantId;
          participantsRef.current.add(id);
          setParticipantIds((current) => current.includes(id) ? current : [...current, id]);
          if (mediaStreamRef.current) void startHostConnection(id);
          else setStatus("Espectador entrou · aguardando captura da tela");
        }
        break;
      case "participant-left":
        if (message.participantId) {
          const id = message.participantId;
          const pc = peerConnectionsRef.current.get(id);
          pc?.close(); peerConnectionsRef.current.delete(id);
          pendingCandidatesRef.current.delete(id);
          participantsRef.current.delete(id);
          setParticipantIds((current) => current.filter((item) => item !== id));
          setRemoteStreams((current) => current.filter((item) => item.peerId !== id));
        }
        break;
      case "signal":
        if (message.from && message.payload) await handleSignal(message.from, message.payload);
        break;
      case "room-closed":
        closePeerConnections(); updateRole(null); setRoomCode("");
        setStatus("O anfitrião encerrou a transmissão"); setError(message.message ?? "A transmissão foi encerrada.");
        break;
      case "error":
        setError(message.message ?? "Ocorreu um erro no serviço de salas.");
        break;
    }
  }

  async function startCapture() {
    if (!selectedSourceId) { setError("Selecione uma tela ou janela primeiro."); return; }
    setError("");
    const isWindowSource = selectedSourceId.startsWith("window:");
    try {
      const preset = QUALITY_PRESETS[qualityRef.current];
      const video = { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: selectedSourceId, maxWidth: preset.width, maxHeight: preset.height, maxFrameRate: preset.fps } };
      // O áudio do computador (loopback do Windows) só existe para telas inteiras; janelas vão sem áudio.
      const constraints = {
        audio: isWindowSource ? false : { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: selectedSourceId } },
        video,
      } as unknown as MediaStreamConstraints;
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (!isWindowSource && stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        setError("O Windows não disponibilizou o áudio do computador. Verifique a saída de som e tente novamente.");
        return;
      }
      // Dica ao codificador: texto/telas favorecem nitidez; 60 fps favorece fluidez.
      stream.getVideoTracks().forEach((track) => { (track as MediaStreamTrack & { contentHint?: string }).contentHint = qualityRef.current === "alta" ? "motion" : "detail"; });
      mediaStreamRef.current = stream; setMediaStream(stream);
      setStatus(isWindowSource ? "Janela ao vivo (sem áudio)" : "Ao vivo");
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
        if (mediaStreamRef.current === stream) { mediaStreamRef.current = null; setMediaStream(null); setStatus("Captura encerrada"); }
      }, { once: true }));
      for (const participantId of participantsRef.current) void startHostConnection(participantId);
    } catch (e) {
      console.error(e); setError("Não foi possível capturar a tela. Verifique a saída de som e tente novamente.");
    }
  }

  function stopCapture() {
    const stream = mediaStreamRef.current;
    mediaStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    setMediaStream(null);
    for (const pc of peerConnectionsRef.current.values()) {
      pc.getSenders().forEach((sender) => { if (sender.track?.kind === "video") void sender.replaceTrack(null); });
    }
    setStatus(roleRef.current === "host" ? "Transmissão pausada" : "Captura encerrada");
  }

  async function endSession() {
    if (document.fullscreenElement) void document.exitFullscreen();
    window.clearTimeout(idleTimerRef.current);
    setUiIdle(false);
    stopCapture();
    closePeerConnections();
    disconnectSocket(true);
    updateRole(null); setRoomCode("");
    setStatus("Pronto para conectar"); setError(""); setScreen("home");
  }

  /* ---------- volume, tela cheia e controles do espectador ---------- */
  function applyVolume(nextVolume: number, nextMuted: boolean) {
    for (const video of remoteVideoRefs.current.values()) {
      video.volume = nextMuted ? 0 : nextVolume / 100;
      video.muted = nextMuted;
    }
  }

  function changeVolume(value: number) {
    const next = Math.min(100, Math.max(0, Math.round(value)));
    const nextMuted = muted && next === 0;
    setVolume(next); writeStored(VOLUME_KEY, String(next));
    if (muted && next > 0) { setMuted(false); writeStored(MUTED_KEY, "0"); }
    applyVolume(next, nextMuted);
    if (audioPlaybackBlocked) void activateRemotePlayback();
  }

  function toggleMute() {
    const nextMuted = !muted;
    let nextVolume = volume;
    if (!nextMuted && volume === 0) { nextVolume = 50; setVolume(50); writeStored(VOLUME_KEY, "50"); }
    setMuted(nextMuted); writeStored(MUTED_KEY, nextMuted ? "1" : "0");
    applyVolume(nextVolume, nextMuted);
    if (!nextMuted && audioPlaybackBlocked) void activateRemotePlayback();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void viewerStageRef.current?.requestFullscreen();
  }

  function wakeControls() {
    setUiIdle(false);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => { if (!barHoverRef.current) setUiIdle(true); }, 3000);
  }

  async function activateRemotePlayback() {
    try {
      await Promise.all(remoteStreams.map((item) => {
        const video = remoteVideoRefs.current.get(item.peerId);
        return video ? video.play() : Promise.resolve();
      }));
      setAudioPlaybackBlocked(false);
    } catch (e) {
      console.error("Não foi possível iniciar a reprodução da transmissão", e);
      setError("Não foi possível reproduzir o áudio. Verifique o volume do dispositivo e tente novamente.");
    }
  }

  /* ---------- aparência e qualidade ---------- */
  function changeTheme(next: ThemeChoice) {
    setTheme(next); writeStored(THEME_KEY, next);
  }

  function changeQuality(next: Quality) {
    qualityRef.current = next;
    setQuality(next); writeStored(QUALITY_KEY, next);
    // O limite de banda vale na hora; resolução e fps passam a valer na próxima captura.
    for (const pc of peerConnectionsRef.current.values()) void applyVideoLimits(pc);
  }

  /* ---------- configurações do servidor ---------- */
  function openSettings() {
    setSettingsInput(serverUrl);
    setTestResult({ state: "idle", message: "" });
    setShowSettings(true);
  }

  async function testServerUrl() {
    const url = normalizeServerUrl(settingsInput);
    if (!url) { setTestResult({ state: "fail", message: "Digite um endereço válido, por exemplo wss://seu-servico.onrender.com" }); return; }
    setSettingsInput(url);
    setTestResult({ state: "testing", message: isLocalUrl(url) ? "Testando conexão…" : "Testando conexão… se o serviço estava dormindo, pode levar até 1 minuto." });
    try {
      await new Promise<void>((resolve, reject) => {
        let socket: WebSocket;
        try { socket = new WebSocket(url); } catch { reject(new Error("Endereço inválido.")); return; }
        const timer = window.setTimeout(() => { socket.close(); reject(new Error("O servidor não respondeu a tempo.")); }, isLocalUrl(url) ? 8000 : 90000);
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as ServerMessage;
            if (message.type === "connected") { window.clearTimeout(timer); socket.close(); resolve(); }
          } catch { /* ignora */ }
        };
        socket.onerror = () => { window.clearTimeout(timer); reject(new Error("Não foi possível conectar. Confira o endereço e se o serviço está no ar.")); };
      });
      setTestResult({ state: "ok", message: "Tudo certo! O servidor do TelaLink respondeu." });
    } catch (e) {
      setTestResult({ state: "fail", message: e instanceof Error ? e.message : "Falha ao testar o servidor." });
    }
  }

  function saveSettings(nextRaw: string | null) {
    const next = nextRaw === null ? DEFAULT_SIGNALING_URL : normalizeServerUrl(nextRaw);
    if (!next) { setTestResult({ state: "fail", message: "Digite um endereço válido antes de salvar." }); return; }
    if (!roleRef.current) disconnectSocket(false);
    writeStored(URL_KEY, nextRaw === null ? null : next);
    serverUrlRef.current = next;
    setServerUrl(next);
    setSettingsInput(next);
    setTestResult({ state: "ok", message: "Servidor salvo." });
  }

  async function copyRoomCode() {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true); window.setTimeout(() => setCopied(false), 2000);
    } catch { setError(`Código da sala: ${roomCode}`); }
  }

  /* ---------- efeitos ---------- */
  useEffect(() => { serverUrlRef.current = serverUrl; }, [serverUrl]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "dark" | "light" = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    void window.telalink?.setTheme?.(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (screen === "transmit" && !role && sources.length === 0) void loadSources();
  }, [screen, role, sources.length, loadSources]);

  useEffect(() => {
    if (localVideoRef.current && mediaStream) localVideoRef.current.srcObject = mediaStream;
  }, [mediaStream, showPreview]);

  useEffect(() => {
    for (const item of remoteStreams) {
      const video = remoteVideoRefs.current.get(item.peerId);
      if (video) {
        video.volume = muted ? 0 : volume / 100;
        video.muted = muted;
        if (video.srcObject !== item.stream) video.srcObject = item.stream;
        void video.play()
          .then(() => setAudioPlaybackBlocked(false))
          .catch(() => setAudioPlaybackBlocked(true));
      }
    }
  }, [remoteStreams]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (role !== "participant") return;
    wakeControls();
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === "m") { toggleMute(); wakeControls(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [role, muted, volume]);

  useEffect(() => () => {
    window.clearTimeout(idleTimerRef.current);
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    for (const pc of peerConnectionsRef.current.values()) pc.close();
    const socket = socketRef.current; if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }, []);

  /* ---------- derivados de exibição ---------- */
  const screens = sources.filter((item) => item.id.startsWith("screen:"));
  const windows = sources.filter((item) => !item.id.startsWith("screen:"));
  const shownTab = sourceTab === "screen" && screens.length === 0 && windows.length > 0 ? "window" : sourceTab;
  const shownSources = shownTab === "screen" ? screens : windows;
  const selectedIsWindow = selectedSourceId.startsWith("window:");
  const effectiveVolume = muted ? 0 : volume;
  const volumeIcon = effectiveVolume === 0 ? PATHS.volumeOff : effectiveVolume < 34 ? PATHS.volumeMute : effectiveVolume < 67 ? PATHS.volumeDown : PATHS.volumeUp;
  const viewerCount = participantIds.length;

  let headerTitle = "Início";
  let headerDesc = "Compartilhe sua tela ou assista à de alguém";
  let headerIcon = <Icon d={PATHS.home} />;
  if (role === "host") { headerTitle = "Transmissão ao vivo"; headerDesc = `Sala ${roomCode}`; headerIcon = <ScreenIcon />; }
  else if (role === "participant") { headerTitle = "Assistindo"; headerDesc = `Sala ${roomCode}`; headerIcon = <LinkIcon />; }
  else if (screen === "transmit") { headerTitle = "Transmitir minha tela"; headerDesc = "Escolha o que você quer mostrar"; headerIcon = <ScreenIcon />; }
  else if (screen === "connect") { headerTitle = "Conectar a uma tela"; headerDesc = "Entre com o código da transmissão"; headerIcon = <LinkIcon />; }

  const goTo = (next: "home" | "transmit" | "connect") => {
    if (role) return;
    setError(""); setScreen(next);
    if (next === "transmit") void loadSources();
  };

  return (
    <div className="app">
      <div className="titlebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
        TelaLink
      </div>

      <div className="workspace">
        {/* ===== barra lateral ===== */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <span className="logo-pill"><ScreenIcon /></span>
            <span>TelaLink</span>
          </div>

          <div className="sidebar-scroll">
            {!role && (
              <>
                <button className={`nav-item ${screen === "home" ? "active" : ""}`} onClick={() => goTo("home")}><Icon d={PATHS.home} /><span>Início</span></button>
                <div className="side-label">Compartilhar</div>
                <button className={`nav-item ${screen === "transmit" ? "active" : ""}`} onClick={() => goTo("transmit")}><ScreenIcon /><span>Transmitir minha tela</span></button>
                <button className={`nav-item ${screen === "connect" ? "active" : ""}`} onClick={() => goTo("connect")}><LinkIcon /><span>Conectar a uma tela</span></button>
              </>
            )}

            {role === "host" && (
              <>
                <div className="side-label">Na sala — {viewerCount + 1}</div>
                <div className="member"><Avatar label="V" color="#5865f2" live={Boolean(mediaStream)} /><span className="member-name">Você</span><span className="member-tag">Host</span></div>
                {participantIds.map((id, index) => (
                  <div className="member" key={id}><Avatar label={`E${index + 1}`} color={AVATAR_COLORS[index % AVATAR_COLORS.length]} /><span className="member-name">Espectador {index + 1}</span></div>
                ))}
              </>
            )}

            {role === "participant" && (
              <>
                <div className="side-label">Na sala</div>
                <div className="member"><Avatar label="H" color="#5865f2" live={remoteStreams.length > 0} /><span className="member-name">Anfitrião</span><span className="member-tag">Host</span></div>
                <div className="member"><Avatar label="V" color={AVATAR_COLORS[0]} /><span className="member-name">Você</span></div>
              </>
            )}
          </div>

          {role && (
            <div className="voice-panel">
              <div className="voice-info">
                <div className="voice-title"><Icon d={PATHS.signal} />{role === "host" ? "Transmitindo" : "Conectado"}</div>
                <div className="voice-sub">Sala {roomCode}</div>
              </div>
              <button className="icon-btn danger tip tip-right" data-tip={role === "host" ? "Encerrar transmissão" : "Desconectar"} aria-label={role === "host" ? "Encerrar transmissão" : "Desconectar"} onClick={() => void endSession()}><Icon d={PATHS.hangup} /></button>
            </div>
          )}

          <div className="user-panel">
            <Avatar label="V" color="#5865f2" online={Boolean(role)} />
            <div className="user-meta">
              <div className="user-name">Você</div>
              <div className="user-status">{role ? status : "Offline"}</div>
            </div>
            <button className="icon-btn tip tip-right" data-tip="Configurações" aria-label="Configurações" onClick={openSettings}><Icon d={PATHS.settings} /></button>
          </div>
        </aside>

        {/* ===== área principal ===== */}
        <main className="main">
          <header className="main-header">
            {headerIcon}
            <span>{headerTitle}</span>
            <span className="divider" />
            <span className="desc">{headerDesc}</span>
            <div className="header-status"><span className={`status-dot ${role ? "live" : ""}`} />{role ? status : "Compartilhamento privado"}</div>
          </header>

          <div className="main-body">
            {/* ----- início ----- */}
            {screen === "home" && !role && (
              <section className="home">
                <h1>Sua tela, em qualquer lugar</h1>
                <p className="lead">Compartilhe sua tela em tempo real ou entre em uma transmissão usando apenas um código.</p>
                <div className="action-grid">
                  <button className="action-card" onClick={() => goTo("transmit")}>
                    <span className="action-icon green"><ScreenIcon /></span>
                    <span className="action-title">Transmitir minha tela</span>
                    <span className="action-copy">Crie uma sala e compartilhe o código com quem você quiser.</span>
                    <span className="action-link">Iniciar transmissão →</span>
                  </button>
                  <button className="action-card" onClick={() => goTo("connect")}>
                    <span className="action-icon brand"><LinkIcon /></span>
                    <span className="action-title">Conectar a uma tela</span>
                    <span className="action-copy">Digite o código da sala para assistir à transmissão.</span>
                    <span className="action-link">Inserir código →</span>
                  </button>
                </div>
                <div className="callout"><Icon d={PATHS.lock} /><span>A transmissão só pode ser acessada por quem possui o código da sala.</span></div>
              </section>
            )}

            {/* ----- escolher o que transmitir ----- */}
            {screen === "transmit" && !role && (
              <section className="panel">
                <div className="panel-header">
                  <h2>Ir ao vivo</h2>
                  <p>Escolha o monitor ou a janela que deseja mostrar. A transmissão só começa depois que você clicar em “Ir ao vivo”.</p>
                </div>
                <div className="panel-body">
                  <div className="tabs">
                    <button className={`tab ${shownTab === "screen" ? "active" : ""}`} onClick={() => setSourceTab("screen")}>Telas ({screens.length})</button>
                    <button className={`tab ${shownTab === "window" ? "active" : ""}`} onClick={() => setSourceTab("window")}>Janelas ({windows.length})</button>
                    <button className="btn btn-secondary" onClick={() => void loadSources()} disabled={loadingSources}><Icon d={PATHS.refresh} />{loadingSources ? "Atualizando…" : "Atualizar"}</button>
                  </div>
                  {loadingSources && sources.length === 0 && <div className="empty-state">Buscando telas disponíveis…</div>}
                  {!loadingSources && shownSources.length === 0 && <div className="empty-state">Nada encontrado aqui. Clique em Atualizar para tentar novamente.</div>}
                  <div className="source-grid">
                    {shownSources.map((source) => (
                      <button key={source.id} className={`source ${selectedSourceId === source.id ? "selected" : ""}`} onClick={() => setSelectedSourceId(source.id)}>
                        <img src={source.thumbnail} alt={`Prévia de ${source.name}`} />
                        {selectedSourceId === source.id && <span className="source-check"><Icon d={PATHS.check} /></span>}
                        <span className="source-name">{source.name}</span>
                      </button>
                    ))}
                  </div>
                  <div className="quality-block">
                    <div className="field-label">Qualidade da transmissão</div>
                    <QualityPicker value={quality} onChange={changeQuality} />
                  </div>
                  {error && <div className="error-box">{error}</div>}
                </div>
                <div className="panel-footer">
                  <div className="footer-note">
                    <Icon d={PATHS.volumeUp} />
                    <span>{selectedIsWindow ? "Janelas são transmitidas sem áudio. Para incluir o som do computador, compartilhe uma tela inteira." : "O áudio do computador vai junto com a tela. O microfone não é incluído."}</span>
                  </div>
                  <span className="spacer" />
                  <button className="btn btn-ghost" onClick={() => goTo("home")}>Cancelar</button>
                  <button className="btn btn-green" onClick={() => void createRoomAndShare()} disabled={busy || !selectedSourceId}>{busy ? "Preparando…" : "Ir ao vivo"}</button>
                </div>
              </section>
            )}

            {/* ----- digitar o código ----- */}
            {screen === "connect" && !role && (
              <form className="panel narrow" onSubmit={(event) => { event.preventDefault(); void joinRoom(); }}>
                <div className="panel-header center">
                  <h2>Entrar em uma transmissão</h2>
                  <p>Peça o código para quem está compartilhando a tela.</p>
                </div>
                <div className="panel-body">
                  <label className="field-label" htmlFor="room-code">Código da transmissão</label>
                  <input id="room-code" className="input code" value={roomCodeInput} onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())} placeholder="TL-ABCDE" maxLength={8} autoComplete="off" autoFocus />
                  <div className="hint">O código identifica esta transmissão e a separa das outras salas.</div>
                  {error && <div className="error-box">{error}</div>}
                </div>
                <div className="panel-footer">
                  <button type="button" className="btn btn-ghost" onClick={() => goTo("home")}>Voltar</button>
                  <span className="spacer" />
                  <button className="btn btn-brand" type="submit" disabled={busy || !roomCodeInput.trim()}>{busy ? "Conectando…" : "Conectar"}</button>
                </div>
              </form>
            )}

            {/* ----- anfitrião ----- */}
            {role === "host" && (
              <section className="host-session">
                <div className="code-bar">
                  <div><span className="code-caption">Código da sala</span><span className="code-value">{roomCode}</span></div>
                  <button className="btn btn-brand" onClick={() => void copyRoomCode()}><Icon d={copied ? PATHS.check : PATHS.copy} />{copied ? "Copiado!" : "Copiar código"}</button>
                </div>
                {error && <div className="error-box">{error}</div>}
                <div className="stage">
                  <div className="badges">
                    <span className={`badge ${mediaStream ? "" : "paused"}`}>{mediaStream && <span className="live-dot" />}{mediaStream ? "AO VIVO" : "PAUSADO"}</span>
                    <span className="badge chip"><Icon d={PATHS.eye} />{viewerCount}</span>
                  </div>
                  {mediaStream && showPreview ? <video ref={localVideoRef} autoPlay muted playsInline /> : mediaStream ? (
                    <div className="stage-empty">
                      <ScreenIcon />
                      <h3>Prévia oculta</h3>
                      <p>Sua tela continua sendo transmitida. Ocultar a prévia economiza processador e placa de vídeo.</p>
                    </div>
                  ) : (
                    <div className="stage-empty">
                      <ScreenIcon />
                      <h3>Captura parada</h3>
                      <p>Quem está na sala aguarda até a captura da tela começar.</p>
                      <button className="btn btn-green" onClick={() => void startCapture()}>Iniciar captura</button>
                    </div>
                  )}
                </div>
                <div className="call-controls">
                  <button className="round-btn tip" data-tip="Copiar código" aria-label="Copiar código" onClick={() => void copyRoomCode()}><Icon d={copied ? PATHS.check : PATHS.copy} /></button>
                  <button className="round-btn tip" data-tip={showPreview ? "Ocultar prévia" : "Mostrar prévia"} aria-label={showPreview ? "Ocultar prévia" : "Mostrar prévia"} onClick={() => setShowPreview((current) => !current)}><Icon d={showPreview ? PATHS.eye : PATHS.eyeOff} /></button>
                  <button className="round-btn tip" data-tip={mediaStream ? "Pausar transmissão" : "Retomar transmissão"} aria-label={mediaStream ? "Pausar transmissão" : "Retomar transmissão"} onClick={() => mediaStream ? stopCapture() : void startCapture()}><Icon d={mediaStream ? PATHS.pause : PATHS.play} /></button>
                  <button className="round-btn danger tip" data-tip="Encerrar transmissão" aria-label="Encerrar transmissão" onClick={() => void endSession()}><Icon d={PATHS.hangup} /></button>
                </div>
              </section>
            )}

            {/* ----- espectador (tela conectada) ----- */}
            {role === "participant" && (
              <div ref={viewerStageRef} className={`viewer ${uiIdle ? "idle" : ""}`} onMouseMove={wakeControls} onMouseDown={wakeControls}>
                {remoteStreams.length ? remoteStreams.map((item) => (
                  <video
                    key={item.peerId}
                    ref={(element) => {
                      if (element) {
                        remoteVideoRefs.current.set(item.peerId, element);
                        if (element.srcObject !== item.stream) element.srcObject = item.stream;
                      } else remoteVideoRefs.current.delete(item.peerId);
                    }}
                    autoPlay
                    playsInline
                    onDoubleClick={toggleFullscreen}
                  />
                )) : (
                  <div className="viewer-loading">
                    <div className="spinner" />
                    <h2>Conectando à transmissão…</h2>
                    <p>Mantenha o TelaLink aberto enquanto negociamos a conexão.</p>
                  </div>
                )}

                <div className="viewer-top">
                  <span className="badge"><span className="live-dot" />AO VIVO</span>
                  <span className="badge chip">{roomCode}</span>
                </div>

                {error && <div className="toast" role="alert">{error}</div>}

                {audioPlaybackBlocked && (
                  <div className="audio-banner"><button className="btn btn-brand" onClick={() => void activateRemotePlayback()}><Icon d={PATHS.volumeUp} />Clique para ativar o áudio</button></div>
                )}

                <div className="viewer-bar" onMouseEnter={() => { barHoverRef.current = true; }} onMouseLeave={() => { barHoverRef.current = false; wakeControls(); }}>
                  <div className="volume-group" onWheel={(event) => changeVolume(volume + (event.deltaY < 0 ? 5 : -5))}>
                    <button className="bar-btn tip" data-tip={muted || volume === 0 ? "Ativar som (M)" : "Silenciar (M)"} aria-label={muted ? "Ativar som" : "Silenciar"} onClick={toggleMute}><Icon d={volumeIcon} /></button>
                    <input
                      className="volume"
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={effectiveVolume}
                      style={{ "--fill": `${effectiveVolume}%` } as CSSProperties}
                      onChange={(event) => changeVolume(Number(event.target.value))}
                      aria-label="Volume da transmissão"
                    />
                    <span className="volume-value">{effectiveVolume}%</span>
                  </div>
                  <span className="bar-sep" />
                  <button className="bar-btn tip" data-tip={isFullscreen ? "Sair da tela cheia" : "Tela cheia"} aria-label={isFullscreen ? "Sair da tela cheia" : "Tela cheia"} onClick={toggleFullscreen}><Icon d={isFullscreen ? PATHS.fullscreenExit : PATHS.fullscreen} /></button>
                  <button className="bar-btn danger tip" data-tip="Desconectar" aria-label="Desconectar" onClick={() => void endSession()}><Icon d={PATHS.hangup} /></button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* ===== configurações ===== */}
      {showSettings && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Configurações">
            <div className="panel-header"><h2>Configurações</h2></div>
            <div className="panel-body settings-body">
              <div className="setting-block">
                <div className="field-label">Aparência</div>
                <div className="segmented" role="radiogroup" aria-label="Tema">
                  {([["dark", "Escuro"], ["light", "Claro"], ["system", "Automático"]] as const).map(([key, label]) => (
                    <button key={key} type="button" role="radio" aria-checked={theme === key} className={theme === key ? "active" : ""} onClick={() => changeTheme(key)}>{label}</button>
                  ))}
                </div>
                <div className="hint">Automático acompanha o tema do Windows.</div>
              </div>

              <div className="setting-block">
                <div className="field-label">Qualidade da transmissão</div>
                <QualityPicker value={quality} onChange={changeQuality} />
                <div className="hint">{role === "host" ? "O limite de internet muda na hora; resolução e quadros por segundo valem ao pausar e retomar a transmissão." : "Mais qualidade usa mais internet (upload) e mais processador, e o envio é repetido para cada espectador."}</div>
              </div>

              <details className="setting-block advanced">
                <summary>Avançado · servidor de salas</summary>
                <label className="field-label" htmlFor="server-url">Endereço do servidor</label>
                <input id="server-url" className="input mono" value={settingsInput} onChange={(event) => { setSettingsInput(event.target.value); setTestResult({ state: "idle", message: "" }); }} placeholder="wss://seu-servico.onrender.com" spellCheck={false} autoComplete="off" disabled={Boolean(role)} />
                <div className="hint">Pode colar o endereço https://… do Render: o TelaLink converte para wss:// sozinho. Normalmente você não precisa mexer nisto.</div>
                {role && <div className="hint">Encerre a sessão atual para alterar o servidor.</div>}
                {testResult.state !== "idle" && <div className={`test-result ${testResult.state}`}>{testResult.message}</div>}
                <div className="advanced-actions">
                  <button className="btn btn-ghost" onClick={() => saveSettings(null)} disabled={Boolean(role)}>Restaurar padrão</button>
                  <span className="spacer" />
                  <button className="btn btn-secondary" onClick={() => void testServerUrl()} disabled={testResult.state === "testing"}>Testar</button>
                  <button className="btn btn-brand" onClick={() => saveSettings(settingsInput)} disabled={Boolean(role)}>Salvar</button>
                </div>
              </details>
            </div>
            <div className="panel-footer">
              <span className="spacer" />
              <button className="btn btn-brand" onClick={() => setShowSettings(false)}>Concluir</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

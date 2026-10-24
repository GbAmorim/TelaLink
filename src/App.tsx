import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import "./App.css";
import { Icon, LinkIcon, PATHS, ScreenIcon } from "./icons";
import { createSystemAudioTrack } from "./appAudio";
import { AudioChooser, SourceChooser } from "./SourcePicker";
import { CancelledError, HostRoom, OUTDATED_SERVER, ViewerRoom, isLocalUrl } from "./roomClient";
import type { Access, HostHandlers, JoinRequest, Member, ViewerState } from "./roomClient";
import type { AudioMode, AudioPlan, CaptureSource, SourceKind } from "./types";

type View = "home" | "transmit" | "connect" | "group";
type ThemeChoice = "dark" | "light" | "system";
type Quality = "economia" | "equilibrada" | "alta";
type TestState = { state: "idle" | "testing" | "ok" | "fail"; message: string };
type HostInfo = { code: string; access: Access; members: Member[]; sourceId: string };
type ViewerInfo = { key: string; code: string; hostName: string; stream: MediaStream | null; state: ViewerState; volume: number; muted: boolean; blocked: boolean };
type Toast = { id: number; text: string };

const DEFAULT_SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "ws://localhost:3001";
const MAX_WATCH = 5; // transmissões que dá para assistir ao mesmo tempo
const URL_KEY = "telalink:signaling-url";
const VOLUME_KEY = "telalink:volume";
const THEME_KEY = "telalink:theme";
const QUALITY_KEY = "telalink:quality";
const NAME_KEY = "telalink:name";
const ACCESS_KEY = "telalink:access";
const AUDIO_KEY = "telalink:audio-mode";
const AVATAR_COLORS = ["#3ba55c", "#faa61a", "#eb459e", "#ed4245", "#9b59b6", "#1abc9c"];
// Cada pessoa que assiste recebe um envio próprio: o consumo de internet e de processador cresce com o número de pessoas.
const QUALITY_PRESETS: Record<Quality, { label: string; desc: string; width: number; height: number; fps: number; bitrate: number }> = {
  economia: { label: "Economia", desc: "720p · 15 fps", width: 1280, height: 720, fps: 15, bitrate: 1_200_000 },
  equilibrada: { label: "Equilibrada", desc: "1080p · 30 fps", width: 1920, height: 1080, fps: 30, bitrate: 3_500_000 },
  alta: { label: "Alta", desc: "1080p · 60 fps", width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};

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
function normalizeCode(text: string): string {
  const raw = text.trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";
  return raw.startsWith("TL-") ? raw : `TL-${raw}`;
}
function readStoredQuality(): Quality {
  const stored = readStored(QUALITY_KEY);
  return stored === "economia" || stored === "alta" ? stored : "equilibrada";
}
function readStoredVolume() {
  const raw = readStored(VOLUME_KEY);
  const stored = Number(raw);
  return raw !== null && Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 100;
}
function formatMbps(bitrate: number) {
  return (bitrate / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function colorFor(text: string) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
function volumeIconPath(volume: number, muted: boolean) {
  const level = muted ? 0 : volume;
  return level === 0 ? PATHS.volumeOff : level < 34 ? PATHS.volumeMute : level < 67 ? PATHS.volumeDown : PATHS.volumeUp;
}
function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function Avatar({ name, live, size = 32 }: { name: string; live?: boolean; size?: number }) {
  return (
    <span className={`avatar ${live ? "live" : ""}`} style={{ background: colorFor(name), width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {initials(name)}
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
  const [view, setView] = useState<View>("home");
  const [name, setName] = useState(() => readStored(NAME_KEY) ?? "");
  const [nameDraft, setNameDraft] = useState(() => readStored(NAME_KEY) ?? "");
  const [toasts, setToasts] = useState<Toast[]>([]);

  // fontes para transmitir
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind>("screen");
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [loadingSources, setLoadingSources] = useState(false);
  const [access, setAccess] = useState<Access>(() => (readStored(ACCESS_KEY) === "open" ? "open" : "approval"));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [audioMode, setAudioMode] = useState<AudioMode>(() => (readStored(AUDIO_KEY) === "none" ? "none" : "computer"));
  const [audioPlan, setAudioPlan] = useState<AudioPlan>({ available: false, excluded: "TelaLink" });

  // minha transmissão
  const [host, setHost] = useState<HostInfo | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [showPreview, setShowPreview] = useState(true);
  const [copied, setCopied] = useState(false);

  // transmissões que estou assistindo
  const [viewers, setViewers] = useState<ViewerInfo[]>([]);
  const [codeInput, setCodeInput] = useState("");
  const [joining, setJoining] = useState<{ key: string; pending: boolean } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // trocar fonte ao vivo
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [pickSourceId, setPickSourceId] = useState("");
  const [pickKind, setPickKind] = useState<SourceKind>("screen");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");

  // aparência, qualidade e servidor
  const [theme, setTheme] = useState<ThemeChoice>(() => { const stored = readStored(THEME_KEY); return stored === "light" || stored === "system" ? stored : "dark"; });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [quality, setQuality] = useState<Quality>(readStoredQuality);
  const [serverUrl, setServerUrl] = useState(() => normalizeServerUrl(readStored(URL_KEY) ?? "") || DEFAULT_SIGNALING_URL);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInput, setSettingsInput] = useState("");
  const [testResult, setTestResult] = useState<TestState>({ state: "idle", message: "" });

  const hostRoomRef = useRef<HostRoom | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const viewerRoomsRef = useRef(new Map<string, ViewerRoom>());
  const viewersRef = useRef<ViewerInfo[]>([]);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const stopAudioRef = useRef<(() => void) | null>(null);
  const audioModeRef = useRef<AudioMode>("none");
  const serverUrlRef = useRef(serverUrl);
  const qualityRef = useRef(quality);
  const nameRef = useRef(name);
  const toastCounter = useRef(0);
  viewersRef.current = viewers;
  nameRef.current = name;

  const toast = useCallback((text: string) => {
    const id = ++toastCounter.current;
    setToasts((list) => [...list, { id, text }]);
    window.setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 6000);
  }, []);

  /* ---------- fontes ---------- */
  const loadSources = useCallback(async (target: "transmit" | "switch") => {
    setLoadingSources(true);
    try {
      const items = await window.telalink.getSources();
      setSources(items);
      const fallback = items.find((item) => item.id.startsWith("screen:"))?.id ?? items[0]?.id ?? "";
      const keep = (current: string) => (items.some((item) => item.id === current) ? current : fallback);
      if (target === "transmit") setSelectedSourceId(keep); else setPickSourceId(keep);
    } catch (error) {
      console.error(error);
      toast("Não foi possível listar as telas. Feche e abra o TelaLink novamente.");
    } finally { setLoadingSources(false); }
  }, [toast]);

  function limitsFor(next: Quality) {
    const preset = QUALITY_PRESETS[next];
    return { bitrate: preset.bitrate, fps: preset.fps };
  }

  // Abre a captura da tela/janela. O som do computador (sem o Discord) é opcional.
  async function acquireStream(sourceId: string): Promise<{ stream: MediaStream; stopAudio: (() => void) | null }> {
    const preset = QUALITY_PRESETS[qualityRef.current];
    const video = { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: preset.width, maxHeight: preset.height, maxFrameRate: preset.fps } };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video } as unknown as MediaStreamConstraints);
    // Dica ao codificador: texto favorece nitidez; 60 fps favorece fluidez.
    stream.getVideoTracks().forEach((track) => { (track as MediaStreamTrack & { contentHint?: string }).contentHint = qualityRef.current === "alta" ? "motion" : "detail"; });
    let stopAudio: (() => void) | null = null;
    if (audioModeRef.current === "computer") {
      const handle = await createSystemAudioTrack();
      if (handle) { stream.addTrack(handle.track); stopAudio = handle.stop; }
      else toast("Não foi possível capturar o som do computador. Transmitindo sem som.");
    }
    return { stream, stopAudio };
  }

  function attachStream(stream: MediaStream, stopAudio: (() => void) | null) {
    mediaStreamRef.current = stream;
    stopAudioRef.current = stopAudio;
    setMediaStream(stream);
    stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
      if (mediaStreamRef.current !== stream) return;
      mediaStreamRef.current = null;
      stopAudioRef.current?.(); stopAudioRef.current = null;
      setMediaStream(null);
      void hostRoomRef.current?.setStream(null);
      toast("A captura foi encerrada.");
    }, { once: true }));
  }

  function stopLocalStream() {
    const stream = mediaStreamRef.current;
    mediaStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    stopAudioRef.current?.(); stopAudioRef.current = null;
    setMediaStream(null);
  }

  /* ---------- minha transmissão ---------- */
  function resetHost() {
    stopLocalStream();
    hostRoomRef.current = null;
    setHost(null);
    setRequests([]);
  }

  async function goLive() {
    if (hostRoomRef.current || busy) return;
    const sourceId = selectedSourceId;
    if (!sourceId) { setFormError("Escolha o que você quer transmitir."); return; }
    setBusy(true); setFormError("");
    let captured: { stream: MediaStream; stopAudio: (() => void) | null } | null = null;
    let room: HostRoom | null = null;
    try {
      captured = await acquireStream(sourceId);
      const handlers: HostHandlers = {
        onMembers: (members) => setHost((current) => (current ? { ...current, members } : current)),
        onRequest: (request) => setRequests((list) => [...list, request]),
        onRequestGone: (id) => setRequests((list) => list.filter((item) => item.id !== id)),
        onClosed: (reason) => { resetHost(); toast(reason); },
      };
      room = new HostRoom(handlers, limitsFor(qualityRef.current));
      await room.create(serverUrlRef.current, nameRef.current, access);
      hostRoomRef.current = room;
      attachStream(captured.stream, captured.stopAudio);
      await room.setStream(captured.stream);
      setHost({ code: room.roomCode, access, members: [], sourceId });
      setSources([]); // libera as miniaturas da memória
      setView("group");
    } catch (error) {
      captured?.stream.getTracks().forEach((track) => track.stop());
      captured?.stopAudio?.();
      room?.close();
      hostRoomRef.current = null;
      mediaStreamRef.current = null;
      setMediaStream(null);
      setFormError(errorText(error, "Não foi possível iniciar a transmissão."));
    } finally { setBusy(false); }
  }

  function endHosting() {
    hostRoomRef.current?.close();
    resetHost();
  }

  async function pauseHost() {
    stopLocalStream();
    await hostRoomRef.current?.setStream(null);
  }

  async function resumeHost() {
    if (!host || !hostRoomRef.current) return;
    try {
      const { stream, stopAudio } = await acquireStream(host.sourceId);
      attachStream(stream, stopAudio);
      await hostRoomRef.current.setStream(stream);
    } catch (error) { toast(errorText(error, "Não foi possível retomar a transmissão.")); }
  }

  function changeAccess(next: Access) {
    hostRoomRef.current?.setAccess(next);
    setHost((current) => (current ? { ...current, access: next } : current));
  }

  function decide(request: JoinRequest, allow: boolean) {
    hostRoomRef.current?.decide(request.id, allow);
    setRequests((list) => list.filter((item) => item.id !== request.id));
  }

  async function copyCode() {
    if (!host) return;
    try {
      await navigator.clipboard.writeText(host.code);
      setCopied(true); window.setTimeout(() => setCopied(false), 2000);
    } catch { toast(`Código: ${host.code}`); }
  }

  /* ---------- trocar tela/janela ao vivo ---------- */
  function openSwitcher() {
    const current = host?.sourceId ?? "";
    setPickSourceId(current); setPickKind(current.startsWith("window:") ? "window" : "screen");
    setSwitchError(""); setShowSwitcher(true);
    void loadSources("switch");
  }

  function closeSwitcher() {
    setShowSwitcher(false); setSources([]);
  }

  function chooseKind(kind: SourceKind, apply: (id: string) => void, setKind: (kind: SourceKind) => void) {
    setKind(kind);
    const first = sources.find((item) => item.id.startsWith(kind === "screen" ? "screen:" : "window:"));
    if (first) apply(first.id);
  }

  async function confirmSwitch() {
    const room = hostRoomRef.current;
    if (!room || !pickSourceId) return;
    setSwitching(true); setSwitchError("");
    const previous = mediaStreamRef.current;
    const previousStopAudio = stopAudioRef.current;
    try {
      const { stream, stopAudio } = await acquireStream(pickSourceId);
      attachStream(stream, stopAudio);
      await room.setStream(stream);
      previous?.getTracks().forEach((track) => track.stop());
      previousStopAudio?.();
      setHost((current) => (current ? { ...current, sourceId: pickSourceId } : current));
      setSelectedSourceId(pickSourceId);
      closeSwitcher();
    } catch (error) {
      setSwitchError(errorText(error, "Não foi possível capturar essa fonte. Tente outra."));
    } finally { setSwitching(false); }
  }

  /* ---------- assistir a transmissões ---------- */
  function updateViewer(key: string, patch: Partial<ViewerInfo>) {
    setViewers((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function removeViewer(key: string) {
    viewerRoomsRef.current.delete(key);
    videoRefs.current.delete(key);
    tileRefs.current.delete(key);
    setViewers((list) => list.filter((item) => item.key !== key));
    setFocusKey((current) => (current === key ? null : current));
  }

  async function joinTransmission() {
    const code = normalizeCode(codeInput);
    if (!code) { setFormError("Digite o código da transmissão."); return; }
    if (viewers.length >= MAX_WATCH) { setFormError(`Você já está assistindo a ${MAX_WATCH} transmissões. Saia de uma para entrar em outra.`); return; }
    if (viewers.some((item) => item.code === code) || host?.code === code) { setFormError("Você já está nesta transmissão."); return; }
    const key = `v-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setFormError(""); setJoining({ key, pending: false });
    const room = new ViewerRoom({
      onPending: () => setJoining((current) => (current?.key === key ? { ...current, pending: true } : current)),
      onStream: (stream) => updateViewer(key, { stream }),
      onState: (state) => updateViewer(key, { state }),
      onClosed: (reason) => {
        const who = viewersRef.current.find((item) => item.key === key)?.hostName;
        removeViewer(key);
        toast(who ? `${who}: ${reason}` : reason);
      },
    });
    viewerRoomsRef.current.set(key, room);
    try {
      await room.join(serverUrlRef.current, code, nameRef.current);
      // As demais começam silenciadas se já houver uma com som, para o áudio não virar bagunça.
      const othersWithSound = viewersRef.current.some((item) => !item.muted);
      setViewers((list) => [...list, { key, code: room.roomCode, hostName: room.hostName, stream: null, state: "connecting", volume: readStoredVolume(), muted: othersWithSound, blocked: false }]);
      setJoining(null); setCodeInput(""); setView("group");
    } catch (error) {
      viewerRoomsRef.current.delete(key);
      room.close();
      setJoining(null);
      if (!(error instanceof CancelledError)) setFormError(errorText(error, "Não foi possível entrar na transmissão."));
    }
  }

  function cancelJoining() {
    if (joining) viewerRoomsRef.current.get(joining.key)?.close();
  }

  function leaveViewer(key: string) {
    viewerRoomsRef.current.get(key)?.close();
    removeViewer(key);
  }

  function setViewerVolume(key: string, value: number) {
    const volume = Math.min(100, Math.max(0, Math.round(value)));
    writeStored(VOLUME_KEY, String(volume));
    updateViewer(key, { volume, muted: volume === 0 });
  }

  function toggleViewerMute(key: string) {
    const current = viewersRef.current.find((item) => item.key === key);
    if (!current) return;
    const muted = !current.muted;
    updateViewer(key, { muted, volume: !muted && current.volume === 0 ? 50 : current.volume });
  }

  function enableSound(key: string) {
    const video = videoRefs.current.get(key);
    void video?.play().then(() => updateViewer(key, { blocked: false })).catch(() => undefined);
  }

  function toggleFullscreen(key: string) {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void tileRefs.current.get(key)?.requestFullscreen();
  }

  /* ---------- configurações ---------- */
  function changeTheme(next: ThemeChoice) { setTheme(next); writeStored(THEME_KEY, next); }

  function changeQuality(next: Quality) {
    qualityRef.current = next;
    setQuality(next); writeStored(QUALITY_KEY, next);
    hostRoomRef.current?.setLimits(limitsFor(next)); // o limite de internet muda na hora; resolução e fps na próxima captura
  }

  function changeAudioMode(next: AudioMode) { setAudioMode(next); writeStored(AUDIO_KEY, next); }

  function changeAccessChoice(next: Access) { setAccess(next); writeStored(ACCESS_KEY, next); }

  function commitName(value: string) {
    const clean = value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 24);
    if (!clean) return;
    setName(clean); setNameDraft(clean); writeStored(NAME_KEY, clean);
  }

  function openSettings() {
    setSettingsInput(serverUrl); setNameDraft(name);
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
            const message = JSON.parse(String(event.data)) as { type?: string; version?: number };
            if (message.type !== "connected") return;
            window.clearTimeout(timer); socket.close();
            if (typeof message.version !== "number" || message.version < 2) reject(new Error(OUTDATED_SERVER)); else resolve();
          } catch { /* ignora */ }
        };
        socket.onerror = () => { window.clearTimeout(timer); reject(new Error("Não foi possível conectar. Confira o endereço e se o serviço está no ar.")); };
      });
      setTestResult({ state: "ok", message: "Tudo certo! O servidor do TelaLink respondeu." });
    } catch (error) {
      setTestResult({ state: "fail", message: errorText(error, "Falha ao testar o servidor.") });
    }
  }

  function saveServer(nextRaw: string | null) {
    const next = nextRaw === null ? DEFAULT_SIGNALING_URL : normalizeServerUrl(nextRaw);
    if (!next) { setTestResult({ state: "fail", message: "Digite um endereço válido antes de salvar." }); return; }
    writeStored(URL_KEY, nextRaw === null ? null : next);
    serverUrlRef.current = next;
    setServerUrl(next); setSettingsInput(next);
    setTestResult({ state: "ok", message: "Servidor salvo." });
  }

  /* ---------- navegação ---------- */
  function goTo(next: View) {
    setFormError("");
    if (next === "transmit" && hostRoomRef.current) { setView("group"); return; }
    setView(next);
    if (next === "transmit") void loadSources("transmit");
  }

  /* ---------- efeitos ---------- */
  useEffect(() => { serverUrlRef.current = serverUrl; }, [serverUrl]);
  useEffect(() => { qualityRef.current = quality; }, [quality]);

  useEffect(() => {
    if (view !== "transmit" && !showSwitcher) return;
    void window.telalink?.audio?.plan().then(setAudioPlan).catch(() => undefined);
  }, [view, showSwitcher]);

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
    if (view === "transmit" && !host && sources.length === 0) void loadSources("transmit");
  }, [view, host, sources.length, loadSources]);

  useEffect(() => {
    if (view !== "transmit" && !showSwitcher && sources.length > 0) setSources([]);
  }, [view, showSwitcher, sources.length]);

  useEffect(() => {
    if (view === "group" && !host && viewers.length === 0) setView("home");
  }, [view, host, viewers.length]);

  useEffect(() => {
    const element = localVideoRef.current;
    if (element && mediaStream && element.srcObject !== mediaStream) element.srcObject = mediaStream;
  });

  useEffect(() => {
    for (const item of viewers) {
      const video = videoRefs.current.get(item.key);
      if (!video) continue;
      video.volume = item.muted ? 0 : item.volume / 100;
      video.muted = item.muted;
    }
  }, [viewers]);

  useEffect(() => () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    hostRoomRef.current?.close();
    for (const room of viewerRoomsRef.current.values()) room.close();
  }, []);

  /* ---------- derivados de exibição ---------- */
  const watching = viewers.length;
  const tileKeys = [...(host ? ["host"] : []), ...viewers.map((item) => item.key)];
  const focused = focusKey && tileKeys.length > 1 && tileKeys.includes(focusKey) ? focusKey : null;
  const live = Boolean(mediaStream);
  audioModeRef.current = audioMode === "computer" && audioPlan.available ? "computer" : "none";

  let headerTitle = "Início";
  let headerDesc = "Compartilhe sua tela ou assista à de alguém";
  let headerIcon = <Icon d={PATHS.home} />;
  if (view === "transmit") { headerTitle = "Transmitir minha tela"; headerDesc = "Escolha o que você quer mostrar"; headerIcon = <ScreenIcon />; }
  else if (view === "connect") { headerTitle = "Conectar a uma tela"; headerDesc = "Entre com o código da transmissão"; headerIcon = <LinkIcon />; }
  else if (view === "group") { headerTitle = "Transmissões"; headerDesc = `${tileKeys.length} ${tileKeys.length === 1 ? "caixa" : "caixas"} ao vivo`; headerIcon = <Icon d={PATHS.eye} />; }

  const userStatus = host ? "Transmitindo" : watching > 0 ? `Assistindo ${watching}` : "Disponível";

  /* ---------- caixas (tiles) ---------- */
  function renderOwnTile() {
    if (!host) return null;
    const isMain = focused === "host";
    return (
      <div key="host" ref={(element) => { if (element) tileRefs.current.set("host", element); else tileRefs.current.delete("host"); }} className={`tile own ${isMain ? "main" : ""}`}>
        <div className="tile-body">
          {live && showPreview && <video ref={localVideoRef} autoPlay muted playsInline />}
          {live && !showPreview && <div className="tile-empty"><ScreenIcon /><span>Prévia oculta</span></div>}
          {!live && (
            <div className="tile-empty">
              <ScreenIcon />
              <span className="tile-empty-title">Transmissão pausada</span>
              <button className="btn btn-green" onClick={() => void resumeHost()}>Retomar</button>
            </div>
          )}
        </div>
        <div className="tile-top">
          <span className="tile-name">{name || "Você"} (você)</span>
          <span className={`badge ${live ? "" : "paused"}`}>{live && <span className="live-dot" />}{live ? "AO VIVO" : "PAUSADO"}</span>
          <span className="badge chip"><Icon d={PATHS.eye} />{host.members.length}</span>
        </div>
        <div className="tile-controls">
          <span className="spacer" />
          {tileKeys.length > 1 && <button className="tile-btn tip" data-tip={isMain ? "Voltar à grade" : "Destacar"} aria-label={isMain ? "Voltar à grade" : "Destacar"} onClick={() => setFocusKey(isMain ? null : "host")}><Icon d={PATHS.expand} /></button>}
          <button className="tile-btn tip" data-tip="Tela cheia" aria-label="Tela cheia" onClick={() => toggleFullscreen("host")}><Icon d={PATHS.fullscreen} /></button>
        </div>
      </div>
    );
  }

  function renderViewerTile(item: ViewerInfo) {
    const isMain = focused === item.key;
    const level = item.muted ? 0 : item.volume;
    return (
      <div key={item.key} ref={(element) => { if (element) tileRefs.current.set(item.key, element); else tileRefs.current.delete(item.key); }} className={`tile ${isMain ? "main" : ""}`}>
        <div className="tile-body">
          {item.stream ? (
            <video
              ref={(element) => {
                if (!element) { videoRefs.current.delete(item.key); return; }
                videoRefs.current.set(item.key, element);
                if (element.srcObject !== item.stream) {
                  element.volume = item.muted ? 0 : item.volume / 100;
                  element.muted = item.muted;
                  element.srcObject = item.stream;
                  void element.play().catch((error: unknown) => { if (error instanceof DOMException && error.name === "NotAllowedError" && !element.muted) updateViewer(item.key, { blocked: true }); });
                }
              }}
              autoPlay
              playsInline
              onDoubleClick={() => toggleFullscreen(item.key)}
            />
          ) : (
            <div className="tile-empty"><div className="spinner" /><span>{item.state === "failed" ? "Não foi possível conectar" : "Conectando…"}</span></div>
          )}
          {item.blocked && <button className="btn btn-brand tile-sound" onClick={() => enableSound(item.key)}><Icon d={PATHS.volumeUp} />Ativar som</button>}
        </div>
        <div className="tile-top">
          <Avatar name={item.hostName} size={22} />
          <span className="tile-name">{item.hostName}</span>
          <span className="badge"><span className="live-dot" />AO VIVO</span>
        </div>
        <div className="tile-controls">
          <div className="tile-volume">
            <button className="tile-btn tip" data-tip={item.muted || item.volume === 0 ? "Ativar som" : "Silenciar"} aria-label={item.muted ? "Ativar som" : "Silenciar"} onClick={() => toggleViewerMute(item.key)}><Icon d={volumeIconPath(item.volume, item.muted)} /></button>
            <input className="volume mini" type="range" min={0} max={100} step={1} value={level} style={{ "--fill": `${level}%` } as CSSProperties} onChange={(event) => setViewerVolume(item.key, Number(event.target.value))} aria-label={`Volume de ${item.hostName}`} />
          </div>
          <span className="spacer" />
          {tileKeys.length > 1 && <button className="tile-btn tip" data-tip={isMain ? "Voltar à grade" : "Destacar"} aria-label={isMain ? "Voltar à grade" : "Destacar"} onClick={() => setFocusKey(isMain ? null : item.key)}><Icon d={PATHS.expand} /></button>}
          <button className="tile-btn tip" data-tip="Tela cheia" aria-label="Tela cheia" onClick={() => toggleFullscreen(item.key)}><Icon d={isMain ? PATHS.fullscreen : PATHS.fullscreen} /></button>
          <button className="tile-btn danger tip" data-tip="Sair desta transmissão" aria-label={`Sair da transmissão de ${item.hostName}`} onClick={() => leaveViewer(item.key)}><Icon d={PATHS.hangup} /></button>
        </div>
      </div>
    );
  }

  const gridStyle = focused ? ({ "--others": tileKeys.length - 1 } as CSSProperties) : undefined;

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
            <button className={`nav-item ${view === "home" ? "active" : ""}`} onClick={() => goTo("home")}><Icon d={PATHS.home} /><span>Início</span></button>
            {(host || watching > 0) && <button className={`nav-item ${view === "group" ? "active" : ""}`} onClick={() => goTo("group")}><Icon d={PATHS.eye} /><span>Transmissões</span></button>}
            <div className="side-label">Compartilhar</div>
            <button className={`nav-item ${view === "transmit" ? "active" : ""}`} onClick={() => goTo("transmit")}><ScreenIcon /><span>{host ? "Minha transmissão" : "Transmitir minha tela"}</span></button>
            <button className={`nav-item ${view === "connect" ? "active" : ""}`} onClick={() => goTo("connect")}><LinkIcon /><span>Conectar a uma tela</span></button>

            {host && (
              <>
                <div className="side-label">Na sua transmissão — {host.members.length + 1}</div>
                <div className="member"><Avatar name={name || "Você"} live={live} /><span className="member-name">{name || "Você"}</span><span className="member-tag">Você</span></div>
                {host.members.map((member) => (
                  <div className="member" key={member.id}>
                    <Avatar name={member.name} />
                    <span className="member-name">{member.name}</span>
                    <button className="icon-btn member-action tip tip-right" data-tip="Remover" aria-label={`Remover ${member.name}`} onClick={() => hostRoomRef.current?.kick(member.id)}><Icon d={PATHS.close} /></button>
                  </div>
                ))}
              </>
            )}

            {watching > 0 && (
              <>
                <div className="side-label">Assistindo — {watching}/{MAX_WATCH}</div>
                {viewers.map((item) => (
                  <div className="member clickable" key={item.key} onClick={() => { setView("group"); setFocusKey(item.key); }}>
                    <Avatar name={item.hostName} live={item.state === "live"} />
                    <span className="member-name">{item.hostName}</span>
                    <button className="icon-btn member-action danger tip tip-right" data-tip="Sair" aria-label={`Sair da transmissão de ${item.hostName}`} onClick={(event) => { event.stopPropagation(); leaveViewer(item.key); }}><Icon d={PATHS.hangup} /></button>
                  </div>
                ))}
              </>
            )}
          </div>

          {host && (
            <div className="voice-panel">
              <div className="voice-info">
                <div className="voice-title"><Icon d={PATHS.signal} />Transmitindo</div>
                <div className="voice-sub">{host.code}</div>
              </div>
              <button className="icon-btn danger tip tip-right" data-tip="Encerrar transmissão" aria-label="Encerrar transmissão" onClick={endHosting}><Icon d={PATHS.hangup} /></button>
            </div>
          )}

          <div className="user-panel">
            <span className="avatar" style={{ background: "#5865f2" }}>{initials(name || "?")}<span className={`dot ${host || watching > 0 ? "online" : ""}`} /></span>
            <div className="user-meta">
              <div className="user-name">{name || "Você"}</div>
              <div className="user-status">{userStatus}</div>
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
          </header>

          <div className="main-body">
            {/* ----- início ----- */}
            {view === "home" && (
              <section className="home">
                <h1>Sua tela, em qualquer lugar</h1>
                <p className="lead">Compartilhe sua tela em tempo real ou entre em uma transmissão usando apenas um código.</p>
                <div className="action-grid">
                  <button className="action-card" onClick={() => goTo("transmit")}>
                    <span className="action-icon green"><ScreenIcon /></span>
                    <span className="action-title">Transmitir minha tela</span>
                    <span className="action-copy">Crie uma transmissão e compartilhe o código com quem você quiser.</span>
                    <span className="action-link">Iniciar transmissão →</span>
                  </button>
                  <button className="action-card" onClick={() => goTo("connect")}>
                    <span className="action-icon brand"><LinkIcon /></span>
                    <span className="action-title">Conectar a uma tela</span>
                    <span className="action-copy">Digite o código para assistir. Dá para assistir a até {MAX_WATCH} transmissões ao mesmo tempo.</span>
                    <span className="action-link">Inserir código →</span>
                  </button>
                </div>
              </section>
            )}

            {/* ----- escolher o que transmitir ----- */}
            {view === "transmit" && !host && (
              <section className="panel transmit">
                <div className="panel-header"><h2>Ir ao vivo</h2></div>
                <div className="panel-body">
                  <SourceChooser
                    sources={sources}
                    loading={loadingSources}
                    kind={sourceKind}
                    onKind={(kind) => chooseKind(kind, setSelectedSourceId, setSourceKind)}
                    selectedId={selectedSourceId}
                    onSelect={setSelectedSourceId}
                    onRefresh={() => void loadSources("transmit")}
                  />
                  <div className="quality-block">
                    <AudioChooser mode={audioMode} onMode={changeAudioMode} plan={audioPlan} watching={watching} />
                  </div>
                  <div className="quality-block">
                    <div className="field-label">Quem pode entrar</div>
                    <div className="segmented" role="radiogroup" aria-label="Quem pode entrar">
                      {([["approval", "Com solicitação"], ["open", "Aberta (só o código)"]] as const).map(([key, label]) => (
                        <button key={key} type="button" role="radio" aria-checked={access === key} className={access === key ? "active" : ""} onClick={() => changeAccessChoice(key)}>{label}</button>
                      ))}
                    </div>
                    <div className="hint">{access === "approval" ? "Quem digitar o código precisa da sua confirmação para entrar." : "Quem tiver o código entra direto."}</div>
                  </div>
                  <div className="quality-block">
                    <div className="field-label">Qualidade da transmissão</div>
                    <QualityPicker value={quality} onChange={changeQuality} />
                  </div>
                  {formError && <div className="error-box">{formError}</div>}
                </div>
                <div className="panel-footer">
                  <span className="spacer" />
                  <button className="btn btn-ghost" onClick={() => goTo("home")}>Cancelar</button>
                  <button className="btn btn-green" onClick={() => void goLive()} disabled={busy || !selectedSourceId}>{busy ? "Preparando…" : "Ir ao vivo"}</button>
                </div>
              </section>
            )}

            {/* ----- digitar o código ----- */}
            {view === "connect" && (
              <form className="panel narrow" onSubmit={(event) => { event.preventDefault(); void joinTransmission(); }}>
                <div className="panel-header center">
                  <h2>Entrar em uma transmissão</h2>
                  <p>Peça o código para quem está compartilhando a tela.</p>
                </div>
                <div className="panel-body">
                  <label className="field-label" htmlFor="room-code">Código da transmissão</label>
                  <input id="room-code" className="input code" value={codeInput} onChange={(event) => setCodeInput(event.target.value.toUpperCase())} placeholder="TL-ABC123" maxLength={9} autoComplete="off" autoFocus disabled={Boolean(joining)} />
                  {joining?.pending && <div className="waiting"><div className="spinner small" />Aguardando o anfitrião aprovar sua entrada…</div>}
                  {formError && <div className="error-box">{formError}</div>}
                </div>
                <div className="panel-footer">
                  <button type="button" className="btn btn-ghost" onClick={() => (joining ? cancelJoining() : goTo(watching > 0 || host ? "group" : "home"))}>{joining ? "Cancelar pedido" : "Voltar"}</button>
                  <span className="spacer" />
                  <button className="btn btn-brand" type="submit" disabled={Boolean(joining) || !codeInput.trim()}>{joining ? "Conectando…" : "Conectar"}</button>
                </div>
              </form>
            )}

            {/* ----- caixas das transmissões ----- */}
            {view === "group" && (
              <section className="group">
                {host && (
                  <div className="host-bar">
                    <div className="code-box">
                      <span className="code-caption">Código da sua transmissão</span>
                      <span className="code-value">{host.code}</span>
                    </div>
                    <button className="btn btn-brand" onClick={() => void copyCode()}><Icon d={copied ? PATHS.check : PATHS.copy} />{copied ? "Copiado!" : "Copiar"}</button>
                    <div className="host-access">
                      <span className="code-caption">Quem pode entrar</span>
                      <div className="segmented small" role="radiogroup" aria-label="Quem pode entrar">
                        {([["approval", "Com solicitação"], ["open", "Aberta"]] as const).map(([key, label]) => (
                          <button key={key} type="button" role="radio" aria-checked={host.access === key} className={host.access === key ? "active" : ""} onClick={() => changeAccess(key)}>{label}</button>
                        ))}
                      </div>
                    </div>
                    <div className="member-chips">
                      <span className="code-caption">Na sua transmissão{host.members.length === 0 ? ": ninguém ainda" : ` — ${host.members.length}`}</span>
                      {host.members.length > 0 && (
                        <div className="chip-list">
                          {host.members.map((member) => (
                            <span className="chip-member" key={member.id}>
                              <Avatar name={member.name} size={22} />
                              <span className="chip-name">{member.name}</span>
                              <button className="chip-x tip" data-tip="Remover da transmissão" aria-label={`Remover ${member.name}`} onClick={() => hostRoomRef.current?.kick(member.id)}><Icon d={PATHS.close} /></button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className={`tiles ${focused ? "focused" : ""}`} data-count={tileKeys.length} style={gridStyle}>
                  {host && renderOwnTile()}
                  {viewers.map((item) => renderViewerTile(item))}
                </div>

                <div className="call-controls">
                  {host && <button className="round-btn tip" data-tip="Trocar tela ou janela" aria-label="Trocar tela ou janela" onClick={openSwitcher}><Icon d={PATHS.swap} /></button>}
                  {host && live && <button className="round-btn tip" data-tip={showPreview ? "Ocultar prévia" : "Mostrar prévia"} aria-label={showPreview ? "Ocultar prévia" : "Mostrar prévia"} onClick={() => setShowPreview((current) => !current)}><Icon d={showPreview ? PATHS.eye : PATHS.eyeOff} /></button>}
                  {host && <button className="round-btn tip" data-tip={live ? "Pausar transmissão" : "Retomar transmissão"} aria-label={live ? "Pausar transmissão" : "Retomar transmissão"} onClick={() => (live ? void pauseHost() : void resumeHost())}><Icon d={live ? PATHS.pause : PATHS.play} /></button>}
                  {!host && <button className="round-btn green tip" data-tip="Transmitir minha tela" aria-label="Transmitir minha tela" onClick={() => goTo("transmit")}><ScreenIcon /></button>}
                  {watching < MAX_WATCH && <button className="round-btn tip" data-tip="Entrar em outra transmissão" aria-label="Entrar em outra transmissão" onClick={() => goTo("connect")}><Icon d={PATHS.add} /></button>}
                  {host && <button className="round-btn danger tip" data-tip="Encerrar minha transmissão" aria-label="Encerrar minha transmissão" onClick={endHosting}><Icon d={PATHS.hangup} /></button>}
                </div>
              </section>
            )}
          </div>
        </main>
      </div>

      {/* ===== pedidos de entrada (aparecem em qualquer tela) ===== */}
      {requests.length > 0 && (
        <div className="requests" role="alert">
          {requests.map((request) => (
            <div className="request" key={request.id}>
              <Avatar name={request.name} />
              <div className="request-text"><strong>{request.name}</strong> quer entrar na sua transmissão</div>
              <button className="btn btn-secondary" onClick={() => decide(request, false)}>Recusar</button>
              <button className="btn btn-green" onClick={() => decide(request, true)}>Permitir</button>
            </div>
          ))}
        </div>
      )}

      {toasts.length > 0 && (
        <div className="toasts" role="status">
          {toasts.map((item) => <div className="toast-item" key={item.id}>{item.text}</div>)}
        </div>
      )}

      {/* ===== primeiro uso: escolher o nome ===== */}
      {!name && (
        <div className="modal-backdrop">
          <form className="modal" role="dialog" aria-modal="true" aria-label="Seu nome" onSubmit={(event) => { event.preventDefault(); commitName(nameDraft); }}>
            <div className="panel-header"><h2>Como você quer ser chamado?</h2><p>Esse nome aparece para as pessoas nas transmissões.</p></div>
            <div className="panel-body">
              <label className="field-label" htmlFor="first-name">Seu nome</label>
              <input id="first-name" className="input" value={nameDraft} maxLength={24} autoFocus autoComplete="off" onChange={(event) => setNameDraft(event.target.value)} />
            </div>
            <div className="panel-footer"><span className="spacer" /><button className="btn btn-brand" type="submit" disabled={!nameDraft.trim()}>Continuar</button></div>
          </form>
        </div>
      )}

      {/* ===== trocar tela/janela ao vivo ===== */}
      {showSwitcher && host && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !switching) closeSwitcher(); }}>
          <div className="modal wide" role="dialog" aria-modal="true" aria-label="Trocar tela ou janela">
            <div className="panel-header"><h2>Trocar tela ou janela</h2></div>
            <div className="panel-body settings-body">
              <SourceChooser
                sources={sources}
                loading={loadingSources}
                kind={pickKind}
                onKind={(kind) => chooseKind(kind, setPickSourceId, setPickKind)}
                selectedId={pickSourceId}
                onSelect={setPickSourceId}
                onRefresh={() => void loadSources("switch")}
              />
              <div className="quality-block">
                <AudioChooser mode={audioMode} onMode={changeAudioMode} plan={audioPlan} watching={watching} />
              </div>
              {switchError && <div className="error-box">{switchError}</div>}
            </div>
            <div className="panel-footer">
              <span className="spacer" />
              <button className="btn btn-ghost" onClick={closeSwitcher} disabled={switching}>Cancelar</button>
              <button className="btn btn-green" onClick={() => void confirmSwitch()} disabled={switching || !pickSourceId}>{switching ? "Trocando…" : "Compartilhar"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== configurações ===== */}
      {showSettings && name && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Configurações">
            <div className="panel-header"><h2>Configurações</h2></div>
            <div className="panel-body settings-body">
              <div className="setting-block">
                <label className="field-label" htmlFor="user-name">Seu nome</label>
                <input id="user-name" className="input" value={nameDraft} maxLength={24} autoComplete="off" onChange={(event) => setNameDraft(event.target.value)} onBlur={() => commitName(nameDraft)} onKeyDown={(event) => { if (event.key === "Enter") commitName(nameDraft); }} />
              </div>

              <div className="setting-block">
                <div className="field-label">Aparência</div>
                <div className="segmented" role="radiogroup" aria-label="Tema">
                  {([["dark", "Escuro"], ["light", "Claro"], ["system", "Automático"]] as const).map(([key, label]) => (
                    <button key={key} type="button" role="radio" aria-checked={theme === key} className={theme === key ? "active" : ""} onClick={() => changeTheme(key)}>{label}</button>
                  ))}
                </div>
              </div>

              <div className="setting-block">
                <div className="field-label">Qualidade da transmissão</div>
                <QualityPicker value={quality} onChange={changeQuality} />
              </div>

              <details className="setting-block advanced">
                <summary>Avançado · servidor de salas</summary>
                <label className="field-label" htmlFor="server-url">Endereço do servidor</label>
                <input id="server-url" className="input mono" value={settingsInput} onChange={(event) => { setSettingsInput(event.target.value); setTestResult({ state: "idle", message: "" }); }} placeholder="wss://seu-servico.onrender.com" spellCheck={false} autoComplete="off" disabled={Boolean(host) || watching > 0} />
                {(host || watching > 0) && <div className="hint">Saia das transmissões para alterar o servidor.</div>}
                {testResult.state !== "idle" && <div className={`test-result ${testResult.state}`}>{testResult.message}</div>}
                <div className="advanced-actions">
                  <button className="btn btn-ghost" onClick={() => saveServer(null)} disabled={Boolean(host) || watching > 0}>Restaurar padrão</button>
                  <span className="spacer" />
                  <button className="btn btn-secondary" onClick={() => void testServerUrl()} disabled={testResult.state === "testing"}>Testar</button>
                  <button className="btn btn-brand" onClick={() => saveServer(settingsInput)} disabled={Boolean(host) || watching > 0}>Salvar</button>
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

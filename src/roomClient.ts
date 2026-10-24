// Conexão com o servidor de salas e com as pessoas (WebRTC).
// Cada transmissão usa uma conexão própria: dá para ser anfitrião de uma e assistir a várias outras ao mesmo tempo.

export type Access = "approval" | "open";
export type Member = { id: string; name: string };
export type JoinRequest = { id: string; name: string };
export type VideoLimits = { bitrate: number; fps: number };
export type ViewerState = "connecting" | "live" | "failed";

type SignalPayload = { kind?: "offer" | "answer" | "candidate"; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type ServerMessage = {
  type: string;
  roomCode?: string;
  clientId?: string;
  participantId?: string;
  requestId?: string;
  name?: string;
  hostName?: string;
  message?: string;
  access?: Access;
  from?: string;
  payload?: SignalPayload;
};

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export class CancelledError extends Error {}

// Servidores antigos não conhecem nomes, solicitação de entrada nem remoção de pessoas.
export const OUTDATED_SERVER = "O servidor do TelaLink está desatualizado. Atualize a pasta server no Render para usar nomes, solicitação de entrada e remover pessoas.";

export function isLocalUrl(url: string) {
  return /localhost|127\.0\.0\.1/.test(url);
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try { socket = new WebSocket(url); }
    catch { reject(new Error("Endereço do servidor inválido. Confira em Configurações → Avançado.")); return; }
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new Error("O servidor demorou para responder. Se ele estava dormindo, tente de novo em 1 minuto."));
    }, isLocalUrl(url) ? 12000 : 90000);
    socket.addEventListener("open", () => { window.clearTimeout(timer); resolve(socket); }, { once: true });
    socket.addEventListener("error", () => { window.clearTimeout(timer); reject(new Error("Não foi possível acessar o servidor de salas.")); }, { once: true });
  });
}

function describe(pc: RTCPeerConnection): RTCSessionDescriptionInit | undefined {
  return pc.localDescription ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : undefined;
}

type Waiter = { types: string[]; resolve: (message: ServerMessage) => void; reject: (error: Error) => void; timer: number };

abstract class RoomBase {
  roomCode = "";
  clientId = "";
  protected socket: WebSocket | null = null;
  protected closed = false;
  private keepAlive: number | undefined;
  private waiter: Waiter | null = null;

  protected async connect(url: string) {
    const socket = await openSocket(url);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)) as ServerMessage; } catch { return; }
      const waiter = this.waiter;
      if (waiter) {
        if (message.type === "error" || message.type === "join-denied") {
          this.waiter = null; window.clearTimeout(waiter.timer);
          waiter.reject(new Error(message.message ?? "Não foi possível concluir a operação."));
          return;
        }
        if (waiter.types.includes(message.type)) {
          this.waiter = null; window.clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
      this.onMessage(message);
    });
    socket.addEventListener("close", () => {
      if (this.closed) return;
      this.shutdown("A conexão com o servidor foi perdida.");
    });
    this.keepAlive = window.setInterval(() => this.send({ type: "keep-alive" }), 5 * 60 * 1000);
  }

  protected send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  protected waitFor(types: string[], timeoutMs: number): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiter = null;
        reject(new Error("O servidor não respondeu a tempo. Tente de novo."));
      }, timeoutMs);
      this.waiter = { types, resolve, reject, timer };
    });
  }

  protected abstract onMessage(message: ServerMessage): void;
  protected abstract teardown(): void;
  protected abstract notifyClosed(reason: string): void;

  // Encerramento causado por falha ou pelo servidor.
  protected shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.keepAlive);
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) { window.clearTimeout(waiter.timer); waiter.reject(new Error(reason)); }
    this.teardown();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
    this.notifyClosed(reason);
  }

  // Encerramento pedido pela própria pessoa.
  close() {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.keepAlive);
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) { window.clearTimeout(waiter.timer); waiter.reject(new CancelledError("cancelado")); }
    if (this.socket?.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify({ type: "leave-room" })); } catch { /* conexão já fechando */ }
    }
    this.teardown();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

/* ---------------------------------------------------------------- anfitrião */

export type HostHandlers = {
  onMembers: (members: Member[]) => void;
  onRequest: (request: JoinRequest) => void;
  onRequestGone: (id: string) => void;
  onClosed: (reason: string) => void;
};

type HostPeer = { name: string; pc: RTCPeerConnection; queued: RTCIceCandidateInit[]; dirty: boolean };

export class HostRoom extends RoomBase {
  access: Access = "approval";
  private peers = new Map<string, HostPeer>();
  private stream: MediaStream | null = null;

  constructor(private handlers: HostHandlers, private limits: VideoLimits) { super(); }

  async create(url: string, name: string, access: Access): Promise<string> {
    await this.connect(url);
    const created = this.waitFor(["room-created"], 15000);
    this.send({ type: "create-room", name, access });
    const message = await created;
    this.roomCode = message.roomCode ?? "";
    this.clientId = message.clientId ?? "";
    this.access = message.access ?? access;
    if (message.access === undefined) { this.close(); throw new Error(OUTDATED_SERVER); }
    if (!this.roomCode) throw new Error("O servidor não retornou o código da transmissão.");
    return this.roomCode;
  }

  decide(requestId: string, allow: boolean) { this.send({ type: "join-decision", requestId, allow }); }
  kick(participantId: string) { this.send({ type: "kick", participantId }); }
  setAccess(access: Access) { this.access = access; this.send({ type: "set-access", access }); }

  setLimits(limits: VideoLimits) {
    this.limits = limits;
    for (const peer of this.peers.values()) void this.applyLimits(peer.pc);
  }

  // Define (ou troca) o que está sendo transmitido. As conexões abertas são reaproveitadas: quem assiste não precisa reconectar.
  async setStream(stream: MediaStream | null) {
    this.stream = stream;
    await Promise.all([...this.peers.keys()].map((id) => this.sync(id)));
  }

  protected onMessage(message: ServerMessage) {
    switch (message.type) {
      case "participant-joined":
        if (message.participantId) this.addPeer(message.participantId, message.name ?? "Convidado");
        break;
      case "participant-left":
        if (message.participantId) this.removePeer(message.participantId);
        break;
      case "join-request":
        if (message.requestId) this.handlers.onRequest({ id: message.requestId, name: message.name ?? "Convidado" });
        break;
      case "request-cancelled":
        if (message.requestId) this.handlers.onRequestGone(message.requestId);
        break;
      case "access-changed":
        if (message.access) this.access = message.access;
        break;
      case "signal":
        if (message.from && message.payload) void this.handleSignal(message.from, message.payload);
        break;
    }
  }

  protected teardown() {
    for (const peer of this.peers.values()) { peer.pc.onicecandidate = null; peer.pc.close(); }
    this.peers.clear();
  }

  protected notifyClosed(reason: string) { this.handlers.onClosed(reason); }

  private members(): Member[] {
    return [...this.peers.entries()].map(([id, peer]) => ({ id, name: peer.name }));
  }

  private addPeer(id: string, name: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (event) => {
      if (event.candidate) this.send({ type: "signal", to: id, payload: { kind: "candidate", candidate: event.candidate.toJSON() } });
    };
    this.peers.set(id, { name, pc, queued: [], dirty: false });
    this.handlers.onMembers(this.members());
    if (this.stream) void this.sync(id);
  }

  private removePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onicecandidate = null; peer.pc.close();
    this.peers.delete(id);
    this.handlers.onMembers(this.members());
  }

  private async applyLimits(pc: RTCPeerConnection) {
    const sender = pc.getSenders().find((item) => item.track?.kind === "video");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = this.limits.bitrate;
      params.encodings[0].maxFramerate = this.limits.fps;
      await sender.setParameters(params);
    } catch (error) { console.warn("Não foi possível aplicar o limite de qualidade", error); }
  }

  private async sync(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    const pc = peer.pc;
    if (pc.signalingState !== "stable") { peer.dirty = true; return; } // há uma negociação em andamento; refaz ao terminar
    let needsOffer = false;
    try {
      for (const kind of ["video", "audio"] as const) {
        const track = this.stream?.getTracks().find((item) => item.kind === kind) ?? null;
        const transceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === kind);
        if (transceiver) {
          if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track);
        } else if (track && this.stream) {
          pc.addTrack(track, this.stream);
          needsOffer = true;
        }
      }
      if (!needsOffer) { await this.applyLimits(pc); return; }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.applyLimits(pc);
      this.send({ type: "signal", to: id, payload: { kind: "offer", description: describe(pc) } });
    } catch (error) { console.error("Falha ao preparar a conexão com um espectador", error); }
  }

  private async handleSignal(from: string, payload: SignalPayload) {
    const peer = this.peers.get(from);
    if (!peer) return;
    try {
      if (payload.kind === "answer" && payload.description) {
        await peer.pc.setRemoteDescription(payload.description);
        for (const candidate of peer.queued.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => undefined);
        if (peer.dirty) { peer.dirty = false; void this.sync(from); }
      } else if (payload.kind === "candidate" && payload.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(payload.candidate).catch(() => undefined);
        else peer.queued.push(payload.candidate);
      }
    } catch (error) { console.error("Erro na negociação WebRTC", error); }
  }
}

/* ------------------------------------------------------------- espectador */

export type ViewerHandlers = {
  onPending: () => void;
  onStream: (stream: MediaStream) => void;
  onState: (state: ViewerState) => void;
  onClosed: (reason: string) => void;
};

export class ViewerRoom extends RoomBase {
  hostName = "";
  private pc: RTCPeerConnection | null = null;
  private queued: RTCIceCandidateInit[] = [];

  constructor(private handlers: ViewerHandlers) { super(); }

  // Resolve quando a pessoa entra (depois da aprovação do anfitrião, se necessário).
  async join(url: string, code: string, name: string): Promise<void> {
    await this.connect(url);
    const joined = this.waitFor(["room-joined"], 130000);
    this.send({ type: "join-room", roomCode: code, name });
    const message = await joined;
    this.roomCode = message.roomCode ?? code;
    this.clientId = message.clientId ?? "";
    if (message.hostName === undefined) { this.close(); throw new Error(OUTDATED_SERVER); }
    this.hostName = message.hostName;
  }

  protected onMessage(message: ServerMessage) {
    switch (message.type) {
      case "join-pending":
        this.handlers.onPending();
        break;
      case "room-closed":
      case "kicked":
        this.shutdown(message.message ?? "A transmissão foi encerrada.");
        break;
      case "signal":
        if (message.payload) void this.handleSignal(message.payload);
        break;
    }
  }

  protected teardown() {
    if (this.pc) { this.pc.ontrack = null; this.pc.onicecandidate = null; this.pc.onconnectionstatechange = null; this.pc.close(); }
    this.pc = null;
  }

  protected notifyClosed(reason: string) { this.handlers.onClosed(reason); }

  private createPc() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (event) => {
      if (event.candidate) this.send({ type: "signal", payload: { kind: "candidate", candidate: event.candidate.toJSON() } });
    };
    pc.ontrack = (event) => this.handlers.onStream(event.streams[0] ?? new MediaStream([event.track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.handlers.onState("live");
      else if (pc.connectionState === "failed") this.handlers.onState("failed");
      else if (pc.connectionState === "connecting") this.handlers.onState("connecting");
    };
    return pc;
  }

  private async handleSignal(payload: SignalPayload) {
    const pc = this.pc ?? (this.pc = this.createPc());
    try {
      if (payload.kind === "offer" && payload.description) {
        await pc.setRemoteDescription(payload.description);
        for (const candidate of this.queued.splice(0)) await pc.addIceCandidate(candidate).catch(() => undefined);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ type: "signal", payload: { kind: "answer", description: describe(pc) } });
      } else if (payload.kind === "candidate" && payload.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate).catch(() => undefined);
        else this.queued.push(payload.candidate);
      }
    } catch (error) { console.error("Erro na negociação WebRTC", error); }
  }
}

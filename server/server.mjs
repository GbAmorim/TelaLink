import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomInt, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT) || 3001;
const MAX_VIEWERS = 5; // pessoas assistindo uma mesma transmissão
const MAX_PENDING = 5; // pedidos de entrada aguardando resposta, por transmissão
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000; // o pedido expira se o anfitrião não responder
const JOIN_WINDOW_MS = 60 * 1000; // janela de contagem de tentativas de entrada
const JOIN_MAX_ATTEMPTS = 12; // tentativas de entrada por minuto, por endereço
const ACCESS_MODES = new Set(["approval", "open"]);
const PROTOCOL_VERSION = 2; // o app compara esta versão para avisar quando o servidor está desatualizado

const httpServer = createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({ status: "ok", service: "TelaLink signaling" }),
        );
        return;
    }

    res.writeHead(404);
    res.end("Not found");
});

const wss = new WebSocketServer({ server: httpServer });
const rooms = new Map();
const clients = new Map();
const joinAttempts = new Map();

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function cleanName(value) {
    const name = String(value ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 24);
    return name || "Convidado";
}

function generateRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;

    do {
        code =
            "TL-" +
            Array.from(
                { length: 6 },
                () => alphabet[randomInt(alphabet.length)],
            ).join("");
    } while (rooms.has(code));

    return code;
}

function clientAddress(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded) {
        return forwarded.split(",")[0].trim();
    }
    return req.socket.remoteAddress ?? "desconhecido";
}

// Limita tentativas de entrada: dificulta testar códigos em massa.
function tooManyAttempts(address) {
    const now = Date.now();
    const recent = (joinAttempts.get(address) ?? []).filter(
        (time) => now - time < JOIN_WINDOW_MS,
    );
    if (recent.length >= JOIN_MAX_ATTEMPTS) {
        joinAttempts.set(address, recent);
        return true;
    }
    recent.push(now);
    joinAttempts.set(address, recent);
    return false;
}

setInterval(() => {
    const now = Date.now();
    for (const [address, times] of joinAttempts) {
        const recent = times.filter((time) => now - time < JOIN_WINDOW_MS);
        if (recent.length === 0) joinAttempts.delete(address);
        else joinAttempts.set(address, recent);
    }
}, 5 * 60 * 1000).unref();

function admit(room, entry) {
    room.participants.set(entry.id, { ws: entry.ws, id: entry.id, name: entry.name });
    clients.set(entry.ws, {
        id: entry.id,
        roomCode: room.code,
        role: "participant",
        name: entry.name,
    });

    send(entry.ws, {
        type: "room-joined",
        roomCode: room.code,
        clientId: entry.id,
        hostId: room.hostId,
        hostName: room.hostName,
        participantCount: room.participants.size + 1,
    });

    send(room.host, {
        type: "participant-joined",
        participantId: entry.id,
        name: entry.name,
        participantCount: room.participants.size + 1,
    });

    console.log(`Participante ${entry.id} entrou em ${room.code}.`);
}

function removeFromRoom(ws) {
    const client = clients.get(ws);
    if (!client) return;

    clients.delete(ws);

    const room = rooms.get(client.roomCode);
    if (!room) return;

    if (client.role === "host") {
        for (const participant of room.participants.values()) {
            send(participant.ws, {
                type: "room-closed",
                message: "O anfitrião encerrou a transmissão.",
            });
            clients.delete(participant.ws);
        }

        for (const request of room.pending.values()) {
            clearTimeout(request.timer);
            send(request.ws, {
                type: "join-denied",
                message: "A transmissão foi encerrada.",
            });
            clients.delete(request.ws);
        }

        rooms.delete(client.roomCode);
        console.log(`Sala ${client.roomCode} encerrada.`);
        return;
    }

    if (client.role === "pending") {
        const request = room.pending.get(client.requestId);
        if (request) {
            clearTimeout(request.timer);
            room.pending.delete(client.requestId);
            send(room.host, {
                type: "request-cancelled",
                requestId: client.requestId,
            });
        }
        return;
    }

    room.participants.delete(client.id);

    send(room.host, {
        type: "participant-left",
        participantId: client.id,
        participantCount: room.participants.size + 1,
    });
}

wss.on("connection", (ws, req) => {
    const clientId = randomUUID();
    const address = clientAddress(req);
    console.log(`Cliente conectado: ${clientId}`);

    send(ws, { type: "connected", clientId, version: PROTOCOL_VERSION });

    ws.on("message", (rawMessage) => {
        let message;

        try {
            message = JSON.parse(rawMessage.toString());
        } catch {
            send(ws, { type: "error", message: "Mensagem inválida." });
            return;
        }

        if (!message || typeof message.type !== "string") {
            send(ws, {
                type: "error",
                message: "Formato de mensagem inválido.",
            });
            return;
        }

        if (message.type === "keep-alive") return;

        if (message.type === "create-room") {
            if (clients.has(ws)) {
                send(ws, { type: "error", message: "Você já está em uma sala." });
                return;
            }

            const roomCode = generateRoomCode();
            const access = ACCESS_MODES.has(message.access)
                ? message.access
                : "approval";

            rooms.set(roomCode, {
                code: roomCode,
                host: ws,
                hostId: clientId,
                hostName: cleanName(message.name),
                access,
                participants: new Map(),
                pending: new Map(),
            });

            clients.set(ws, { id: clientId, roomCode, role: "host" });

            send(ws, {
                type: "room-created",
                roomCode,
                clientId,
                access,
                maxParticipants: MAX_VIEWERS,
            });

            console.log(`Sala ${roomCode} criada.`);
            return;
        }

        if (message.type === "join-room") {
            if (clients.has(ws)) {
                send(ws, { type: "error", message: "Você já está em uma sala." });
                return;
            }

            if (tooManyAttempts(address)) {
                send(ws, {
                    type: "error",
                    message: "Muitas tentativas. Aguarde um minuto e tente de novo.",
                });
                return;
            }

            if (typeof message.roomCode !== "string") {
                send(ws, { type: "error", message: "Código inválido." });
                return;
            }

            const roomCode = message.roomCode.trim().toUpperCase();
            const room = rooms.get(roomCode);

            if (!room || room.host.readyState !== WebSocket.OPEN) {
                send(ws, {
                    type: "error",
                    message: "Transmissão não encontrada ou encerrada.",
                });
                return;
            }

            if (room.participants.size >= MAX_VIEWERS) {
                send(ws, {
                    type: "error",
                    message: "A transmissão atingiu o limite de pessoas.",
                });
                return;
            }

            const entry = { ws, id: clientId, name: cleanName(message.name) };

            if (room.access === "open") {
                admit(room, entry);
                return;
            }

            if (room.pending.size >= MAX_PENDING) {
                send(ws, {
                    type: "error",
                    message: "Há muitos pedidos aguardando. Tente de novo em instantes.",
                });
                return;
            }

            const requestId = randomUUID();
            entry.timer = setTimeout(() => {
                if (!room.pending.delete(requestId)) return;
                clients.delete(ws);
                send(ws, {
                    type: "join-denied",
                    message: "O anfitrião não respondeu ao seu pedido.",
                });
                send(room.host, { type: "request-cancelled", requestId });
            }, REQUEST_TIMEOUT_MS);
            entry.timer.unref?.();

            room.pending.set(requestId, entry);
            clients.set(ws, {
                id: clientId,
                roomCode,
                role: "pending",
                requestId,
            });

            send(ws, { type: "join-pending", roomCode });
            send(room.host, {
                type: "join-request",
                requestId,
                name: entry.name,
            });
            return;
        }

        const client = clients.get(ws);

        if (message.type === "join-decision") {
            if (!client || client.role !== "host") return;
            const room = rooms.get(client.roomCode);
            const request = room?.pending.get(message.requestId);
            if (!room || !request) return;

            clearTimeout(request.timer);
            room.pending.delete(message.requestId);

            if (message.allow !== true) {
                clients.delete(request.ws);
                send(request.ws, {
                    type: "join-denied",
                    message: "O anfitrião recusou sua entrada.",
                });
                return;
            }

            if (room.participants.size >= MAX_VIEWERS) {
                clients.delete(request.ws);
                send(request.ws, {
                    type: "join-denied",
                    message: "A transmissão atingiu o limite de pessoas.",
                });
                return;
            }

            admit(room, request);
            return;
        }

        if (message.type === "kick") {
            if (!client || client.role !== "host") return;
            const room = rooms.get(client.roomCode);
            const target = room?.participants.get(message.participantId);
            if (!room || !target) return;

            room.participants.delete(target.id);
            clients.delete(target.ws);
            send(target.ws, {
                type: "kicked",
                message: "Você foi removido da transmissão.",
            });
            send(room.host, {
                type: "participant-left",
                participantId: target.id,
                participantCount: room.participants.size + 1,
            });
            return;
        }

        if (message.type === "set-access") {
            if (!client || client.role !== "host") return;
            const room = rooms.get(client.roomCode);
            if (!room || !ACCESS_MODES.has(message.access)) return;
            room.access = message.access;
            send(ws, { type: "access-changed", access: room.access });
            return;
        }

        if (message.type === "signal") {
            if (!client || client.role === "pending") {
                send(ws, { type: "error", message: "Entre em uma sala primeiro." });
                return;
            }

            const room = rooms.get(client.roomCode);

            if (!room) {
                send(ws, { type: "error", message: "Sala não encontrada." });
                return;
            }

            if (
                !message.payload ||
                typeof message.payload !== "object" ||
                Array.isArray(message.payload)
            ) {
                send(ws, {
                    type: "error",
                    message: "Conteúdo de sinalização inválido.",
                });
                return;
            }

            if (client.role === "participant") {
                // Participante envia sinalização para o anfitrião.
                send(room.host, {
                    type: "signal",
                    from: client.id,
                    payload: message.payload,
                });
                return;
            }

            // Anfitrião envia sinalização a um participante específico.
            if (typeof message.to !== "string") {
                send(ws, {
                    type: "error",
                    message: "É necessário informar o participante de destino.",
                });
                return;
            }

            const target = room.participants.get(message.to);

            if (!target) {
                send(ws, {
                    type: "error",
                    message: "Participante de destino não encontrado.",
                });
                return;
            }

            send(target.ws, {
                type: "signal",
                from: client.id,
                payload: message.payload,
            });

            return;
        }

        if (message.type === "leave-room") {
            removeFromRoom(ws);
            send(ws, { type: "room-left" });
            return;
        }

        send(ws, {
            type: "error",
            message: "Tipo de mensagem desconhecido.",
        });
    });

    ws.on("close", () => {
        removeFromRoom(ws);
        console.log(`Cliente desconectado: ${clientId}`);
    });

    ws.on("error", (error) => {
        console.error("Erro WebSocket:", error.message);
    });
});

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`TelaLink signaling ativo na porta ${PORT}.`);
    console.log(`Verificação local: http://localhost:${PORT}/health`);
});

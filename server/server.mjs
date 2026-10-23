import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomInt, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT) || 3001;
const MAX_VIEWERS = 5;
const MAX_PARTICIPANTS = MAX_VIEWERS + 1;

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

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function generateRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;

    do {
        code =
            "TL-" +
            Array.from(
                { length: 5 },
                () => alphabet[randomInt(alphabet.length)],
            ).join("");
    } while (rooms.has(code));

    return code;
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
                message: "O anfitrião encerrou a sala.",
            });
            clients.delete(participant.ws);
        }

        rooms.delete(client.roomCode);
        console.log(`Sala ${client.roomCode} encerrada.`);
        return;
    }

    room.participants.delete(client.id);

    send(room.host, {
        type: "participant-left",
        participantId: client.id,
        participantCount: room.participants.size + 1,
    });

    if (
        room.participants.size === 0 &&
        room.host.readyState !== WebSocket.OPEN
    ) {
        rooms.delete(client.roomCode);
    }
}

wss.on("connection", (ws) => {
    const clientId = randomUUID();
    console.log(`Cliente conectado: ${clientId}`);

    send(ws, { type: "connected", clientId });

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
                send(ws, {
                    type: "error",
                    message: "Você já está em uma sala.",
                });
                return;
            }

            const roomCode = generateRoomCode();

            rooms.set(roomCode, {
                host: ws,
                hostId: clientId,
                participants: new Map(),
            });

            clients.set(ws, {
                id: clientId,
                roomCode,
                role: "host",
            });

            send(ws, {
                type: "room-created",
                roomCode,
                clientId,
                maxParticipants: MAX_PARTICIPANTS,
                participantCount: 1,
            });

            console.log(`Sala ${roomCode} criada.`);
            return;
        }

        if (message.type === "join-room") {
            if (clients.has(ws)) {
                send(ws, {
                    type: "error",
                    message: "Você já está em uma sala.",
                });
                return;
            }

            if (typeof message.roomCode !== "string") {
                send(ws, {
                    type: "error",
                    message: "Código de sala inválido.",
                });
                return;
            }

            const roomCode = message.roomCode.trim().toUpperCase();
            const room = rooms.get(roomCode);

            if (!room || room.host.readyState !== WebSocket.OPEN) {
                send(ws, {
                    type: "error",
                    message: "Sala não encontrada ou encerrada.",
                });
                return;
            }

            if (room.participants.size + 1 >= MAX_PARTICIPANTS) {
                send(ws, {
                    type: "error",
                    message: "A sala atingiu o limite de participantes.",
                });
                return;
            }

            const participant = {
                ws,
                id: clientId,
            };

            room.participants.set(clientId, participant);

            clients.set(ws, {
                id: clientId,
                roomCode,
                role: "participant",
            });

            send(ws, {
                type: "room-joined",
                roomCode,
                clientId,
                hostId: room.hostId,
                participantCount: room.participants.size + 1,
            });

            send(room.host, {
                type: "participant-joined",
                participantId: clientId,
                participantCount: room.participants.size + 1,
            });

            console.log(`Participante ${clientId} entrou em ${roomCode}.`);
            return;
        }

        if (message.type === "signal") {
            const client = clients.get(ws);

            if (!client) {
                send(ws, {
                    type: "error",
                    message: "Entre em uma sala primeiro.",
                });
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

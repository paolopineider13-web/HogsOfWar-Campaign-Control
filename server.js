import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Hogs of War Campaign Control",
    version: "1.0.0"
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const rooms = new Map();

function cleanRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function cleanName(value) {
  return String(value || "Giocatore")
    .trim()
    .slice(0, 24);
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code;

  do {
    code = "";

    for (let i = 0; i < 6; i++) {
      code += chars[
        Math.floor(Math.random() * chars.length)
      ];
    }
  } while (rooms.has(code));

  return code;
}

function playersList(room) {
  return [...room.players.values()].map(player => ({
    id: player.id,
    name: player.name,
    isHost: player.isHost,
    active: player.id === room.activeController
  }));
}

function broadcastState(roomCode) {
  const room = rooms.get(roomCode);

  if (!room) return;

  io.to(roomCode).emit("campaign-player-list", {
    roomCode,
    hostId: room.hostSocketId,
    activeController: room.activeController,
    players: playersList(room)
  });
}

function findRoomBySocket(socketId) {
  for (const [roomCode, room] of rooms.entries()) {
    if (room.players.has(socketId)) {
      return {
        roomCode,
        room
      };
    }
  }

  return null;
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  // HOST CREA LA STANZA
  socket.on(
    "campaign-register-host",
    (data = {}, callback = () => {}) => {

      let roomCode = cleanRoomCode(data.roomCode);

      if (!roomCode) {
        roomCode = generateRoomCode();
      }

      if (rooms.has(roomCode)) {
        callback({
          ok: false,
          error: "Stanza già esistente"
        });

        return;
      }

      const host = {
        id: socket.id,
        name: cleanName(data.name),
        isHost: true
      };

      const room = {
        hostSocketId: socket.id,

        players: new Map([
          [socket.id, host]
        ]),

        activeController: socket.id
      };

      rooms.set(roomCode, room);

      socket.join(roomCode);

      callback({
        ok: true,
        roomCode,
        playerId: socket.id,
        hostId: socket.id,
        activeController: socket.id,
        players: playersList(room)
      });

      broadcastState(roomCode);

      console.log(
        `Room ${roomCode} created by ${host.name}`
      );
    }
  );

  // CLIENT ENTRA
  socket.on(
    "campaign-register-client",
    (data = {}, callback = () => {}) => {

      const roomCode = cleanRoomCode(data.roomCode);

      const room = rooms.get(roomCode);

      if (!room) {
        callback({
          ok: false,
          error: "Stanza non trovata"
        });

        return;
      }

      room.players.set(socket.id, {
        id: socket.id,
        name: cleanName(data.name),
        isHost: false
      });

      socket.join(roomCode);

      callback({
        ok: true,
        roomCode,
        playerId: socket.id,
        hostId: room.hostSocketId,
        activeController: room.activeController,
        players: playersList(room)
      });

      broadcastState(roomCode);
    }
  );

  // HOST SCEGLIE CHI CONTROLLA
  socket.on(
    "campaign-set-active-controller",
    (data = {}, callback = () => {}) => {

      const roomCode = cleanRoomCode(data.roomCode);

      const room = rooms.get(roomCode);

      if (!room) {
        callback({
          ok: false,
          error: "Stanza non trovata"
        });

        return;
      }

      if (room.hostSocketId !== socket.id) {
        callback({
          ok: false,
          error: "Solo l'host può cambiare giocatore"
        });

        return;
      }

      if (!room.players.has(data.playerId)) {
        callback({
          ok: false,
          error: "Giocatore non trovato"
        });

        return;
      }

      room.activeController = data.playerId;

      io.to(roomCode).emit(
        "campaign-active-controller",
        {
          roomCode,
          playerId: data.playerId
        }
      );

      broadcastState(roomCode);

      callback({
        ok: true,
        activeController: data.playerId
      });
    }
  );

  // PASSA AUTOMATICAMENTE AL GIOCATORE SUCCESSIVO
  socket.on(
    "campaign-next-controller",
    (data = {}, callback = () => {}) => {

      const roomCode = cleanRoomCode(data.roomCode);

      const room = rooms.get(roomCode);

      if (!room) return;

      if (room.hostSocketId !== socket.id) {
        return;
      }

      const ids = [...room.players.keys()];

      if (!ids.length) return;

      let index = ids.indexOf(
        room.activeController
      );

      if (index < 0) {
        index = 0;
      }

      const next =
        ids[(index + 1) % ids.length];

      room.activeController = next;

      io.to(roomCode).emit(
        "campaign-active-controller",
        {
          roomCode,
          playerId: next
        }
      );

      broadcastState(roomCode);

      callback({
        ok: true,
        activeController: next
      });
    }
  );

  // INPUT REMOTO
  socket.on(
    "campaign-input",
    data => {

      const roomCode =
        cleanRoomCode(data.roomCode);

      const room =
        rooms.get(roomCode);

      if (!room) return;

      // Può inviare input solo chi ha il controllo
      if (
        room.activeController !== socket.id
      ) {
        return;
      }

      // Se è già l'host non serve inoltrarlo
      if (
        socket.id === room.hostSocketId
      ) {
        return;
      }

      const button = Number(data.button);
      const value = Number(data.value);

      if (
        !Number.isFinite(button) ||
        !Number.isFinite(value)
      ) {
        return;
      }

      io.to(room.hostSocketId).emit(
        "campaign-remote-input",
        {
          roomCode,
          from: socket.id,
          button: Math.trunc(button),
          value: Math.max(
            -1,
            Math.min(1, value)
          )
        }
      );
    }
  );

  socket.on("disconnect", () => {
    const found =
      findRoomBySocket(socket.id);

    if (!found) return;

    const {
      roomCode,
      room
    } = found;

    const wasHost =
      room.hostSocketId === socket.id;

    const wasActive =
      room.activeController === socket.id;

    room.players.delete(socket.id);

    if (wasHost) {
      io.to(roomCode).emit(
        "campaign-room-closed",
        {
          reason:
            "L'host si è disconnesso"
        }
      );

      rooms.delete(roomCode);

      return;
    }

    if (wasActive) {
      room.activeController =
        room.hostSocketId;
    }

    broadcastState(roomCode);
  });
});

const PORT =
  Number(process.env.PORT) || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Hogs of War Campaign Control server running on port ${PORT}`
    );
  }
);

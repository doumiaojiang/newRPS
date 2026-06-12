import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { Server } from "socket.io";
import { fileURLToPath } from "node:url";
import { exportConfigText, getRootDir, loadConfig, resetConfig, saveConfig } from "./config.js";
import type {
  AppConfig,
  BotDifficulty,
  BotPlayer,
  ChatMessage,
  Move,
  PublicPlayer,
  RoundResult,
  RoundHistoryItem,
  RoomSettings,
  RoomSnapshot,
  SeatKey,
  SeatStats,
  SeatOccupant,
  Suggestion
} from "../shared/types.js";

type RpsMove = Exclude<Move, "giveaway" | "forfeit" | "noMove">;

type PlayerState = PublicPlayer & {
  socketId?: string;
  token: string;
  ipAddress?: string;
  disconnectGraceTimer?: NodeJS.Timeout;
  disconnectTimer?: NodeJS.Timeout;
  recentMoves: RpsMove[];
};

type DisconnectForfeit = {
  loserId: string;
  loserSeat: SeatKey;
  loserName: string;
  winnerId: string;
  winnerSeat: SeatKey;
  winnerName: string;
  stake: 5 | 10 | 20;
};

type RoomState = Omit<RoomSnapshot, "spectators" | "seats" | "roundHistoryTotal"> & {
  seats: Record<SeatKey, SeatOccupant>;
  spectatorIds: string[];
  ownerId: string;
  lockedSeatIds: Set<string>;
  forgiveAdvantage?: {
    beneficiaryId: string;
    targetId: string;
  };
  disconnectForfeits: Map<string, DisconnectForfeit>;
  createdAt: number;
};

type LeaveReason = "manual" | "switchRoom" | "spectate" | "disconnectTimeout" | "adminKick";
type LeaveResult = { ok: true } | { ok: false; error: string };

const defaultRoomName = "新的锤子剪刀布房间";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = getRootDir();
const uploadsDir = path.join(rootDir, "work", "uploads");
const proofUploadsDir = path.join(uploadsDir, "proofs");
const adminUploadsDir = path.join(uploadsDir, "admin");
fs.mkdirSync(proofUploadsDir, { recursive: true });
fs.mkdirSync(adminUploadsDir, { recursive: true });

let config: AppConfig = loadConfig();
const players = new Map<string, PlayerState>();
const tokenToPlayerId = new Map<string, string>();
const rooms = new Map<string, RoomState>();
const botTimers = new Map<string, NodeJS.Timeout>();
const ipCreateAttempts = new Map<string, number[]>();
const suggestions: Suggestion[] = [];
const lobbyChat: ChatMessage[] = [];
const adminSocketIds = new Set<string>();
const maxRoomChatMessages = 200;
const maxLobbyMessages = 100;
const roomHistoryPageSize = 20;
const giveawayBoardDurationMs = 12 * 60 * 60 * 1000;
const broadcastMetricWindowMs = 60_000;
const recentBroadcasts: Array<{ type: "room" | "lobby"; bytes: number; at: number }> = [];
let lobbyBroadcastTimer: NodeJS.Timeout | undefined;
const serverStats = {
  startedAt: Date.now(),
  roomBroadcasts: 0,
  lobbyBroadcasts: 0,
  disconnects: 0,
  reconnects: 0,
  lastRoomSnapshotBytes: 0,
  lastLobbySnapshotBytes: 0,
  recentRoomBroadcasts: 0,
  recentLobbyBroadcasts: 0,
  averageRoomSnapshotBytes: 0,
  averageLobbySnapshotBytes: 0
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  pingInterval: 25_000,
  pingTimeout: 30_000
});

app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(uploadsDir, {
  dotfiles: "deny",
  index: false,
  setHeaders: (res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self';");
  }
}));

function imageKind(buffer: Buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: ".jpg" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: ".png" };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: ".webp" };
  return null;
}

function saveVerifiedImage(file: Express.Multer.File, bucket: "proofs" | "admin") {
  const kind = imageKind(file.buffer);
  if (!kind || kind.mime !== file.mimetype) throw new Error("图片真实格式不正确");
  const filename = `${Date.now()}-${randomId()}${kind.ext}`;
  const targetDir = bucket === "admin" ? adminUploadsDir : proofUploadsDir;
  fs.writeFileSync(path.join(targetDir, filename), file.buffer, { flag: "wx", mode: 0o600 });
  return `/uploads/${bucket}/${filename}`;
}

function adminPasswordMatches(password: unknown) {
  return Boolean(config.site.adminPassword && String(password || "") === config.site.adminPassword);
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype));
  }
});

// 图片证明走 HTTP 上传，比 Socket.IO 更适合处理文件。
app.post("/api/proof-image", (req, res) => {
  imageUpload.single("image")(req, res, (error) => {
    if (error) return res.status(400).json({ message: "图片上传失败，请确认格式为 jpg/png/webp 且小于 8MB" });
    const playerId = tokenToPlayerId.get(String(req.body.token || ""));
    const player = playerId ? players.get(playerId) : undefined;
    if (!player?.connected) return res.status(403).json({ message: "请先进入游戏后再上传证明" });
    if (!req.file) return res.status(400).json({ message: "图片格式不支持或图片为空" });
    try {
      res.json({ imageUrl: saveVerifiedImage(req.file, "proofs") });
    } catch {
      res.status(400).json({ message: "图片真实格式不正确，请上传 jpg/png/webp" });
    }
  });
});

app.post("/api/admin-image", (req, res) => {
  imageUpload.single("image")(req, res, (error) => {
    if (error) return res.status(400).json({ message: "图片上传失败，请确认格式为 jpg/png/webp 且小于 8MB" });
    if (!adminPasswordMatches(req.body.password)) return res.status(403).json({ message: "管理员口令不正确或尚未设置" });
    if (!req.file) return res.status(400).json({ message: "图片格式不支持或图片为空" });
    try {
      res.json({ imageUrl: saveVerifiedImage(req.file, "admin") });
    } catch {
      res.status(400).json({ message: "图片真实格式不正确，请上传 jpg/png/webp" });
    }
  });
});

app.get("/api/config/export", (_req, res) => {
  res.type("application/json").send(exportConfigText());
});

if (fs.existsSync(path.join(rootDir, "dist"))) {
  app.use(express.static(path.join(rootDir, "dist")));
  app.use((_req, res) => res.sendFile(path.join(rootDir, "dist", "index.html")));
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function roomCode() {
  let code = "";
  do {
    code = `DM-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  } while ([...rooms.values()].some((room) => room.code === code));
  return code;
}

function socketIp(socket: { handshake: { headers: Record<string, string | string[] | undefined>; address: string } }) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(raw?.split(",")[0] || socket.handshake.address || "unknown").trim();
}

function onlinePlayersFromIp(ipAddress: string, exceptPlayerId?: string) {
  return [...players.values()].filter((player) =>
    player.connected &&
    player.ipAddress === ipAddress &&
    player.id !== exceptPlayerId
  ).length;
}

function canCreateFromIp(ipAddress: string) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const attempts = (ipCreateAttempts.get(ipAddress) || []).filter((time) => now - time < windowMs);
  ipCreateAttempts.set(ipAddress, attempts);
  if (attempts.length >= config.accessControl.maxCreatesPer10Min) return false;
  attempts.push(now);
  return true;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampGiveawayValue(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function seatOf(room: RoomState, playerId: string): SeatKey | null {
  if (room.seats.A?.id === playerId) return "A";
  if (room.seats.B?.id === playerId) return "B";
  return null;
}

function getPlayer(socketId: string) {
  return [...players.values()].find((player) => player.socketId === socketId);
}

function titleSegmentFor(points: number) {
  return config.titles.find((item) => points >= item.min && points <= item.max) ?? config.titles[0];
}

function titleNamesForSegment(segment: AppConfig["titles"][number] | undefined, factionId?: string) {
  if (!segment) return ["初心拳手"];
  return factionId && segment.factionNames?.[factionId]?.length ? segment.factionNames[factionId] : segment.names;
}

function randomTitleFromSegment(segment: AppConfig["titles"][number] | undefined, factionId?: string) {
  const names = titleNamesForSegment(segment, factionId);
  return names[Math.floor(Math.random() * names.length)] ?? "初心拳手";
}

function syncTitleForRankSegment(player: PlayerState, options: { force?: boolean } = {}) {
  const effectivePoints = Math.max(player.stats.rankedPoints, -999);
  const segment = titleSegmentFor(effectivePoints);
  if (!segment) return;

  // 称号池是随机抽取的，但不能在每次大厅/房间刷新时重新抽。
  // 这里记录“当前称号属于哪个积分段位”，只有跨段位或明确强制刷新时才重新装备。
  if (!options.force && !player.stats.titleSegmentId && player.stats.title) {
    player.stats.titleSegmentId = segment.id;
    return;
  }
  if (options.force || player.stats.titleSegmentId !== segment.id || !player.stats.title) {
    player.stats.title = randomTitleFromSegment(segment, player.factionId);
  }
  player.stats.titleSegmentId = segment.id;
}

function genderInfo(genderId: string) {
  // 性别是玩家选择的具体身份，阵营是系统根据配置自动推导出来的。
  // 后台改阵营颜色后，这里会让所有公开玩家快照都带上新的颜色。
  const fallbackFaction = config.genderFactions[0];
  const gender = config.genders.find((item) => item.id === genderId) ?? config.genders[0];
  const faction = config.genderFactions.find((item) => item.id === gender?.factionId) ?? fallbackFaction;
  return {
    genderId: gender?.id ?? genderId,
    genderLabel: gender?.label ?? genderId,
    factionId: faction?.id ?? "unknown_faction",
    factionLabel: faction?.label ?? "未知阵营",
    factionColors: {
      textColor: faction?.textColor ?? "#4d5c6f",
      backgroundColor: faction?.backgroundColor ?? "#eef3f8",
      borderColor: faction?.borderColor ?? "#c9d6e4"
    }
  };
}

function normalizeRoomTags(settings: RoomSettings) {
  if (!settings.enableTags) return [];
  const allowed = new Set(config.roomTags);
  return [...new Set((settings.tags || []).map((tag) => String(tag).trim()).filter((tag) => tag && allowed.has(tag)))].slice(0, 5);
}

function nameWarCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function generateNameWarPenaltyName() {
  const prefix = config.nameWar?.penaltyPrefix?.trim() || "失名者";
  return `${prefix}-${nameWarCode()}`;
}

function formatDisplayName(player: Pick<PublicPlayer, "genderLabel" | "stats" | "name" | "nameWarPunished" | "nameWarPenaltyName" | "nameWarAllowRename">) {
  if (player.nameWarPunished && player.nameWarPenaltyName) return player.nameWarPenaltyName;
  return `${player.genderLabel} - ${player.stats.title} - ${player.name}`;
}

function playerShortName(player: Pick<PublicPlayer, "name" | "nameWarPunished" | "nameWarPenaltyName">) {
  return player.nameWarPunished && player.nameWarPenaltyName ? player.nameWarPenaltyName : player.name;
}

function refreshGiveawayBoard(player: PlayerState, now = Date.now()) {
  if (!player.giveawayBoardExpiresAt || player.giveawayBoardExpiresAt > now) return;
  player.giveawayBoardText = undefined;
  player.giveawayBoardSubmittedAt = undefined;
  player.giveawayBoardExpiresAt = undefined;
  player.giveawayBoardLikes = 0;
  player.giveawayBoardDislikes = 0;
  player.giveawayBoardLikesThisHour = 0;
  player.giveawayBoardLikeWindowStartedAt = undefined;
}

function addGiveawayValue(player: PlayerState, delta: number) {
  player.giveawayValue = clampGiveawayValue((player.giveawayValue || 0) + delta);
  refreshPlayerSnapshots(player);
}

function refreshNameWarState(player: PlayerState, now = Date.now()) {
  const before = JSON.stringify({
    title: player.stats.title,
    displayName: player.displayName,
    punished: player.nameWarPunished,
    penaltyName: player.nameWarPenaltyName,
    protectedUntil: player.nameWarRenameProtectedUntil,
    renamedBy: player.nameWarRenamedBy,
    renamedByName: player.nameWarRenamedByName
  });
  if (!player.nameWarEnabled) {
    player.nameWarPunished = false;
    player.nameWarPenaltyName = undefined;
    player.nameWarRenameProtectedUntil = undefined;
    player.nameWarRenamedBy = undefined;
    player.nameWarRenamedByName = undefined;
    syncTitleForRankSegment(player);
  } else {
    const protectedActive = Boolean(player.nameWarRenameProtectedUntil && player.nameWarRenameProtectedUntil > now);
    if (protectedActive && player.nameWarPenaltyName) {
      player.nameWarPunished = true;
    } else if (player.stats.rankedPoints <= -1000) {
      player.nameWarPunished = true;
      if (!player.nameWarPenaltyName) player.nameWarPenaltyName = generateNameWarPenaltyName();
      if (player.nameWarRenameProtectedUntil && player.nameWarRenameProtectedUntil <= now) {
        player.nameWarRenameProtectedUntil = undefined;
      }
    } else {
      player.nameWarPunished = false;
      player.nameWarPenaltyName = undefined;
      player.nameWarRenameProtectedUntil = undefined;
      player.nameWarRenamedBy = undefined;
      player.nameWarRenamedByName = undefined;
      syncTitleForRankSegment(player);
    }
  }
  player.displayName = formatDisplayName(player);
  return before !== JSON.stringify({
    title: player.stats.title,
    displayName: player.displayName,
    punished: player.nameWarPunished,
    penaltyName: player.nameWarPenaltyName,
    protectedUntil: player.nameWarRenameProtectedUntil,
    renamedBy: player.nameWarRenamedBy,
    renamedByName: player.nameWarRenamedByName
  });
}

function applyGender(player: PlayerState, genderId: string) {
  const oldFactionId = player.factionId;
  const next = genderInfo(genderId);
  player.genderId = next.genderId;
  player.genderLabel = next.genderLabel;
  player.factionId = next.factionId;
  player.factionLabel = next.factionLabel;
  player.factionColors = next.factionColors;
  if (oldFactionId && oldFactionId !== next.factionId && !player.nameWarPunished) syncTitleForRankSegment(player, { force: true });
  player.displayName = formatDisplayName(player);
}

function publicPlayer(player: PlayerState): PublicPlayer {
  const { socketId: _socketId, token: _token, ipAddress: _ipAddress, disconnectGraceTimer: _graceTimer, disconnectTimer: _timer, recentMoves: _moves, ...rest } = player;
  return rest;
}

function refreshPlayerSnapshots(player: PlayerState) {
  for (const room of rooms.values()) {
    for (const seat of ["A", "B"] as SeatKey[]) {
      const occupant = room.seats[seat];
      if (occupant?.id === player.id && !("isBot" in occupant)) {
        room.seats[seat] = publicPlayer(player);
      }
    }
  }
}

function refreshAllPlayersForConfig() {
  for (const player of players.values()) {
    applyGender(player, player.genderId);
    refreshNameWarState(player);
    refreshPlayerSnapshots(player);
  }
}

function roomSnapshot(room: RoomState, options: { includeChat?: boolean } = {}): RoomSnapshot {
  for (const id of [room.seats.A?.id, room.seats.B?.id, ...room.spectatorIds]) {
    const player = id ? players.get(id) : undefined;
    if (player && refreshNameWarState(player)) refreshPlayerSnapshots(player);
  }
  const spectators = room.spectatorIds
    .map((id) => players.get(id))
    .filter(Boolean)
    .map((player) => publicPlayer(player as PlayerState));
  const {
    spectatorIds: _spectatorIds,
    ownerId: _ownerId,
    lockedSeatIds: _lockedSeatIds,
    forgiveAdvantage: _forgiveAdvantage,
    createdAt: _createdAt,
    ...publicRoom
  } = room;
  return {
    ...publicRoom,
    roundHistory: room.roundHistory.slice(0, roomHistoryPageSize),
    roundHistoryTotal: room.roundHistory.length,
    spectators,
    choices: hideOpponentChoices(room),
    chat: options.includeChat === false ? [] : room.chat
  };
}

function occupantName(occupant: SeatOccupant) {
  if (!occupant) return "空位";
  return "isBot" in occupant ? occupant.name : occupant.displayName;
}

function lobbySeatSummary(occupant: SeatOccupant) {
  if (!occupant) return null;
  return "isBot" in occupant
    ? { name: occupant.name, isBot: true }
    : { player: occupant };
}

function roomRole(room: RoomState, playerId: string) {
  const seat = seatOf(room, playerId);
  if (seat) return `战斗席 ${seat}`;
  if (room.spectatorIds.includes(playerId)) return "观战";
  return "房间";
}

function roomHasPlayer(room: RoomState, playerId: string) {
  return Boolean(seatOf(room, playerId) || room.spectatorIds.includes(playerId));
}

function clearDisconnectHold(player: PlayerState) {
  if (player.disconnectGraceTimer) clearTimeout(player.disconnectGraceTimer);
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectGraceTimer = undefined;
  player.disconnectTimer = undefined;
  player.disconnectExpiresAt = undefined;
}

function emptySeatStats(): SeatStats {
  return { wins: 0, losses: 0, draws: 0, punishments: 0 };
}

function roundResultLabel(room: RoomState, result: RoundResult) {
  if (result === "doubleLoss") return "双方白给，双输";
  if (result === "draw") {
    if (room.settings.enableRanked && room.settings.tieDoublePunish) return `平局双扣 -${room.settings.stake}`;
    return "平局";
  }
  return `${occupantName(room.seats[result])}胜利`;
}

function isHumanOccupant(occupant: SeatOccupant) {
  return Boolean(occupant && !("isBot" in occupant));
}

function shouldCloseRoom(room: RoomState) {
  return !isHumanOccupant(room.seats.A) && !isHumanOccupant(room.seats.B) && room.spectatorIds.length === 0;
}

function cleanupRoomIfEmpty(room: RoomState) {
  if (!shouldCloseRoom(room)) return false;
  const botTimer = botTimers.get(room.id);
  if (botTimer) clearTimeout(botTimer);
  botTimers.delete(room.id);
  rooms.delete(room.id);
  broadcastLobby();
  return true;
}

function hideOpponentChoices(room: RoomState) {
  const hidden: RoomSnapshot["choices"] = {};
  for (const seat of ["A", "B"] as SeatKey[]) {
    if (room.choices[seat]) hidden[seat] = "hidden";
  }
  return room.phase === "result" || room.phase === "punishment" ? room.revealedChoices ?? {} : hidden;
}

function lobbySnapshot(options: { includeConfig?: boolean } = {}) {
  for (const player of players.values()) {
    refreshGiveawayBoard(player);
    if (refreshNameWarState(player)) refreshPlayerSnapshots(player);
  }
  const humanPlayers = [...players.values()].map(publicPlayer);
  const normalLeaderboard = humanPlayers
    .filter((player) => player.stats.wins + player.stats.losses + player.stats.draws >= 5)
    .sort((a, b) => winRate(b) - winRate(a) || b.stats.wins - a.stats.wins)
    .slice(0, 10);
  const rankedLeaderboard = humanPlayers
    .filter((player) => player.connected)
    .sort((a, b) => b.stats.rankedPoints - a.stats.rankedPoints || b.stats.wins - a.stats.wins);
  return {
    ...(options.includeConfig ? { config } : {}),
    onlineCount: [...players.values()].filter((player) => player.connected).length,
    players: humanPlayers,
    rooms: [...rooms.values()].map((room) => ({
      id: room.id,
      code: room.code,
      name: room.settings.name,
      hasPassword: Boolean(room.settings.password),
      players: [room.seats.A, room.seats.B].filter(Boolean).length,
      spectators: room.spectatorIds.length,
      versus: {
        A: lobbySeatSummary(room.seats.A),
        B: lobbySeatSummary(room.seats.B)
      },
      status: room.status,
      roomBackgroundImage: room.settings.roomBackgroundImage,
      enableBot: room.settings.enableBot,
      botDifficulty: room.settings.botDifficulty,
      enablePunishment: room.settings.enablePunishment,
      punishmentIds: room.settings.punishmentIds,
      punishmentId: room.settings.punishmentId,
      tieDoublePunish: room.settings.tieDoublePunish,
      requireOpponentConfirm: room.settings.requireOpponentConfirm,
      enableRanked: room.settings.enableRanked,
      tags: room.settings.enableTags ? room.settings.tags || [] : []
    })),
    normalLeaderboard,
    rankedLeaderboard,
    suggestions,
    lobbyChat,
    serverStats: { ...serverStats }
  };
}

function winRate(player: PublicPlayer) {
  const decisive = player.stats.wins + player.stats.losses;
  return decisive === 0 ? 0 : player.stats.wins / decisive;
}

function recordBroadcast(type: "room" | "lobby", bytes: number) {
  const now = Date.now();
  recentBroadcasts.push({ type, bytes, at: now });
  while (recentBroadcasts.length && now - recentBroadcasts[0].at > broadcastMetricWindowMs) recentBroadcasts.shift();
  const roomItems = recentBroadcasts.filter((item) => item.type === "room");
  const lobbyItems = recentBroadcasts.filter((item) => item.type === "lobby");
  serverStats.recentRoomBroadcasts = roomItems.length;
  serverStats.recentLobbyBroadcasts = lobbyItems.length;
  serverStats.averageRoomSnapshotBytes = roomItems.length ? Math.round(roomItems.reduce((sum, item) => sum + item.bytes, 0) / roomItems.length) : 0;
  serverStats.averageLobbySnapshotBytes = lobbyItems.length ? Math.round(lobbyItems.reduce((sum, item) => sum + item.bytes, 0) / lobbyItems.length) : 0;
}

function emitLobbyUpdate() {
  lobbyBroadcastTimer = undefined;
  const snapshot = lobbySnapshot();
  serverStats.lobbyBroadcasts += 1;
  serverStats.lastLobbySnapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  recordBroadcast("lobby", serverStats.lastLobbySnapshotBytes);
  io.emit("lobby:update", snapshot);
}

function broadcastLobby() {
  if (lobbyBroadcastTimer) return;
  lobbyBroadcastTimer = setTimeout(emitLobbyUpdate, 150);
}

function broadcastRoom(roomId: string, updateLobby = false) {
  const room = rooms.get(roomId);
  if (!room) return;
  // 每次广播房间状态都打一个时间戳，前端可以用它丢掉过期快照。
  // 这样聊天、审核、提交证明同时发生时，不容易被旧状态覆盖。
  room.updatedAt = Date.now();
  const snapshot = roomSnapshot(room, { includeChat: false });
  serverStats.roomBroadcasts += 1;
  serverStats.lastRoomSnapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  recordBroadcast("room", serverStats.lastRoomSnapshotBytes);
  io.to(roomId).emit("room:update", snapshot);
  if (updateLobby) broadcastLobby();
}

function appendRoomChat(room: RoomState, message: ChatMessage) {
  room.chat.push(message);
  if (room.chat.length > maxRoomChatMessages) room.chat.splice(0, room.chat.length - maxRoomChatMessages);
}

function appendLobbyChat(message: ChatMessage) {
  lobbyChat.push(message);
  if (lobbyChat.length > maxLobbyMessages) lobbyChat.splice(0, lobbyChat.length - maxLobbyMessages);
}

function appendSuggestion(suggestion: Suggestion) {
  suggestions.unshift(suggestion);
  if (suggestions.length > maxLobbyMessages) suggestions.splice(maxLobbyMessages);
}

function systemChat(text: string, roomId?: string) {
  const message: ChatMessage = {
    id: randomId(),
    roomId,
    playerId: "system",
    author: "系统",
    text,
    at: Date.now(),
    system: true
  };
  if (roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    appendRoomChat(room, message);
    io.to(roomId).emit("chat:append", message);
  } else {
    appendLobbyChat(message);
    broadcastLobby();
  }
}

function roomNotice(room: RoomState, text: string) {
  appendRoomChat(room, {
    id: randomId(),
    roomId: room.id,
    playerId: "system",
    author: "系统",
    text,
    at: Date.now(),
    system: true,
    transient: true,
    expiresAt: Date.now() + 5_000
  });
}

function canAutoSeatOnJoin(room: RoomState) {
  if (room.phase === "punishment" || room.phase === "result") return false;
  if (room.phase === "choosing" && (room.choices.A || room.choices.B)) return false;
  return true;
}

function makeBot(difficulty: BotDifficulty): BotPlayer {
  const difficultyName = config.bots.difficulties.find((item) => item.id === difficulty)?.name ?? difficulty;
  return {
    id: `bot-${randomId()}`,
    name: `机器人（${difficultyName}）`,
    difficulty,
    isBot: true
  };
}

function createPlayer(name: string, genderId: string, token?: string): PlayerState {
  const playerId = randomId();
  const gender = genderInfo(genderId);
  const titleSegment = titleSegmentFor(0);
  const title = randomTitleFromSegment(titleSegment, gender.factionId);
  const now = Date.now();
  const player: PlayerState = {
    id: playerId,
    name,
    genderId: gender.genderId,
    genderLabel: gender.genderLabel,
    factionId: gender.factionId,
    factionLabel: gender.factionLabel,
    factionColors: gender.factionColors,
    displayName: `${gender.genderLabel} - ${title} - ${name}`,
    connected: true,
    nameWarOriginalName: name,
    giveawayEnabled: false,
    giveawayValue: 0,
    giveawayClicks: 0,
    giveawayBoardLikes: 0,
    giveawayBoardDislikes: 0,
    token: token || randomId(),
    stats: { wins: 0, losses: 0, draws: 0, punishments: 0, rankedPoints: 0, title, titleSegmentId: titleSegment?.id },
    recentMoves: []
  };
  players.set(player.id, player);
  tokenToPlayerId.set(player.token, player.id);
  return player;
}

function applyRanked(winner: PlayerState | undefined, loser: PlayerState | undefined, stake: 5 | 10 | 20) {
  if (winner) updateRankedPoints(winner, stake);
  if (loser) updateRankedPoints(loser, -stake);
}

function applyRankedDrawPenalty(playerA: PlayerState | undefined, playerB: PlayerState | undefined, stake: 5 | 10 | 20) {
  if (playerA) updateRankedPoints(playerA, -stake);
  if (playerB) updateRankedPoints(playerB, -stake);
}

function createDisconnectForfeit(room: RoomState, player: PlayerState) {
  if (!room.settings.enableRanked || room.phase !== "choosing") return;
  const loserSeat = seatOf(room, player.id);
  if (!loserSeat) return;
  const winnerSeat = loserSeat === "A" ? "B" : "A";
  const winner = room.seats[winnerSeat];
  if (!winner || "isBot" in winner) return;
  room.disconnectForfeits.set(player.id, {
    loserId: player.id,
    loserSeat,
    loserName: playerShortName(player),
    winnerId: winner.id,
    winnerSeat,
    winnerName: occupantName(winner),
    stake: room.settings.stake
  });
}

function clearDisconnectForfeit(player: PlayerState) {
  if (!player.roomId) return;
  const room = rooms.get(player.roomId);
  room?.disconnectForfeits.delete(player.id);
}

function applyDisconnectForfeit(room: RoomState, player: PlayerState) {
  const forfeit = room.disconnectForfeits.get(player.id);
  if (!forfeit) return false;
  room.disconnectForfeits.delete(player.id);
  const winner = players.get(forfeit.winnerId);
  const loser = players.get(forfeit.loserId);
  if (winner) {
    winner.stats.wins += 1;
    updateRankedPoints(winner, forfeit.stake);
  }
  if (loser) {
    loser.stats.losses += 1;
    updateRankedPoints(loser, -forfeit.stake);
  }
  room.score[forfeit.winnerSeat] += 1;
  room.seatedScore[forfeit.winnerSeat] += 1;
  room.seatStats[forfeit.winnerSeat].wins += 1;
  room.seatStats[forfeit.loserSeat].losses += 1;
  room.phase = "result";
  room.status = "playing";
  room.revealedChoices = undefined;
  room.resultText = `${forfeit.loserName} 断线超时判负，${forfeit.winnerName}胜利，排位 ${forfeit.stake} 分已结算`;
  addRoundHistory(room, {
    id: randomId(),
    round: room.roundHistory.length + 1,
    at: Date.now(),
    playerA: forfeit.loserSeat === "A" ? forfeit.loserName : forfeit.winnerName,
    playerB: forfeit.loserSeat === "B" ? forfeit.loserName : forfeit.winnerName,
    moveA: forfeit.loserSeat === "A" ? "forfeit" : (room.choices.A as Move | undefined) || "noMove",
    moveB: forfeit.loserSeat === "B" ? "forfeit" : (room.choices.B as Move | undefined) || "noMove",
    result: forfeit.winnerSeat,
    resultLabel: `${forfeit.winnerName}胜利`,
    resultText: room.resultText,
    ranked: true,
    stake: forfeit.stake,
    punishmentTasks: [],
    punishedNames: [],
    proofs: []
  });
  roomNotice(room, room.resultText);
  return true;
}

function updateRankedPoints(player: PlayerState, delta: number) {
  const minPoints = player.nameWarEnabled ? -1999 : -999;
  player.stats.rankedPoints = clamp(player.stats.rankedPoints + delta, minPoints, 999);
  refreshNameWarState(player);
  refreshPlayerSnapshots(player);
}

function setRankedPointsByAdmin(player: PlayerState, points: number) {
  const minPoints = player.nameWarEnabled ? -1999 : -999;
  player.stats.rankedPoints = clamp(Math.round(points), minPoints, 999);
  refreshNameWarState(player);
}

function nameWarRenameQuota(player: PlayerState, now = Date.now()) {
  if (!player.nameWarRenameWindowStartedAt || now - player.nameWarRenameWindowStartedAt >= 10_800_000) {
    player.nameWarRenameWindowStartedAt = now;
    player.nameWarRenameCount = 0;
  }
  return 3 - (player.nameWarRenameCount || 0);
}

function isNameWarRenameTarget(player: PublicPlayer) {
  return Boolean(player.nameWarEnabled && player.nameWarAllowRename && player.nameWarPunished && player.stats.rankedPoints <= -1000);
}

function isRpsMove(move: Move): move is RpsMove {
  return move === "rock" || move === "scissors" || move === "paper";
}

function judge(a: RpsMove, b: RpsMove): RoundResult {
  if (a === b) return "draw";
  if ((a === "rock" && b === "scissors") || (a === "scissors" && b === "paper") || (a === "paper" && b === "rock")) return "A";
  return "B";
}

function applyForgiveAdvantage(room: RoomState, result: RoundResult) {
  const advantage = room.forgiveAdvantage;
  if (!advantage) return result;
  room.forgiveAdvantage = undefined;
  if (result === "doubleLoss") return result;
  const beneficiarySeat = seatOf(room, advantage.beneficiaryId);
  const targetSeat = seatOf(room, advantage.targetId);
  if (!beneficiarySeat || !targetSeat || beneficiarySeat === targetSeat) return result;
  return Math.random() < 0.66 ? beneficiarySeat : result;
}

function isHumanVsHumanRoom(room: RoomState) {
  return Boolean(
    room.seats.A &&
    room.seats.B &&
    !("isBot" in room.seats.A) &&
    !("isBot" in room.seats.B)
  );
}

function shouldTriggerGiveaway(player: PlayerState) {
  return Boolean(player.giveawayEnabled && (player.giveawayValue || 0) > 0 && Math.random() * 100 < (player.giveawayValue || 0));
}

function giveawayForcedSeats(room: RoomState) {
  if (!isHumanVsHumanRoom(room)) return [];
  return (["A", "B"] as SeatKey[]).filter((seat) => {
    if (room.choices[seat] === "giveaway") return false;
    const occupant = room.seats[seat];
    if (!occupant || "isBot" in occupant) return false;
    const player = players.get(occupant.id);
    return player ? shouldTriggerGiveaway(player) : false;
  });
}

function resultWithGiveaway(room: RoomState, baseResult: RoundResult, finalChoices: Record<SeatKey, Move>) {
  const giveawaySeats = (["A", "B"] as SeatKey[]).filter((seat) => finalChoices[seat] === "giveaway");
  if (giveawaySeats.length === 1) return giveawaySeats[0] === "A" ? "B" : "A";
  if (giveawaySeats.length >= 2) return "doubleLoss";
  return applyForgiveAdvantage(room, baseResult);
}

function moveText(move: Move) {
  if (move === "noMove") return "未出拳";
  if (move === "forfeit") return "断线判负";
  if (move === "giveaway") return "白给";
  return move === "rock" ? "石头" : move === "scissors" ? "剪刀" : "布";
}

function botMove(room: RoomState, bot: BotPlayer): Move {
  const moves: RpsMove[] = ["rock", "scissors", "paper"];
  const opponent = room.seats.A && !("isBot" in room.seats.A) ? players.get(room.seats.A.id) : undefined;
  const difficulty = config.bots.difficulties.find((item) => item.id === bot.difficulty);
  const strategy = difficulty?.strategy || (bot.difficulty === "normal" ? "counter" : bot.difficulty === "chaos" ? "chaos" : "random");
  const opponentSeat = seatOf(room, opponent?.id || "");
  const currentOpponentMove = opponentSeat && isRpsMove(room.choices[opponentSeat] as Move) ? room.choices[opponentSeat] as RpsMove : undefined;
  if (strategy === "win" && currentOpponentMove) return winningMoveAgainst(currentOpponentMove);
  if (strategy === "throw" && currentOpponentMove) return losingMoveAgainst(currentOpponentMove);
  if (strategy === "chaos" && Math.random() < 0.35 && isRpsMove(room.revealedChoices?.B as Move)) return room.revealedChoices!.B as RpsMove;
  if (strategy === "counter" && opponent?.recentMoves.length) {
    const last = opponent.recentMoves[opponent.recentMoves.length - 1];
    return winningMoveAgainst(last);
  }
  return moves[Math.floor(Math.random() * moves.length)];
}

function winningMoveAgainst(move: RpsMove): RpsMove {
  return move === "rock" ? "paper" : move === "paper" ? "scissors" : "rock";
}

function losingMoveAgainst(move: RpsMove): RpsMove {
  return move === "rock" ? "scissors" : move === "paper" ? "rock" : "paper";
}

function maybeStartChoosing(room: RoomState) {
  // 只在等待/正常选拳阶段补齐座位后开局。
  // 惩罚阶段或结算阶段有人进房时，绝不能清空惩罚状态。
  if (room.phase === "punishment" || room.phase === "result") return;
  if (room.phase === "choosing" && (room.choices.A || room.choices.B)) return;
  if (!room.seats.A || !room.seats.B) return;
  room.phase = "choosing";
  room.status = "playing";
  room.choices = {};
  room.revealedChoices = undefined;
  room.resultText = undefined;
  room.proofs = [];
  room.punishedPlayerIds = [];
}

function prepareNextChoice(room: RoomState) {
  if (!room.seats.A || !room.seats.B) {
    room.phase = "ready";
    room.status = "waiting";
    return;
  }
  room.phase = "choosing";
  room.status = "playing";
  room.choices = {};
  room.revealedChoices = undefined;
  room.resultText = undefined;
  room.proofs = [];
  room.punishedPlayerIds = [];
}

function maybeBotAct(room: RoomState) {
  const botSeat = (["A", "B"] as SeatKey[]).find((seat) => room.seats[seat] && "isBot" in room.seats[seat]!);
  if (!botSeat || room.phase !== "choosing") return;
  if (room.choices[botSeat]) return;
  if (botTimers.has(room.id)) return;
  const timer = setTimeout(() => {
    botTimers.delete(room.id);
    try {
      const current = rooms.get(room.id);
      if (!current || current.phase !== "choosing") return;
      if (current.choices[botSeat]) return;
      const bot = current.seats[botSeat];
      if (!bot || !("isBot" in bot)) return;
      current.choices[botSeat] = botMove(current, bot);
      const oldStatus = current.status;
      finishRoundIfReady(current);
      broadcastRoom(current.id, oldStatus !== current.status);
    } catch (error) {
      console.error("Bot 出拳失败：", error);
    }
  }, 600 + Math.random() * 700);
  botTimers.set(room.id, timer);
}

function finishRoundIfReady(room: RoomState) {
  if (!room.choices.A || !room.choices.B) return;
  const choiceA = room.choices.A as Move;
  const choiceB = room.choices.B as Move;
  const giveawaySeats = giveawayForcedSeats(room);
  const finalChoices: Record<SeatKey, Move> = {
    A: giveawaySeats.includes("A") ? "giveaway" : choiceA,
    B: giveawaySeats.includes("B") ? "giveaway" : choiceB
  };
  const baseResult = finalChoices.A === "giveaway" || finalChoices.B === "giveaway"
    ? "draw"
    : judge(finalChoices.A as RpsMove, finalChoices.B as RpsMove);
  const result = resultWithGiveaway(room, baseResult, finalChoices);
  const punishedPlayers = punishmentPlayersForResult(room, result);
  const punishedNames = punishedPlayers.map((player) => playerShortName(player));
  const punishment = currentPunishment(room);
  const punishmentTasks = buildPunishmentTasks(room, punishedPlayers, result, punishment);
  room.phase = "result";
  room.revealedChoices = finalChoices;

  const playerA = room.seats.A && !("isBot" in room.seats.A) ? players.get(room.seats.A.id) : undefined;
  const playerB = room.seats.B && !("isBot" in room.seats.B) ? players.get(room.seats.B.id) : undefined;
  if (playerA && isRpsMove(choiceA)) playerA.recentMoves.push(choiceA);
  if (playerB && isRpsMove(choiceB)) playerB.recentMoves.push(choiceB);
  for (const seat of giveawaySeats) {
    const player = seat === "A" ? playerA : playerB;
    if (player) addGiveawayValue(player, 2);
  }
  const giveawayResultSeats = (["A", "B"] as SeatKey[]).filter((seat) => finalChoices[seat] === "giveaway");
  const giveawayText = giveawayResultSeats.length
    ? giveawayResultSeats.length >= 2
      ? "双方白给"
      : `${occupantName(room.seats[giveawayResultSeats[0]])} 白给`
    : "";

  if (result === "doubleLoss") {
    if (playerA) playerA.stats.losses += 1;
    if (playerB) playerB.stats.losses += 1;
    room.seatStats.A.losses += 1;
    room.seatStats.B.losses += 1;
    if (room.settings.enableRanked) applyRankedDrawPenalty(playerA, playerB, room.settings.stake);
    room.resultText = room.settings.enableRanked
      ? `双方白给，双输：双方各扣 ${room.settings.stake} 分`
      : "双方白给，双输";
  } else if (result === "draw") {
    if (playerA) playerA.stats.draws += 1;
    if (playerB) playerB.stats.draws += 1;
    room.seatStats.A.draws += 1;
    room.seatStats.B.draws += 1;
    if (room.settings.enableRanked && room.settings.tieDoublePunish) {
      applyRankedDrawPenalty(playerA, playerB, room.settings.stake);
      room.resultText = `平局双罚：双方都出了 ${moveText(finalChoices.A)}，双方各扣 ${room.settings.stake} 分`;
    } else {
      room.resultText = `平局：双方都出了 ${moveText(finalChoices.A)}`;
    }
    if (giveawayText) room.resultText = `${giveawayText}：${room.resultText}`;
  } else {
    const winnerSeat = result;
    const loserSeat = result === "A" ? "B" : "A";
    const winner = winnerSeat === "A" ? playerA : playerB;
    const loser = loserSeat === "A" ? playerA : playerB;
    if (winner) winner.stats.wins += 1;
    if (loser) loser.stats.losses += 1;
    room.score[winnerSeat] += 1;
    room.seatedScore[winnerSeat] += 1;
    room.seatStats[winnerSeat].wins += 1;
    room.seatStats[loserSeat].losses += 1;
    if (room.settings.enableRanked) applyRanked(winner, loser, room.settings.stake);
    room.resultText = giveawayText
      ? `${giveawayText}，${occupantName(room.seats[winnerSeat])}胜利`
      : `${winnerSeat} 获胜：A 出 ${moveText(finalChoices.A)}，B 出 ${moveText(finalChoices.B)}`;
  }

  addRoundHistory(room, {
    id: randomId(),
    round: room.roundHistory.length + 1,
    at: Date.now(),
    playerA: occupantName(room.seats.A),
    playerB: occupantName(room.seats.B),
    moveA: finalChoices.A,
    moveB: finalChoices.B,
    result,
    resultLabel: roundResultLabel(room, result),
    resultText: room.resultText ?? "",
    ranked: room.settings.enableRanked,
    stake: room.settings.enableRanked ? room.settings.stake : undefined,
    punishmentName: punishedNames.length ? punishmentNameForRoom(room, punishment) : undefined,
    punishmentDescription: punishedNames.length && room.settings.punishmentSource !== "player" ? punishment?.description : undefined,
    punishmentTasks,
    punishedNames,
    proofs: []
  });
  setupPunishmentOrNext(room, result);
}

function punishmentPlayersForResult(room: RoomState, result: RoundResult) {
  if (!room.settings.enablePunishment) return [];
  const punishSeats: SeatKey[] = [];
  if (result === "doubleLoss") {
    punishSeats.push("A", "B");
  } else if (result === "draw") {
    if (room.settings.tieDoublePunish) punishSeats.push("A", "B");
  } else {
    punishSeats.push(result === "A" ? "B" : "A");
  }
  return punishSeats
    .map((seat) => room.seats[seat])
    .filter((occupant): occupant is PublicPlayer => Boolean(occupant && !("isBot" in occupant)))
    .map((player) => players.get(player.id))
    .filter((player): player is PlayerState => Boolean(player));
}

function addRoundHistory(room: RoomState, item: RoundHistoryItem) {
  room.roundHistory.unshift(item);
}

function currentPunishment(room: RoomState) {
  const selected = selectedPunishments(room.settings);
  return selected.length ? randomFrom(selected) : undefined;
}

function selectedPunishmentIds(settings: RoomSettings) {
  const rawIds = settings.punishmentIds?.length ? settings.punishmentIds : settings.punishmentId ? [settings.punishmentId] : [];
  const validIds = rawIds.filter((id, index) =>
    rawIds.indexOf(id) === index &&
    config.punishments.some((punishment) => punishment.id === id)
  );
  if (validIds.length) return validIds;
  return config.punishments[0]?.id ? [config.punishments[0].id] : [];
}

function selectedPunishments(settings: RoomSettings) {
  const ids = selectedPunishmentIds(settings);
  return ids
    .map((id) => config.punishments.find((punishment) => punishment.id === id))
    .filter((punishment): punishment is AppConfig["punishments"][number] => Boolean(punishment));
}

function primaryPunishmentForSettings(settings: RoomSettings) {
  const ids = selectedPunishmentIds(settings);
  const lastId = ids[ids.length - 1];
  return config.punishments.find((punishment) => punishment.id === lastId);
}

function roomNamePoolForSettings(settings: RoomSettings) {
  if (settings.enablePunishment && settings.punishmentSource === "player") return config.playerPunishmentRoomNamePool;
  if (settings.enablePunishment) return primaryPunishmentForSettings(settings)?.roomNamePool;
  return undefined;
}

function generatedRoomName(settings: RoomSettings) {
  const pool = roomNamePoolForSettings(settings);
  if (!pool) return settings.name?.trim() || defaultRoomName;
  const subject = randomFrom(pool.subjects);
  const roomWord = randomFrom(pool.roomWords);
  const adjective = pool.adjectives.length && Math.random() < 0.75 ? randomFrom(pool.adjectives) : "";
  const base = `${adjective}${subject}${roomWord}`;
  return uniqueRoomName(base);
}

function normalizeRoomName(settings: RoomSettings) {
  const cleanName = String(settings.name || "").trim().slice(0, 24);
  if (!cleanName || cleanName === defaultRoomName) return generatedRoomName(settings);
  return cleanName;
}

function uniqueRoomName(baseName: string) {
  let name = baseName || defaultRoomName;
  let counter = 2;
  while ([...rooms.values()].some((room) => room.settings.name === name)) {
    name = `${baseName} ${counter}`;
    counter += 1;
  }
  return name;
}

function randomRoomBackground(settings: RoomSettings) {
  if (!settings.enablePunishment || settings.punishmentSource === "player") return undefined;
  const images = primaryPunishmentForSettings(settings)?.roomBackgroundImages || [];
  return images.length ? randomFrom(images) : undefined;
}

function randomFrom<T>(values: T[]) {
  return values[Math.floor(Math.random() * values.length)] as T;
}

function punishmentNameForRoom(room: RoomState, punishment?: AppConfig["punishments"][number]) {
  if (room.settings.punishmentSource === "player") return "玩家发布任务";
  return punishment?.name;
}

function buildPunishmentTasks(room: RoomState, punishedPlayers: PlayerState[], result: RoundResult, punishment?: AppConfig["punishments"][number]) {
  return punishedPlayers.map((player) => {
    const assigner = room.settings.punishmentSource === "player" ? taskAssigner(room, player.id) : undefined;
    const systemTask = room.settings.punishmentSource === "player" ? undefined : punishmentTaskForPlayer(player, punishment);
    return {
      playerId: player.id,
      playerName: playerShortName(player),
      factionId: player.factionId,
      factionLabel: player.factionLabel,
      // 系统任务会立刻写好；玩家发布模式先留空，等对手在惩罚阶段发布。
      taskText: systemTask?.taskText || "",
      backgroundImage: systemTask?.backgroundImage,
      backgroundOpacity: systemTask?.backgroundOpacity,
      assignedBy: assigner?.id,
      assignedByName: assigner?.name
    };
  });
}

function taskAssigner(room: RoomState, punishedPlayerId: string) {
  const punishedSeat = seatOf(room, punishedPlayerId);
  if (!punishedSeat) return undefined;
  const opponentSeat = punishedSeat === "A" ? "B" : "A";
  const opponent = room.seats[opponentSeat];
  if (!opponent || "isBot" in opponent) return undefined;
  return players.get(opponent.id);
}

function punishmentTaskForPlayer(player: Pick<PublicPlayer, "factionId" | "factionLabel">, punishment?: AppConfig["punishments"][number]) {
  if (!punishment) return { taskText: "请完成本局惩罚。", backgroundOpacity: 0.22 };
  const task = punishment.tasks?.length ? randomFrom(punishment.tasks) : undefined;
  const variant = task?.variants?.[player.factionId]?.trim() || punishment.variants?.[player.factionId]?.trim();
  const images = task?.backgroundImages || [];
  return {
    taskText: cleanTaskText(variant || punishment.description, player.factionLabel),
    backgroundImage: images.length ? randomFrom(images) : undefined,
    backgroundOpacity: task?.backgroundOpacity ?? 0.22
  };
}

function cleanTaskText(taskText: string, factionLabel: string) {
  return taskText
    .replace(new RegExp(`^${escapeRegExp(factionLabel)}[：:]\\s*`), "")
    .replace(/^(男性阵营|女性阵营|男娘阵营|其他阵营)[：:]\s*/, "")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attachProofToLatestHistory(room: RoomState, proof: {
  playerId: string;
  playerName: string;
  text: string;
  imageUrl?: string;
  taskText?: string;
  status?: "pending" | "approved" | "rejected";
  reviewedBy?: string;
  reviewedAt?: number;
  rejectReason?: string;
  redoTaskText?: string;
  submittedAt: number;
}) {
  const latest = room.roundHistory[0];
  if (!latest) return;
  const task = latest.punishmentTasks.find((item) => item.playerId === proof.playerId);
  latest.proofs = latest.proofs.filter((item) => item.playerId !== proof.playerId);
  latest.proofs.push({ ...proof, taskText: proof.taskText || task?.taskText });
}

function updateProofInLatestHistory(room: RoomState, playerId: string, next: Partial<RoomState["proofs"][number]>) {
  const latest = room.roundHistory[0];
  if (!latest) return;
  latest.proofs = latest.proofs.map((proof) => proof.playerId === playerId ? { ...proof, ...next } : proof);
}

function updatePunishmentTask(room: RoomState, playerId: string, taskText: string, assignedBy?: PlayerState) {
  const latest = room.roundHistory[0];
  if (!latest) return;
  latest.punishmentTasks = latest.punishmentTasks.map((task) => task.playerId === playerId ? {
    ...task,
    taskText,
    assignedBy: assignedBy?.id ?? task.assignedBy,
    assignedByName: assignedBy?.name ?? task.assignedByName
  } : task);
}

function oppositeForgiveProof(room: RoomState, reviewerId: string, targetId: string) {
  return room.proofs.find((proof) =>
    proof.playerId === reviewerId &&
    proof.status === "approved" &&
    proof.reviewedBy === targetId &&
    proof.rejectReason === "对方选择放过你"
  );
}

function applyForgiveReview(room: RoomState, reviewerId: string, targetId: string) {
  const opposite = oppositeForgiveProof(room, reviewerId, targetId);
  if (!opposite) {
    room.forgiveAdvantage = { beneficiaryId: reviewerId, targetId };
    return "对方选择放过你";
  }
  room.forgiveAdvantage = undefined;
  opposite.rejectReason = "双方互相放过，下一局正常开始。";
  updateProofInLatestHistory(room, reviewerId, { rejectReason: "双方互相放过，下一局正常开始。" });
  return "双方互相放过，下一局正常开始。";
}

function setupPunishmentOrNext(room: RoomState, result: RoundResult) {
  if (!room.settings.enablePunishment) {
    return;
  }

  const punishSeats: SeatKey[] = [];
  if (result === "doubleLoss") {
    punishSeats.push("A", "B");
  } else if (result === "draw") {
    if (room.settings.tieDoublePunish) punishSeats.push("A", "B");
  } else {
    punishSeats.push(result === "A" ? "B" : "A");
  }

  const humanIds = punishmentPlayersForResult(room, result).map((player) => player.id);

  if (humanIds.length === 0) {
    return;
  }

  room.phase = "punishment";
  room.status = "punishment";
  room.punishedPlayerIds = humanIds;
  room.lockedSeatIds = new Set(humanIds);
  for (const playerId of humanIds) {
    const player = players.get(playerId);
    if (player) player.stats.punishments += 1;
    const seat = seatOf(room, playerId);
    if (seat) room.seatStats[seat].punishments += 1;
  }
}

function punishmentComplete(room: RoomState) {
  return room.punishedPlayerIds.every((playerId) => {
    const task = room.roundHistory[0]?.punishmentTasks.find((item) => item.playerId === playerId);
    if (room.settings.punishmentSource === "player" && !task?.taskText.trim()) return false;
    const proof = room.proofs.find((item) => item.playerId === playerId);
    if (!proof) return false;
    if (!room.settings.requireOpponentConfirm) return proof.status !== "rejected";
    return proof.status === "approved" || Boolean(proof.confirmedBy);
  });
}

function opponentIsBot(room: RoomState, playerId: string) {
  const playerSeat = seatOf(room, playerId);
  if (!playerSeat) return false;
  const opponentSeat = playerSeat === "A" ? "B" : "A";
  const opponent = room.seats[opponentSeat];
  return Boolean(opponent && "isBot" in opponent);
}

function humanOpponent(room: RoomState, playerId: string) {
  const playerSeat = seatOf(room, playerId);
  if (!playerSeat) return undefined;
  const opponentSeat = playerSeat === "A" ? "B" : "A";
  const opponent = room.seats[opponentSeat];
  if (!opponent || "isBot" in opponent) return undefined;
  return players.get(opponent.id);
}

function proofNeedsReview(proof: RoomState["proofs"][number]) {
  return proof.status === "pending" || proof.status === "rejected";
}

function canReviewPlayer(room: RoomState, reviewerId: string, targetId: string) {
  const reviewerSeat = seatOf(room, reviewerId);
  const targetSeat = seatOf(room, targetId);
  return Boolean(reviewerSeat && targetSeat && reviewerSeat !== targetSeat);
}

function approveProofBySystem(room: RoomState, playerId: string, message: string) {
  const proof = room.proofs.find((item) => item.playerId === playerId);
  if (!proof || proof.status === "approved") return false;
  const reviewedAt = Date.now();
  proof.status = "approved";
  proof.confirmedBy = "system-auto-forgive";
  proof.reviewedBy = "system-auto-forgive";
  proof.reviewedAt = reviewedAt;
  proof.rejectReason = message;
  updateProofInLatestHistory(room, playerId, {
    status: "approved",
    reviewedBy: "system-auto-forgive",
    reviewedAt,
    rejectReason: message
  });
  return true;
}

function submitSystemPunishmentProof(room: RoomState, player: PlayerState, message: string) {
  const latestTask = room.roundHistory[0]?.punishmentTasks.find((item) => item.playerId === player.id);
  const oldProof = room.proofs.find((proof) => proof.playerId === player.id);
  const taskText = oldProof?.redoTaskText || latestTask?.taskText;
  const submittedAt = Date.now();
  room.proofs = room.proofs.filter((proof) => proof.playerId !== player.id);
  room.proofs.push({
    playerId: player.id,
    text: message,
    taskText,
    status: "approved",
    confirmedBy: "system-timeout",
    reviewedBy: "system-timeout",
    reviewedAt: submittedAt,
    rejectReason: message,
    submittedAt
  });
  attachProofToLatestHistory(room, {
    playerId: player.id,
    playerName: playerShortName(player),
    text: message,
    taskText,
    status: "approved",
    reviewedBy: "system-timeout",
    reviewedAt: submittedAt,
    rejectReason: message,
    submittedAt
  });
}

function finishPunishmentIfComplete(room: RoomState) {
  if (room.phase === "punishment" && punishmentComplete(room)) {
    resetForNextRound(room);
    return true;
  }
  return false;
}

function canLeaveRoom(player: PlayerState, reason: LeaveReason): LeaveResult {
  if (!player.roomId) return { ok: true };
  const room = rooms.get(player.roomId);
  if (!room || room.phase !== "punishment") return { ok: true };
  const isPunished = room.punishedPlayerIds.includes(player.id);
  const isProtectedReason = reason === "manual" || reason === "switchRoom" || reason === "spectate";
  if (isPunished && isProtectedReason) return { ok: false, error: "惩罚完成前不能离开房间" };
  return { ok: true };
}

function handlePunishmentDeparture(room: RoomState, player: PlayerState, reason: LeaveReason) {
  if (room.phase !== "punishment") return;
  const isPunished = room.punishedPlayerIds.includes(player.id);
  const latest = room.roundHistory[0];

  if (isPunished && (reason === "disconnectTimeout" || reason === "adminKick")) {
    const playerName = playerShortName(player);
    const message = reason === "adminKick"
      ? `${playerName} 被管理员移出，系统已处理本局惩罚。`
      : `${playerName} 超时未返回，系统已处理本局惩罚。`;
    submitSystemPunishmentProof(room, player, message);
    room.lockedSeatIds.delete(player.id);
    roomNotice(room, message);
    if (finishPunishmentIfComplete(room)) return;
  }

  for (const task of latest?.punishmentTasks || []) {
    if (task.assignedBy === player.id && !task.taskText.trim()) {
      updatePunishmentTask(room, task.playerId, "对方已离开，请提交文字说明完成本局惩罚。");
      roomNotice(room, `${playerShortName(player)} 离开，系统已为 ${task.playerName} 发布兜底任务。`);
    }
  }

  for (const proof of [...room.proofs]) {
    if (proofNeedsReview(proof) && canReviewPlayer(room, player.id, proof.playerId)) {
      const target = players.get(proof.playerId);
      approveProofBySystem(room, proof.playerId, "审核方离开，系统已自动放过对方。");
      roomNotice(room, `${playerShortName(player)} 离开，系统已自动放过 ${target ? playerShortName(target) : "对方"}。`);
    }
  }

  finishPunishmentIfComplete(room);
}

function resetForNextRound(room: RoomState) {
  prepareNextChoice(room);
  room.punishedPlayerIds = [];
  room.proofs = [];
  room.lockedSeatIds.clear();
  broadcastRoom(room.id, true);
}

function clearSeatForPlayer(room: RoomState, seat: SeatKey) {
  const leavingId = room.seats[seat]?.id;
  if (leavingId) room.disconnectForfeits.delete(leavingId);
  room.seats[seat] = null;
  room.ready[seat] = false;
  room.choices[seat] = undefined;
  room.score[seat] = 0;
  room.seatedScore[seat] = 0;
  room.seatStats[seat] = emptySeatStats();
  if (leavingId && (room.forgiveAdvantage?.beneficiaryId === leavingId || room.forgiveAdvantage?.targetId === leavingId)) {
    room.forgiveAdvantage = undefined;
  }
}

function leaveRoom(player: PlayerState, reason: LeaveReason = "manual"): LeaveResult {
  if (!player.roomId) return { ok: true };
  const leaveCheck = canLeaveRoom(player, reason);
  if (!leaveCheck.ok) return leaveCheck;
  const room = rooms.get(player.roomId);
  if (!room) {
    if (player.socketId) io.sockets.sockets.get(player.socketId)?.leave(player.roomId);
    player.roomId = undefined;
    return { ok: true };
  }
  handlePunishmentDeparture(room, player, reason);
  if (reason === "manual" || reason === "switchRoom") roomNotice(room, `${playerShortName(player)} 离开了房间。`);
  if (reason === "adminKick") roomNotice(room, `${playerShortName(player)} 被管理员移出房间。`);
  const seat = seatOf(room, player.id);
  if (seat) {
    clearSeatForPlayer(room, seat);
  }
  if (player.socketId) io.sockets.sockets.get(player.socketId)?.leave(room.id);
  room.spectatorIds = room.spectatorIds.filter((id) => id !== player.id);
  player.roomId = undefined;
  if (!cleanupRoomIfEmpty(room)) {
    broadcastRoom(room.id);
  }
  broadcastLobby();
  return { ok: true };
}

io.on("connection", (socket) => {
  socket.emit("config:update", config);
  socket.emit("lobby:update", lobbySnapshot({ includeConfig: true }));

  socket.on("player:join", ({ name, genderId, token }: { name: string; genderId: string; token?: string }, reply) => {
    const cleanName = String(name || "").trim().slice(0, 12);
    if (cleanName.length < 2) return reply?.({ error: config.messages.nameRequired });

    const ipAddress = socketIp(socket);
    let player = token ? players.get(tokenToPlayerId.get(token) || "") : undefined;
    if (!player) {
      if (onlinePlayersFromIp(ipAddress) >= config.accessControl.maxOnlinePerIp) {
        return reply?.({ error: `当前网络下在线人数过多，最多允许 ${config.accessControl.maxOnlinePerIp} 人同时在线` });
      }
      if (!canCreateFromIp(ipAddress)) {
        return reply?.({ error: `当前网络 10 分钟内新建玩家过多，最多允许 ${config.accessControl.maxCreatesPer10Min} 次` });
      }
      player = createPlayer(cleanName, genderId, token);
    }
    const wasDisconnected = !player.connected;
    const hadDisconnectHold = Boolean(player.disconnectExpiresAt);
    const previousSocketId = player.socketId;
    const previousRoomId = player.roomId;
    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      previousSocket?.leave(player.id);
      if (previousRoomId) previousSocket?.leave(previousRoomId);
    }
    player.socketId = socket.id;
    player.ipAddress = ipAddress;
    player.connected = true;
    player.disconnectExpiresAt = undefined;
    if (!player.nameWarEnabled) {
      player.name = cleanName;
      player.nameWarOriginalName = cleanName;
    }
    applyGender(player, genderId);
    refreshNameWarState(player);
    clearDisconnectHold(player);
    clearDisconnectForfeit(player);
    if (wasDisconnected && hadDisconnectHold) serverStats.reconnects += 1;
    refreshPlayerSnapshots(player);
    if (player.roomId) {
      const existingRoom = rooms.get(player.roomId);
      if (!existingRoom || !roomHasPlayer(existingRoom, player.id)) player.roomId = undefined;
    }
    socket.join(player.id);
    if (player.roomId) socket.join(player.roomId);
    const currentRoom = player.roomId ? rooms.get(player.roomId) : undefined;
    reply?.({ player: publicPlayer(player), token: player.token, roomId: player.roomId, room: currentRoom ? roomSnapshot(currentRoom, { includeChat: true }) : undefined });
    broadcastLobby();
    if (player.roomId) {
      if (currentRoom?.phase === "punishment" && hadDisconnectHold) {
        roomNotice(currentRoom, `${playerShortName(player)} 已重新连接，恢复到未完成的惩罚房间。`);
      }
      broadcastRoom(player.roomId);
    }
  });

  socket.on("admin:login", ({ password }: { password: string }, reply) => {
    const player = getPlayer(socket.id);
    if (!adminPasswordMatches(password)) return reply?.({ error: "管理员口令不正确或尚未设置" });
    adminSocketIds.add(socket.id);
    if (player) player.isAdmin = true;
    reply?.({ ok: true });
    broadcastLobby();
  });

  socket.on("player:updateProfile", ({ name, genderId, nameWarEnabled, nameWarAllowRename, giveawayEnabled }: { name: string; genderId: string; nameWarEnabled?: boolean; nameWarAllowRename?: boolean; giveawayEnabled?: boolean }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入大厅" });
    const cleanName = String(name || "").trim().slice(0, 12);
    if (cleanName.length < 2) return reply?.({ error: config.messages.nameRequired });

    const now = Date.now();
    const nameChanged = cleanName !== player.name;
    const nextNameWarEnabled = Boolean(nameWarEnabled);
    const nextAllowRename = nextNameWarEnabled && Boolean(nameWarAllowRename);
    const nameWarChanged = nextNameWarEnabled !== Boolean(player.nameWarEnabled);
    const allowRenameChanged = nextAllowRename !== Boolean(player.nameWarAllowRename);
    const nextGiveawayEnabled = Boolean(giveawayEnabled);
    // 名字会出现在大厅、排行榜、房间座位和聊天里，所以只给“改名”做冷却；
    // 性别标签允许随时调整，避免玩家只是换阵营标签也被卡住。
    if (nameChanged && (player.nameWarEnabled || nextNameWarEnabled)) {
      return reply?.({ error: "名字争夺战开启后不能修改自己的名字" });
    }
    if (nameChanged && player.profileUpdatedAt && now - player.profileUpdatedAt < 60_000) {
      const seconds = Math.ceil((60_000 - (now - player.profileUpdatedAt)) / 1000);
      return reply?.({ error: `改名太频繁，请 ${seconds} 秒后再试` });
    }
    if ((nameWarChanged || allowRenameChanged) && player.nameWarToggledAt && now - player.nameWarToggledAt < 43_200_000) {
      const hours = Math.ceil((43_200_000 - (now - player.nameWarToggledAt)) / 3_600_000);
      return reply?.({ error: `名字争夺战冷却中，请 ${hours} 小时后再试` });
    }
    if (player.giveawayEnabled && !nextGiveawayEnabled && (player.giveawayValue || 0) > 0) {
      return reply?.({ error: "白给值归零前不能关闭白给模式" });
    }

    if (nameChanged) {
      player.name = cleanName;
      player.nameWarOriginalName = cleanName;
    }
    const exitedHardMode = Boolean(player.nameWarAllowRename) && !nextAllowRename;
    if (nameWarChanged || allowRenameChanged) {
      player.nameWarEnabled = nextNameWarEnabled;
      player.nameWarAllowRename = nextAllowRename;
      player.nameWarToggledAt = now;
      if (!nextNameWarEnabled) {
        player.stats.rankedPoints = clamp(player.stats.rankedPoints, -999, 999);
        syncTitleForRankSegment(player);
      }
    }
    applyGender(player, genderId);
    refreshNameWarState(player, now);
    if (exitedHardMode) player.stats.title = config.nameWar.escapeTitle || "逃跑的人";
    player.giveawayEnabled = nextGiveawayEnabled;
    if (!player.giveawayEnabled && (player.giveawayValue || 0) <= 0) {
      player.giveawayValue = 0;
      player.giveawayBoardText = undefined;
      player.giveawayBoardSubmittedAt = undefined;
      player.giveawayBoardExpiresAt = undefined;
    }
    if (nameChanged) player.profileUpdatedAt = now;
    player.displayName = formatDisplayName(player);
    refreshPlayerSnapshots(player);
    reply?.({ player: publicPlayer(player) });
    broadcastLobby();
    if (player.roomId) broadcastRoom(player.roomId);
  });

  socket.on("giveaway:boost", (_payload, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (!player.giveawayEnabled) return reply?.({ error: "请先在个人设置开启白给模式" });
    if (!seatOf(room, player.id)) return reply?.({ error: "只有战斗席玩家可以白给" });
    if (!isHumanVsHumanRoom(room)) return reply?.({ error: "Bot 对战不能使用白给模式" });
    if (room.phase === "punishment") return reply?.({ error: "惩罚阶段不能增加白给值" });
    addGiveawayValue(player, 2);
    player.giveawayClicks = (player.giveawayClicks || 0) + 1;
    reply?.({ player: publicPlayer(player) });
    broadcastLobby();
    broadcastRoom(room.id);
  });

  socket.on("giveaway:submitBoard", ({ text }: { text: string }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入游戏" });
    if (!player.giveawayEnabled || (player.giveawayValue || 0) <= 0) return reply?.({ error: "白给值大于 0% 时才能上板自救" });
    const cleanText = String(text || "").trim().slice(0, 300);
    if (cleanText.length < 2) return reply?.({ error: "自我惩罚宣言至少需要 2 个字" });
    const now = Date.now();
    player.giveawayBoardText = cleanText;
    player.giveawayBoardSubmittedAt = now;
    player.giveawayBoardExpiresAt = now + giveawayBoardDurationMs;
    player.giveawayBoardLikes = 0;
    player.giveawayBoardDislikes = 0;
    player.giveawayBoardLikeWindowStartedAt = now;
    player.giveawayBoardLikesThisHour = 0;
    reply?.({ player: publicPlayer(player) });
    broadcastLobby();
  });

  socket.on("giveaway:vote", ({ targetId, vote }: { targetId: string; vote: "like" | "dislike" }, reply) => {
    const actor = getPlayer(socket.id);
    const target = players.get(targetId);
    if (!actor) return reply?.({ error: "请先进入游戏" });
    if (!target) return reply?.({ error: "上板玩家不存在" });
    refreshGiveawayBoard(target);
    if (actor.id === target.id) return reply?.({ error: "不能给自己投票" });
    if (!target.giveawayBoardText || !target.giveawayBoardExpiresAt || target.giveawayBoardExpiresAt <= Date.now()) return reply?.({ error: "这条自救内容已经不在板上" });
    if (vote !== "like" && vote !== "dislike") return reply?.({ error: "投票类型不正确" });
    const now = Date.now();
    if (!actor.giveawayVoteWindowStartedAt || now - actor.giveawayVoteWindowStartedAt >= 3_600_000) {
      actor.giveawayVoteWindowStartedAt = now;
      actor.giveawayVoteCount = 0;
    }
    if ((actor.giveawayVoteCount || 0) >= 3) return reply?.({ error: "你本小时已经操作 3 次白给自救板" });

    if (vote === "like") {
      if (!target.giveawayBoardLikeWindowStartedAt || now - target.giveawayBoardLikeWindowStartedAt >= 3_600_000) {
        target.giveawayBoardLikeWindowStartedAt = now;
        target.giveawayBoardLikesThisHour = 0;
      }
      if ((target.giveawayBoardLikesThisHour || 0) >= 3) return reply?.({ error: "这个玩家本小时点赞降值已满" });
      target.giveawayBoardLikesThisHour = (target.giveawayBoardLikesThisHour || 0) + 1;
      target.giveawayBoardLikes = (target.giveawayBoardLikes || 0) + 1;
      addGiveawayValue(target, -1);
      if ((target.giveawayValue || 0) <= 0) {
        target.giveawayBoardText = undefined;
        target.giveawayBoardSubmittedAt = undefined;
        target.giveawayBoardExpiresAt = undefined;
      }
    } else {
      target.giveawayBoardDislikes = (target.giveawayBoardDislikes || 0) + 1;
      addGiveawayValue(target, 0.1);
    }
    actor.giveawayVoteCount = (actor.giveawayVoteCount || 0) + 1;
    reply?.({ ok: true });
    broadcastLobby();
    if (target.roomId) broadcastRoom(target.roomId);
    if (actor.roomId && actor.roomId !== target.roomId) broadcastRoom(actor.roomId);
  });

  socket.on("nameWar:renameTarget", ({ targetId, name }: { targetId: string; name: string }, reply) => {
    const actor = getPlayer(socket.id);
    const target = players.get(targetId);
    if (!actor) return reply?.({ error: "请先进入游戏" });
    if (!target) return reply?.({ error: "失格者不存在" });
    refreshNameWarState(target);
    if (actor.id === target.id) return reply?.({ error: "不能修改自己的名字" });
    if (actor.stats.rankedPoints < 500) return reply?.({ error: "需要 500 分以上才能修改失格者名字" });
    if (!isNameWarRenameTarget(target)) return reply?.({ error: "对方当前不是可改名失格者" });
    const now = Date.now();
    if (target.nameWarRenameProtectedUntil && target.nameWarRenameProtectedUntil > now) {
      const hours = Math.ceil((target.nameWarRenameProtectedUntil - now) / 3_600_000);
      return reply?.({ error: `对方正在保护期内，请 ${hours} 小时后再试` });
    }
    if (nameWarRenameQuota(actor, now) <= 0) return reply?.({ error: "你 3 小时内已经修改了 3 个名字" });
    const cleanName = String(name || "").trim().slice(0, 12);
    if (cleanName.length < 2) return reply?.({ error: "新名字至少需要 2 个字" });
    target.nameWarPenaltyName = cleanName;
    target.nameWarPunished = true;
    target.nameWarRenameProtectedUntil = now + 21_600_000;
    target.nameWarRenamedBy = actor.id;
    target.nameWarRenamedByName = playerShortName(actor);
    actor.nameWarRenameCount = (actor.nameWarRenameCount || 0) + 1;
    target.displayName = formatDisplayName(target);
    refreshPlayerSnapshots(target);
    reply?.({ ok: true });
    broadcastLobby();
    if (target.roomId) broadcastRoom(target.roomId);
    if (actor.roomId && actor.roomId !== target.roomId) broadcastRoom(actor.roomId);
  });

  socket.on("config:get", (_payload, reply) => reply?.({ config }));
  socket.on("config:save", ({ password, nextConfig }: { password: string; nextConfig: AppConfig }, reply) => {
    if (!adminPasswordMatches(password)) return reply?.({ error: "管理员口令不正确或尚未设置" });
    try {
      config = saveConfig(nextConfig);
      refreshAllPlayersForConfig();
      reply?.({ config });
      broadcastLobby();
      io.emit("config:update", config);
    } catch (error) {
      reply?.({ error: error instanceof Error ? error.message : "配置保存失败" });
    }
  });
  socket.on("config:reset", ({ password }: { password: string }, reply) => {
    if (!adminPasswordMatches(password)) return reply?.({ error: "管理员口令不正确或尚未设置" });
    config = resetConfig();
    refreshAllPlayersForConfig();
    reply?.({ config });
    broadcastLobby();
    io.emit("config:update", config);
  });

  socket.on("room:create", ({ settings }: { settings: RoomSettings }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入大厅" });
    const normalizedSettings: RoomSettings = {
      ...settings,
      gameId: "rps",
      stake: settings.stake || 5,
      allowProofImage: settings.allowProofImage !== false,
      punishmentSource: settings.punishmentSource || "system"
    };
    if (normalizedSettings.enablePunishment && normalizedSettings.punishmentSource !== "player") {
      normalizedSettings.punishmentIds = selectedPunishmentIds(normalizedSettings);
      normalizedSettings.punishmentId = normalizedSettings.punishmentIds[normalizedSettings.punishmentIds.length - 1];
    }
    if (normalizedSettings.punishmentSource === "player") {
      normalizedSettings.punishmentIds = [];
      normalizedSettings.punishmentId = undefined;
    }
    normalizedSettings.tags = normalizeRoomTags(normalizedSettings);
    normalizedSettings.enableTags = normalizedSettings.tags.length > 0;
    normalizedSettings.name = normalizeRoomName(normalizedSettings);
    normalizedSettings.roomBackgroundImage = randomRoomBackground(normalizedSettings);
    if (normalizedSettings.enableRanked && normalizedSettings.enableBot) {
      return reply?.({ error: "排位战不能开启 Bot" });
    }
    if (normalizedSettings.enablePunishment && normalizedSettings.punishmentSource === "player" && normalizedSettings.enableBot) {
      return reply?.({ error: "玩家发布任务模式不能开启 Bot" });
    }
    const leaveResult = leaveRoom(player, "switchRoom");
    if (!leaveResult.ok) return reply?.({ error: leaveResult.error });
    const roomId = randomId();
    const room: RoomState = {
      id: roomId,
      code: roomCode(),
      ownerId: player.id,
      settings: normalizedSettings,
      status: normalizedSettings.enableBot ? "playing" : "waiting",
      updatedAt: Date.now(),
      phase: normalizedSettings.enableBot ? "choosing" : "ready",
      seats: { A: publicPlayer(player), B: normalizedSettings.enableBot ? makeBot(normalizedSettings.botDifficulty) : null },
      spectatorIds: [],
      ready: { A: false, B: false },
      choices: {},
      punishedPlayerIds: [],
      proofs: [],
      score: { A: 0, B: 0 },
      seatedScore: { A: 0, B: 0 },
      seatStats: { A: emptySeatStats(), B: emptySeatStats() },
      roundHistory: [],
      chat: [],
      lockedSeatIds: new Set(),
      disconnectForfeits: new Map(),
      createdAt: Date.now()
    };
    rooms.set(roomId, room);
    player.roomId = roomId;
    socket.join(roomId);
    roomNotice(room, `${playerShortName(player)} 进入房间，坐在战斗席 A。`);
    reply?.({ room: roomSnapshot(room, { includeChat: true }) });
    broadcastRoom(roomId, true);
  });

  socket.on("room:join", ({ roomId, password }: { roomId: string; password?: string }, reply) => {
    const player = getPlayer(socket.id);
    const room = rooms.get(roomId);
    if (!player || !room) return reply?.({ error: "房间不存在" });
    if (room.settings.password && room.settings.password !== password) return reply?.({ error: config.messages.passwordWrong });
    const leaveResult = leaveRoom(player, "switchRoom");
    if (!leaveResult.ok) return reply?.({ error: leaveResult.error });
    player.roomId = room.id;
    let joinRole = "观战";
    if (canAutoSeatOnJoin(room) && !room.seats.A) {
      room.seats.A = publicPlayer(player);
      joinRole = "战斗席 A";
    }
    else if (canAutoSeatOnJoin(room) && !room.seats.B) {
      room.seats.B = publicPlayer(player);
      joinRole = "战斗席 B";
    }
    else room.spectatorIds.push(player.id);
    socket.join(room.id);
    roomNotice(room, `${playerShortName(player)} 进入房间，位置：${joinRole}。`);
    maybeStartChoosing(room);
    reply?.({ room: roomSnapshot(room, { includeChat: true }) });
    broadcastRoom(room.id, true);
  });

  socket.on("room:leave", (_payload, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return;
    const leaveResult = leaveRoom(player, "manual");
    if (!leaveResult.ok) return reply?.({ error: leaveResult.error });
    reply?.({ ok: true });
  });

  socket.on("room:history", ({ roomId, offset, limit }: { roomId: string; offset?: number; limit?: number }, reply) => {
    const player = getPlayer(socket.id);
    const room = rooms.get(roomId);
    if (!player || !room || player.roomId !== room.id) return reply?.({ error: "你不在这个房间里" });
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || roomHistoryPageSize));
    reply?.({
      items: room.roundHistory.slice(safeOffset, safeOffset + safeLimit),
      total: room.roundHistory.length
    });
  });

  socket.on("room:sit", ({ seat }: { seat: SeatKey }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.phase === "punishment") return reply?.({ error: "惩罚完成前不能切换座位" });
    if (room.seats[seat]) return reply?.({ error: "这个战斗席已经有人了" });
    const oldSeat = seatOf(room, player.id);
    // 如果本局已经有人出拳，已坐下的玩家不能换座躲避本局。
    // 但空战斗席仍允许观战/新加入玩家补位，否则会出现“一边已出拳，另一边空位永远坐不上”的卡房间问题。
    if (oldSeat && room.phase === "choosing" && (room.choices.A || room.choices.B)) return reply?.({ error: "本局已经有人出拳，暂时不能换座" });
    if (oldSeat) {
      clearSeatForPlayer(room, oldSeat);
    }
    room.spectatorIds = room.spectatorIds.filter((id) => id !== player.id);
    room.seats[seat] = publicPlayer(player);
    room.ready[seat] = false;
    room.choices[seat] = undefined;
    room.seatedScore[seat] = 0;
    room.seatStats[seat] = emptySeatStats();
    roomNotice(room, `${playerShortName(player)} 坐到战斗席 ${seat}。`);
    maybeStartChoosing(room);
    broadcastRoom(room.id, true);
  });

  socket.on("room:spectate", (_payload, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    const leaveCheck = canLeaveRoom(player, "spectate");
    if (!leaveCheck.ok) return reply?.({ error: leaveCheck.error });
    const oldSeat = seatOf(room, player.id);
    if (room.phase !== "punishment" && oldSeat && room.choices[oldSeat]) return reply?.({ error: "你已经出拳，本局暂时不能离开座位" });
    handlePunishmentDeparture(room, player, "spectate");
    if (oldSeat) clearSeatForPlayer(room, oldSeat);
    if (!room.spectatorIds.includes(player.id)) room.spectatorIds.push(player.id);
    roomNotice(room, `${playerShortName(player)} 进入观战席。`);
    if (!cleanupRoomIfEmpty(room)) broadcastRoom(room.id, true);
  });

  socket.on("room:move", ({ move }: { move: Move }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (!["rock", "scissors", "paper", "giveaway"].includes(move)) return reply?.({ error: "出拳无效" });
    const seat = seatOf(room, player.id);
    if (!seat) return reply?.({ error: "只有战斗席玩家可以出拳" });
    if (!room.seats.A || !room.seats.B) return reply?.({ error: "需要双方都坐下才能出拳" });
    if (move === "giveaway" && (!player.giveawayEnabled || !isHumanVsHumanRoom(room))) {
      return reply?.({ error: "白给只在真人对战并开启白给模式后可用" });
    }
    if (room.phase === "punishment") return reply?.({ error: "惩罚完成前不能出拳" });
    if (room.phase === "result") prepareNextChoice(room);
    if (room.phase !== "choosing") return reply?.({ error: "现在还不能出拳" });
    if (room.choices[seat]) return reply?.({ error: "你已经出拳，不能修改" });
    room.choices[seat] = move;
    if (move === "giveaway") {
      player.giveawayClicks = (player.giveawayClicks || 0) + 1;
      addGiveawayValue(player, 2);
    }
    maybeBotAct(room);
    const oldStatus = room.status;
    finishRoundIfReady(room);
    broadcastRoom(room.id, oldStatus !== room.status);
  });

  socket.on("punishment:submit", ({ text, imageUrl }: { text: string; imageUrl?: string }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room || !room.punishedPlayerIds.includes(player.id)) return reply?.({ error: "你当前不需要提交惩罚" });
    if (!String(text || "").trim()) return reply?.({ error: "请填写文字证明" });
    if (imageUrl && room.settings.allowProofImage === false) return reply?.({ error: "本房间已关闭图片证明" });
    const oldProof = room.proofs.find((proof) => proof.playerId === player.id);
    const latestTask = room.roundHistory[0]?.punishmentTasks.find((item) => item.playerId === player.id);
    const taskText = oldProof?.redoTaskText || latestTask?.taskText;
    if (room.settings.punishmentSource === "player" && !String(taskText || "").trim()) {
      return reply?.({ error: "等待对方发布惩罚任务" });
    }
    const approvedBySystem = opponentIsBot(room, player.id) || !room.settings.requireOpponentConfirm || !humanOpponent(room, player.id);
    const submittedAt = Date.now();
    room.proofs = room.proofs.filter((proof) => proof.playerId !== player.id);
    room.proofs.push({
      playerId: player.id,
      text: String(text).trim(),
      imageUrl,
      taskText,
      status: approvedBySystem ? "approved" : "pending",
      // 如果对手是 bot，就不能再等待“对手确认”。这里让系统自动审核通过，
      // 不然玩家会被卡在惩罚阶段，无法进入下一局。
      confirmedBy: approvedBySystem ? "system-auto-confirm" : undefined,
      reviewedBy: approvedBySystem ? "system-auto-confirm" : undefined,
      reviewedAt: approvedBySystem ? submittedAt : undefined,
      submittedAt
    });
    attachProofToLatestHistory(room, {
      playerId: player.id,
      playerName: playerShortName(player),
      text: String(text).trim(),
      imageUrl,
      taskText,
      status: approvedBySystem ? "approved" : "pending",
      reviewedBy: approvedBySystem ? "system-auto-confirm" : undefined,
      reviewedAt: approvedBySystem ? submittedAt : undefined,
      submittedAt
    });
    if (punishmentComplete(room)) resetForNextRound(room);
    else broadcastRoom(room.id);
    reply?.({ ok: true });
  });

  socket.on("punishment:assignTask", ({ playerId, taskText }: { playerId: string; taskText: string }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.phase !== "punishment" || room.settings.punishmentSource !== "player") return reply?.({ error: "当前不是玩家发布任务模式" });
    if (!room.punishedPlayerIds.includes(playerId)) return reply?.({ error: "这个玩家当前不需要惩罚" });
    if (player.id === playerId) return reply?.({ error: "不能给自己发布任务" });
    const reviewerSeat = seatOf(room, player.id);
    const targetSeat = seatOf(room, playerId);
    if (!reviewerSeat || !targetSeat || reviewerSeat === targetSeat) return reply?.({ error: "只能给对手发布任务" });
    const latest = room.roundHistory[0];
    const task = latest?.punishmentTasks.find((item) => item.playerId === playerId);
    const expectedAssigner = taskAssigner(room, playerId);
    if (!task || (task.assignedBy || expectedAssigner?.id) !== player.id) return reply?.({ error: "这条任务不由你发布" });
    if (task.taskText.trim()) return reply?.({ error: "任务已经发布" });
    const cleanTask = String(taskText || "").trim().slice(0, 300);
    if (!cleanTask) return reply?.({ error: "请填写惩罚任务" });
    updatePunishmentTask(room, playerId, cleanTask, player);
    broadcastRoom(room.id);
    reply?.({ ok: true });
  });

  socket.on("punishment:review", ({ playerId, action, redoTaskText }: { playerId: string; action: "approve" | "forgive" | "reject"; redoTaskText?: string }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    const reviewerSeat = seatOf(room, player.id);
    if (!reviewerSeat) return reply?.({ error: "只有对战玩家可以确认" });
    if (player.id === playerId) return reply?.({ error: "不能审核自己的证明" });
    const targetSeat = seatOf(room, playerId);
    if (!targetSeat || targetSeat === reviewerSeat) return reply?.({ error: "只能审核对手的证明" });
    const proof = room.proofs.find((item) => item.playerId === playerId);
    if (!proof) return reply?.({ error: "对方还没有提交证明" });
    const reviewedAt = Date.now();
    if (action === "reject") {
      const cleanTask = String(redoTaskText || "").trim().slice(0, 300);
      if (!cleanTask) return reply?.({ error: "请填写新的惩罚任务" });
      proof.status = "rejected";
      proof.reviewedBy = player.id;
      proof.reviewedAt = reviewedAt;
      proof.rejectReason = "需要重做";
      proof.redoTaskText = cleanTask;
      proof.confirmedBy = undefined;
      updatePunishmentTask(room, playerId, cleanTask);
      updateProofInLatestHistory(room, playerId, {
        status: "rejected",
        reviewedBy: player.id,
        reviewedAt,
        rejectReason: "需要重做",
        redoTaskText: cleanTask
      });
      broadcastRoom(room.id);
      return reply?.({ ok: true });
    }
    const reviewMessage = action === "forgive" ? applyForgiveReview(room, player.id, playerId) : undefined;
    proof.status = "approved";
    proof.confirmedBy = player.id;
    proof.reviewedBy = player.id;
    proof.reviewedAt = reviewedAt;
    proof.rejectReason = reviewMessage;
    updateProofInLatestHistory(room, playerId, {
      status: "approved",
      reviewedBy: player.id,
      reviewedAt,
      rejectReason: reviewMessage
    });
    if (punishmentComplete(room)) resetForNextRound(room);
    else broadcastRoom(room.id);
    reply?.({ ok: true });
  });

  socket.on("punishment:confirm", ({ playerId }: { playerId: string }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    const reviewerSeat = seatOf(room, player.id);
    if (!reviewerSeat) return reply?.({ error: "只有对战玩家可以确认" });
    if (player.id === playerId) return reply?.({ error: "不能审核自己的证明" });
    const targetSeat = seatOf(room, playerId);
    if (!targetSeat || targetSeat === reviewerSeat) return reply?.({ error: "只能审核对手的证明" });
    const proof = room.proofs.find((item) => item.playerId === playerId);
    if (!proof) return reply?.({ error: "对方还没有提交证明" });
    const reviewedAt = Date.now();
    proof.status = "approved";
    proof.confirmedBy = player.id;
    proof.reviewedBy = player.id;
    proof.reviewedAt = reviewedAt;
    updateProofInLatestHistory(room, playerId, { status: "approved", reviewedBy: player.id, reviewedAt });
    if (punishmentComplete(room)) resetForNextRound(room);
    else broadcastRoom(room.id);
    reply?.({ ok: true });
  });

  socket.on("chat:send", ({ roomId, text }: { roomId?: string; text: string }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入游戏" });
    if (!String(text || "").trim()) return reply?.({ error: "请输入聊天内容" });
    refreshNameWarState(player);
    refreshPlayerSnapshots(player);
    const message: ChatMessage = {
      id: randomId(),
      roomId,
      playerId: player.id,
      author: player.displayName,
      authorPlayer: publicPlayer(player),
      text: String(text).trim().slice(0, 300),
      at: Date.now()
    };
    if (roomId) {
      const room = rooms.get(roomId);
      if (!room || player.roomId !== roomId) return reply?.({ error: "你不在这个房间里" });
      message.authorRole = roomRole(room, player.id);
      appendRoomChat(room, message);
      io.to(roomId).emit("chat:append", message);
    } else {
      appendLobbyChat(message);
      broadcastLobby();
    }
    reply?.({ ok: true });
  });

  socket.on("suggestion:add", ({ text }: { text: string }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入游戏" });
    if (!String(text || "").trim()) return reply?.({ error: "请输入留言内容" });
    const suggestion = { id: randomId(), playerId: player.id, author: player.displayName, authorPlayer: publicPlayer(player), text: String(text).trim().slice(0, 500), at: Date.now() };
    appendSuggestion(suggestion);
    io.emit("suggestion:append", suggestion);
    reply?.({ ok: true });
  });

  socket.on("admin:action", ({ action, roomId, playerId, name, rankedPoints, title, message, durationSeconds }: { action: string; roomId?: string; playerId?: string; name?: string; rankedPoints?: number | string; title?: string; message?: string; durationSeconds?: number | string }, reply) => {
    const admin = getPlayer(socket.id);
    if (!admin?.isAdmin && !adminSocketIds.has(socket.id)) return reply?.({ error: "需要管理员权限" });
    let roomDeleted = false;
    let changedPlayerRoomId: string | undefined;
    if (action === "clearSuggestions") suggestions.length = 0;
    if (action === "clearLobbyChat") lobbyChat.length = 0;
    if (action === "broadcastAnnouncement") {
      const cleanMessage = String(message || "").trim().slice(0, 200);
      if (!cleanMessage) return reply?.({ error: "公告内容不能为空" });
      const safeSeconds = clamp(Math.round(Number(durationSeconds) || 8), 3, 60);
      io.emit("announcement:show", {
        id: randomId(),
        message: cleanMessage,
        durationMs: safeSeconds * 1000,
        createdAt: Date.now()
      });
    }
    if (action === "closeRoom" && roomId) {
      const room = rooms.get(roomId);
      if (room) {
        io.to(roomId).emit("room:closed", { message: `房间 ${room.settings.name} 已被管理员关闭。` });
        for (const id of [room.seats.A?.id, room.seats.B?.id, ...room.spectatorIds]) {
          const player = id ? players.get(id) : undefined;
          if (player) {
            player.roomId = undefined;
            clearDisconnectHold(player);
          }
        }
        io.socketsLeave(roomId);
        const botTimer = botTimers.get(roomId);
        if (botTimer) clearTimeout(botTimer);
        botTimers.delete(roomId);
        rooms.delete(roomId);
        roomDeleted = true;
      }
    }
    if (action === "clearRoomChat" && roomId) {
      const room = rooms.get(roomId);
      if (room) room.chat = [];
    }
    if (action === "forceNext" && roomId) {
      const room = rooms.get(roomId);
      if (room) resetForNextRound(room);
    }
    if (action === "kick" && playerId) {
      const player = players.get(playerId);
      if (player) {
        leaveRoom(player, "adminKick");
        clearDisconnectHold(player);
        players.delete(player.id);
        tokenToPlayerId.delete(player.token);
        if (player.socketId) io.to(player.socketId).emit("player:kicked");
      }
    }
    if (action === "editPlayer" && playerId) {
      const player = players.get(playerId);
      if (!player) return reply?.({ error: "玩家不存在" });
      const cleanName = String(name || "").trim().slice(0, 12);
      const cleanTitle = String(title || "").trim().slice(0, 18);
      const nextPoints = Number(rankedPoints);
      if (cleanName.length < 2) return reply?.({ error: "名字至少需要 2 个字" });
      if (!Number.isFinite(nextPoints)) return reply?.({ error: "积分格式不正确" });
      player.name = cleanName;
      player.nameWarOriginalName = cleanName;
      setRankedPointsByAdmin(player, nextPoints);
      if (cleanTitle) player.stats.title = cleanTitle;
      player.displayName = formatDisplayName(player);
      refreshPlayerSnapshots(player);
      changedPlayerRoomId = player.roomId;
    }
    reply?.({ ok: true });
    broadcastLobby();
    if (roomId && !roomDeleted) broadcastRoom(roomId);
    if (changedPlayerRoomId && changedPlayerRoomId !== roomId) broadcastRoom(changedPlayerRoomId);
  });

  socket.on("disconnect", () => {
    adminSocketIds.delete(socket.id);
    const player = getPlayer(socket.id);
    if (!player) return;
    serverStats.disconnects += 1;
    clearDisconnectHold(player);
    player.socketId = undefined;

    // 短暂刷新页面、手机网络抖动都很常见。前 30 秒先不广播离线，
    // 避免房间聊天一直刷“断线了”；超过 30 秒才进入可见的 60 秒保留倒计时。
    player.disconnectGraceTimer = setTimeout(() => {
      const current = players.get(player.id);
      if (!current || current.socketId || current.disconnectGraceTimer !== player.disconnectGraceTimer) return;
      current.disconnectGraceTimer = undefined;
      current.connected = false;
      current.disconnectExpiresAt = Date.now() + 60_000;
      refreshPlayerSnapshots(current);
      if (current.roomId) {
        const room = rooms.get(current.roomId);
        if (room) {
          createDisconnectForfeit(room, current);
          roomNotice(room, `${playerShortName(current)} 断线了，保留座位 60 秒。`);
          broadcastRoom(room.id);
        }
      }
      broadcastLobby();

      current.disconnectTimer = setTimeout(() => {
        const expired = players.get(current.id);
        if (!expired || expired.connected) return;
        if (expired.roomId) {
          const room = rooms.get(expired.roomId);
          if (room) applyDisconnectForfeit(room, expired);
          leaveRoom(expired, "disconnectTimeout");
        }
        // 超过可见倒计时后只清掉房间/座位保护，不删除玩家档案。
        // 否则玩家稍后用同一个浏览器回来时会被当成新玩家，积分和战绩看起来像“莫名清零”。
        expired.disconnectExpiresAt = undefined;
        expired.disconnectTimer = undefined;
        broadcastLobby();
      }, 60_000);
    }, 30_000);
  });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`RPS Online server listening on http://${host}:${port}`);
});

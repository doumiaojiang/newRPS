import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import helmet from "helmet";
import multer from "multer";
import { Server, type Socket } from "socket.io";
import { fileURLToPath } from "node:url";
import { exportConfigText, getRootDir, loadConfig, resetConfig, saveConfig } from "./config.js";
import type { NextFunction, Request, Response } from "express";
import type {
  AppConfig,
  BotDifficulty,
  BotPlayer,
  ChatMessage,
  Move,
  PublicPlayer,
  RankMultiplier,
  RoundResult,
  RoundHistoryItem,
  RoomSettings,
  RoomSnapshot,
  RankStake,
  SeatKey,
  SeatStats,
  SeatOccupant,
  Suggestion,
  OthelloCell,
  OthelloState,
  TicTacToeCell,
  TicTacToeState
} from "../shared/types.js";

type RpsMove = Exclude<Move, "giveaway" | "forfeit" | "noMove">;

type PlayerState = PublicPlayer & {
  socketId?: string;
  token: string;
  ipAddress?: string;
  disconnectGraceTimer?: NodeJS.Timeout;
  disconnectTimer?: NodeJS.Timeout;
  recentMoves: RpsMove[];
  // 长期身份：playerId + playerSecret 由前端持久化，和 session(sid/token) 解耦。
  // 这些字段绝不进入公开快照（publicPlayer 会剥离），也绝不写入日志。
  playerId?: string;
  playerSecretHash?: string;
  persistent?: boolean;
  currentSid?: string;
  createdAt?: number;
  lastSeenAt?: number;
};

function freshOthelloStats() {
  return { wins: 0, losses: 0, draws: 0, games: 0, captured: 0, lost: 0 };
}

type DisconnectForfeit = {
  loserId: string;
  loserSeat: SeatKey;
  loserName: string;
  winnerId: string;
  winnerSeat: SeatKey;
  winnerName: string;
  stake: number;
  baseStake: RankStake;
  rankMultiplier: RankMultiplier;
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
type SessionPayload = { sid: string; exp: number };
type RateLimitOptions = { limit: number; windowMs: number; cooldownMs?: number };

const defaultRoomName = "新的锤子剪刀布房间";
const defaultOthelloRoomName = "新的黑白棋房间";
const defaultTicTacToeRoomName = "新的井字棋房间";

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
// 长期身份索引：客户端 playerId -> 运行时 player.id（publicId）。
const playerIdToId = new Map<string, string>();
// 会话索引：sid -> player.id。sid/token 可重发、过期、销毁，不影响 player.id。
const sidToPlayerId = new Map<string, string>();
const dataDir = path.join(rootDir, "data");
const playersFile = path.join(dataDir, "players.json");
const rooms = new Map<string, RoomState>();
const botTimers = new Map<string, NodeJS.Timeout>();
const othelloSettlementTimers = new Map<string, NodeJS.Timeout>();
const ticTacToeGiveawayTimers = new Map<string, NodeJS.Timeout>();
const ipCreateAttempts = new Map<string, number[]>();
const suggestions: Suggestion[] = [];
const lobbyChat: ChatMessage[] = [];
const adminSocketIds = new Set<string>();
const sidToSocketId = new Map<string, string>();
const socketIdToSid = new Map<string, string>();
const socketIdsByIp = new Map<string, Set<string>>();
const rateBuckets = new Map<string, { hits: number[]; cooldownUntil?: number }>();
const maxRoomChatMessages = 200;
const maxLobbyMessages = 100;
const lobbyChannel = "lobby";
const lobbySuggestionChannel = "lobby:suggestions";
const roomHistoryPageSize = 20;
const giveawayBoardDurationMs = 12 * 60 * 60 * 1000;
const broadcastMetricWindowMs = 60_000;
const recentBroadcasts: Array<{ type: "room" | "lobby"; bytes: number; at: number }> = [];
const lobbyBroadcastDelayMs = Math.max(50, Number(process.env.LOBBY_BROADCAST_DELAY_MS) || 300);
const roomBroadcastDelayMs = Math.max(20, Number(process.env.ROOM_BROADCAST_DELAY_MS) || 60);
let lobbyBroadcastTimer: NodeJS.Timeout | undefined;
const roomBroadcastTimers = new Map<string, { timer: NodeJS.Timeout; updateLobby: boolean }>();
type RateLimitBucket = { resetAt: number; count: number };
const rateLimitBuckets = new Map<string, RateLimitBucket>();
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

const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessionTtlMs = Math.max(5 * 60_000, Number(process.env.SESSION_TTL_MS) || 24 * 60 * 60_000);
const maxSocketsPerIp = Math.max(1, Number(process.env.MAX_SOCKETS_PER_IP) || Math.max(5, (config.accessControl?.maxOnlinePerIp || 3) * 2));

function securityLog(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details
  }));
}

function hmac(input: string) {
  return crypto.createHmac("sha256", sessionSecret).update(input).digest("base64url");
}

function signSession(payload: SessionPayload) {
  const body = `${payload.sid}.${payload.exp}`;
  return `${body}.${hmac(body)}`;
}

function issueSessionToken() {
  return signSession({
    sid: crypto.randomBytes(16).toString("hex"),
    exp: Date.now() + sessionTtlMs
  });
}

function verifySessionToken(token: unknown): SessionPayload | null {
  const value = String(token || "");
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [sid, rawExp, signature] = parts;
  if (!/^[a-f0-9]{32}$/.test(sid)) return null;
  const exp = Number(rawExp);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  const expected = hmac(`${sid}.${rawExp}`);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return { sid, exp };
}

function checkRateLimit(key: string, options: RateLimitOptions) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { hits: [] };
  if (bucket.cooldownUntil && bucket.cooldownUntil > now) {
    rateBuckets.set(key, bucket);
    return false;
  }
  bucket.hits = bucket.hits.filter((time) => now - time < options.windowMs);
  if (bucket.hits.length >= options.limit) {
    bucket.cooldownUntil = now + (options.cooldownMs || options.windowMs);
    bucket.hits = [];
    rateBuckets.set(key, bucket);
    return false;
  }
  bucket.hits.push(now);
  bucket.cooldownUntil = undefined;
  rateBuckets.set(key, bucket);
  return true;
}

function rateLimitKey(event: string, ipAddress: string, sid?: string) {
  return `${event}:${ipAddress}:${sid || "anonymous"}`;
}

function socketSession(socket: { data: Record<string, unknown> }) {
  return {
    sid: String(socket.data.sid || ""),
    ipAddress: String(socket.data.ipAddress || "unknown")
  };
}

function guardedOn<T>(
  socket: Socket,
  event: string,
  options: RateLimitOptions,
  handler: (payload: T, reply?: (response: unknown) => void) => void
) {
  socket.on(event, (payload: T, reply?: (response: unknown) => void) => {
    const { sid, ipAddress } = socketSession(socket);
    if (!checkRateLimit(rateLimitKey(event, ipAddress, sid), options)) {
      securityLog("rate_limit", { sid, ip: ipAddress, event, userAgent: socket.handshake.headers["user-agent"] });
      return reply?.({ error: "操作过于频繁，请稍后再试" });
    }
    handler(payload, reply);
  });
}

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    credentials: true
  },
  allowRequest: (req, callback) => {
    callback(null, isAllowedOrigin(req.headers.origin, req.headers.host));
  },
  maxHttpBufferSize: 1_000_000,
  pingInterval: 25_000,
  pingTimeout: 30_000
});

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "same-origin" }
}));
app.use(securityHeaders);
app.use(requireTrustedOrigin);
app.use(createRateLimit("http", 60_000, 240));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));

app.post("/api/session", (req, res) => {
  const ipAddress = clientIpFromRequest(req);
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
    securityLog("session_origin_blocked", { ip: ipAddress, origin: req.headers.origin, userAgent: req.headers["user-agent"] });
    return res.status(403).json({ message: "Origin not allowed" });
  }
  if (!checkRateLimit(`session:${ipAddress}`, { limit: 10, windowMs: 60_000, cooldownMs: 60_000 })) {
    securityLog("token_issue_limited", { ip: ipAddress, userAgent: req.headers["user-agent"] });
    return res.status(429).json({ message: "请求过于频繁，请稍后再试" });
  }
  const token = issueSessionToken();
  const payload = verifySessionToken(token);
  securityLog("token_issued", { sid: payload?.sid, ip: ipAddress, userAgent: req.headers["user-agent"] });
  res.json({ token, expiresAt: payload?.exp });
});

app.use("/uploads", express.static(uploadsDir, {
  dotfiles: "deny",
  index: false,
  maxAge: "30d",
  immutable: true,
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

function publicConfig(): AppConfig {
  return {
    ...config,
    site: {
      ...config.site,
      adminPassword: ""
    }
  };
}

function sameHostOrLocalDev(origin: string, requestHost?: string) {
  try {
    const url = new URL(origin);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    if (localHosts.has(url.hostname)) return true;
    if (requestHost && url.host === requestHost) return true;
    return url.hostname === new URL(`http://${host}:${port}`).hostname;
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin: string | undefined, requestHost?: string) {
  if (!origin) return true;
  const explicitOrigins = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return explicitOrigins.includes(origin) || sameHostOrLocalDev(origin, requestHost);
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:;"
  );
  next();
}

function requireTrustedOrigin(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || isAllowedOrigin(req.headers.origin, req.headers.host)) return next();
  res.status(403).json({ message: "Request origin is not allowed" });
}

function clientIpFromRequest(req: Request) {
  return String(req.ip || req.socket.remoteAddress || "unknown");
}

function consumeRateLimit(key: string, windowMs: number, max: number) {
  const now = Date.now();
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { resetAt: now + windowMs, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function createRateLimit(scope: string, windowMs: number, max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${scope}:${clientIpFromRequest(req)}`;
    if (consumeRateLimit(key, windowMs, max)) return next();
    res.status(429).json({ message: "Too many requests, please try again later" });
  };
}

function cleanText(value: unknown, max: number) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function safeUploadUrl(value: unknown) {
  const text = String(value || "");
  return /^\/uploads\/(?:proofs|admin)\/[0-9a-z-]+\.(?:jpg|png|webp)$/i.test(text) ? text : undefined;
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype));
  }
});

// 图片证明走 HTTP 上传，比 Socket.IO 更适合处理文件。
app.post("/api/proof-image", createRateLimit("proof-image", 60_000, 20), (req, res) => {
  imageUpload.single("image")(req, res, (error) => {
    if (error) return res.status(400).json({ message: "图片上传失败，请确认格式为 jpg/png/webp 且小于 8MB" });
    const token = String(req.body.token || "");
    const session = verifySessionToken(token);
    const playerId = session ? tokenToPlayerId.get(token) : undefined;
    const player = playerId ? players.get(playerId) : undefined;
    if (!session || !player || sidToPlayerId.get(session.sid) !== player.id) {
      securityLog("upload_denied", { sid: session?.sid, ip: clientIpFromRequest(req), event: "proof-image", userAgent: req.headers["user-agent"] });
      return res.status(403).json({ message: "Invalid session" });
    }
    if (!player?.connected) return res.status(403).json({ message: "请先进入游戏后再上传证明" });
    if (!req.file) return res.status(400).json({ message: "图片格式不支持或图片为空" });
    try {
      res.json({ imageUrl: saveVerifiedImage(req.file, "proofs") });
    } catch {
      res.status(400).json({ message: "图片真实格式不正确，请上传 jpg/png/webp" });
    }
  });
});

app.post("/api/admin-image", createRateLimit("admin-image", 60_000, 12), (req, res) => {
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

app.get("/api/config/export", (req, res) => {
  if (!adminPasswordMatches(req.query.password)) return res.status(403).json({ message: "Admin password is required" });
  res.type("application/json").send(exportConfigText());
});

if (fs.existsSync(path.join(rootDir, "dist"))) {
  app.use(express.static(path.join(rootDir, "dist"), {
    index: false,
    maxAge: "1y",
    immutable: true
  }));
  app.use((_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(rootDir, "dist", "index.html"));
  });
}

app.use((error: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  securityLog("http_error", { ip: clientIpFromRequest(req), path: req.path, message: error.message, userAgent: req.headers["user-agent"] });
  res.status(500).json(isProduction ? { message: "Internal server error" } : { message: error.message, stack: error.stack });
});

function randomId() {
  return crypto.randomBytes(6).toString("base64url");
}

function roomCode() {
  let code = "";
  do {
    code = `DM-${crypto.randomBytes(3).toString("hex").slice(0, 4).toUpperCase()}`;
  } while ([...rooms.values()].some((room) => room.code === code));
  return code;
}

function socketIp(socket: { handshake: { headers: Record<string, string | string[] | undefined>; address: string } }) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(raw?.split(",")[0] || socket.handshake.address || "unknown").trim();
}

function socketAuthError(code: string, message: string) {
  const err = new Error(message) as Error & { data?: { code: string } };
  err.data = { code };
  return err;
}

function tokenLooksExpired(token: string) {
  const exp = Number(token.split(".")[1]);
  return Number.isFinite(exp) && exp <= Date.now();
}

io.use((socket, next) => {
  const token = String(socket.handshake.auth?.token || socket.handshake.query?.token || "");
  const session = verifySessionToken(token);
  const ipAddress = socketIp(socket);
  const userAgent = socket.handshake.headers["user-agent"];

  if (!isAllowedOrigin(socket.handshake.headers.origin, socket.handshake.headers.host)) {
    securityLog("socket_origin_blocked", { ip: ipAddress, origin: socket.handshake.headers.origin, userAgent });
    return next(new Error("origin not allowed"));
  }

  if (!token) {
    securityLog("socket_auth_failed", { ip: ipAddress, userAgent, reason: "missing" });
    return next(socketAuthError("SESSION_MISSING", "Session token missing"));
  }

  if (!session) {
    const expired = tokenLooksExpired(token);
    securityLog("socket_auth_failed", { ip: ipAddress, userAgent, reason: expired ? "expired" : "invalid" });
    return next(socketAuthError(expired ? "SESSION_EXPIRED" : "SESSION_INVALID", expired ? "Session expired" : "Session invalid"));
  }

  const socketsForIp = socketIdsByIp.get(ipAddress) || new Set<string>();
  if (!socketsForIp.has(socket.id) && socketsForIp.size >= maxSocketsPerIp) {
    securityLog("socket_ip_limited", { sid: session.sid, ip: ipAddress, userAgent });
    return next(new Error("Too many connections"));
  }

  const previousSocketId = sidToSocketId.get(session.sid);
  if (previousSocketId && previousSocketId !== socket.id) {
    securityLog("socket_duplicate", { sid: session.sid, ip: ipAddress, oldSocketId: previousSocketId, userAgent });
    io.sockets.sockets.get(previousSocketId)?.disconnect(true);
  }

  socket.data.sid = session.sid;
  socket.data.token = token;
  socket.data.sessionExpiresAt = session.exp;
  socket.data.ipAddress = ipAddress;
  sidToSocketId.set(session.sid, socket.id);
  socketIdToSid.set(socket.id, session.sid);
  socketsForIp.add(socket.id);
  socketIdsByIp.set(ipAddress, socketsForIp);
  securityLog("socket_connected", { sid: session.sid, ip: ipAddress, socketId: socket.id, userAgent });
  next();
});

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

function currentExtremeDecayHour(now = Date.now()) {
  return Math.floor(now / 3_600_000);
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
  broadcastPlayerUpdate(player);
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
  if (!player.othelloStats) player.othelloStats = freshOthelloStats();
  const {
    socketId: _socketId,
    token: _token,
    ipAddress: _ipAddress,
    disconnectGraceTimer: _graceTimer,
    disconnectTimer: _timer,
    recentMoves: _moves,
    playerId: _playerId,
    playerSecretHash: _secretHash,
    persistent: _persistent,
    currentSid: _currentSid,
    createdAt: _createdAt,
    lastSeenAt: _lastSeenAt,
    ...rest
  } = player;
  return rest;
}

function broadcastPlayerUpdate(player: PlayerState) {
  io.volatile.emit("player:update", publicPlayer(player));
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

function roomSnapshot(room: RoomState, options: { includeChat?: boolean; includeHistory?: boolean } = {}): RoomSnapshot {
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
    settings: publicRoomSettings(room.settings),
    roundHistory: options.includeHistory === false ? [] : room.roundHistory.slice(0, roomHistoryPageSize),
    roundHistoryTotal: room.roundHistory.length,
    spectators,
    choices: hideOpponentChoices(room),
    othello: room.othello,
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

function publicRoomSettings(settings: RoomSettings): RoomSettings {
  const { password: _password, ...publicSettings } = settings;
  return publicSettings;
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
    if (room.settings.enableRanked && room.settings.tieDoublePunish) return `平局双扣 -${effectiveRankedStake(room.settings)}`;
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
  clearOthelloSettlementTimer(room.id);
  clearRoomBroadcastTimer(room.id);
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

function lobbySnapshot(options: { includeConfig?: boolean; includeSuggestions?: boolean } = {}) {
  for (const player of players.values()) {
    refreshGiveawayBoard(player);
    if (refreshNameWarState(player)) refreshPlayerSnapshots(player);
  }
  const humanPlayers = [...players.values()].map(publicPlayer);
  return {
    ...(options.includeConfig ? { config: publicConfig() } : {}),
    onlineCount: [...players.values()].filter((player) => player.connected).length,
    players: humanPlayers,
    rooms: [...rooms.values()].map((room) => ({
      id: room.id,
      gameId: room.settings.gameId,
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
      stake: room.settings.stake,
      enableRankMultiplier: room.settings.enableRankMultiplier,
      rankMultiplier: rankMultiplierFor(room.settings),
      enableExtremeRanked: room.settings.enableExtremeRanked,
      tags: room.settings.enableTags ? room.settings.tags || [] : []
    })),
    normalLeaderboard: [],
    rankedLeaderboard: [],
    suggestions: options.includeSuggestions === false ? [] : suggestions.slice(0, 50),
    lobbyChat: [],
    serverStats: { ...serverStats }
  };
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
  io.to(lobbyChannel).volatile.emit("lobby:update", snapshot);
}

function broadcastLobby() {
  if (lobbyBroadcastTimer) return;
  lobbyBroadcastTimer = setTimeout(emitLobbyUpdate, lobbyBroadcastDelayMs);
}

function emitRoomUpdate(roomId: string) {
  const pending = roomBroadcastTimers.get(roomId);
  roomBroadcastTimers.delete(roomId);
  const room = rooms.get(roomId);
  if (!room) return;
  // 每次广播房间状态都打一个时间戳，前端可以用它丢掉过期快照。
  // 这样聊天、审核、提交证明同时发生时，不容易被旧状态覆盖。
  room.updatedAt = Date.now();
  const snapshot = roomSnapshot(room, { includeChat: false, includeHistory: false });
  serverStats.roomBroadcasts += 1;
  serverStats.lastRoomSnapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  recordBroadcast("room", serverStats.lastRoomSnapshotBytes);
  io.to(roomId).volatile.emit("room:update", snapshot);
  if (pending?.updateLobby) broadcastLobby();
}

function broadcastRoom(roomId: string, updateLobby = false) {
  const pending = roomBroadcastTimers.get(roomId);
  if (pending) {
    pending.updateLobby ||= updateLobby;
    return;
  }
  const timer = setTimeout(() => emitRoomUpdate(roomId), roomBroadcastDelayMs);
  roomBroadcastTimers.set(roomId, { timer, updateLobby });
}

function clearRoomBroadcastTimer(roomId: string) {
  const pending = roomBroadcastTimers.get(roomId);
  if (!pending) return;
  clearTimeout(pending.timer);
  roomBroadcastTimers.delete(roomId);
}

function appendRoomChat(room: RoomState, message: ChatMessage) {
  room.chat.push(message);
  if (room.chat.length > maxRoomChatMessages) room.chat.splice(0, room.chat.length - maxRoomChatMessages);
}

function appendLobbyChat(message: ChatMessage) {
  lobbyChat.push(message);
  if (lobbyChat.length > maxLobbyMessages) lobbyChat.splice(0, lobbyChat.length - maxLobbyMessages);
}

function emitLobbyChatAppend(message: ChatMessage) {
  io.to(lobbyChannel).emit("chat:append", message);
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
    emitLobbyChatAppend(message);
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

function canUseBattleSeat(room: RoomState, player: PlayerState) {
  if (!room.settings.enableRanked) return true;
  return Boolean(player.extremeModeEnabled) === Boolean(room.settings.enableExtremeRanked);
}

function rankedSeatRestrictionText(room: RoomState, player: PlayerState) {
  if (!room.settings.enableRanked || canUseBattleSeat(room, player)) return "";
  return room.settings.enableExtremeRanked
    ? "非极限模式玩家只能观战极限排位房"
    : "极限模式玩家只能观战普通排位房";
}

function canAutoSeatOnJoin(room: RoomState, player: PlayerState) {
  if (!canUseBattleSeat(room, player)) return false;
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

function createPlayer(name: string, genderId: string, token: string, identity?: { playerId?: string; playerSecret?: string }): PlayerState {
  const session = verifySessionToken(token);
  const persistent = Boolean(identity?.playerId && identity?.playerSecret);
  // 持久玩家用独立的 publicId 作为 player.id（对外展示/座位/索引），
  // 不直接复用 sid，也不复用客户端的 playerId（playerId 不广播）。
  const id = persistent ? generatePublicId() : (session?.sid || randomId());
  const gender = genderInfo(genderId);
  const titleSegment = titleSegmentFor(0);
  const title = randomTitleFromSegment(titleSegment, gender.factionId);
  const now = Date.now();
  const player: PlayerState = {
    id,
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
    giveawayVoteLikesThisHour: 0,
    giveawayVoteDislikesThisHour: 0,
    rankMultiplierUnlocked: false,
    extremeModeEnabled: false,
    extremeWinStreak: 0,
    extremeLastDecayHour: currentExtremeDecayHour(),
    extremeForceClosed: false,
    token: token || randomId(),
    stats: { wins: 0, losses: 0, draws: 0, punishments: 0, rankedPoints: 0, title, titleSegmentId: titleSegment?.id },
    othelloStats: freshOthelloStats(),
    recentMoves: [],
    persistent,
    playerId: identity?.playerId,
    playerSecretHash: persistent ? hashSecret(String(identity?.playerSecret)) : undefined,
    currentSid: session?.sid,
    createdAt: now,
    lastSeenAt: now
  };
  players.set(player.id, player);
  tokenToPlayerId.set(player.token, player.id);
  if (player.playerId) playerIdToId.set(player.playerId, player.id);
  if (session?.sid) sidToPlayerId.set(session.sid, player.id);
  if (persistent) requestPersist("lazy");
  return player;
}

function hashSecret(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function generatePublicId() {
  return crypto.randomBytes(9).toString("base64url");
}

// ------- players.json 轻量持久化（不等同数据库事务）-------
function serializePlayers() {
  return [...players.values()]
    .filter((p) => p.persistent && p.playerId && p.playerSecretHash)
    .map((p) => ({
      id: p.id,
      playerId: p.playerId,
      playerSecretHash: p.playerSecretHash,
      name: p.name,
      genderId: p.genderId,
      nameWarEnabled: p.nameWarEnabled,
      nameWarAllowRename: p.nameWarAllowRename,
      nameWarToggledAt: p.nameWarToggledAt,
      nameWarOriginalName: p.nameWarOriginalName,
      nameWarPenaltyName: p.nameWarPenaltyName,
      nameWarPunished: p.nameWarPunished,
      nameWarRenameProtectedUntil: p.nameWarRenameProtectedUntil,
      nameWarRenamedBy: p.nameWarRenamedBy,
      nameWarRenamedByName: p.nameWarRenamedByName,
      nameWarRenameWindowStartedAt: p.nameWarRenameWindowStartedAt,
      nameWarRenameCount: p.nameWarRenameCount,
      giveawayEnabled: p.giveawayEnabled,
      giveawayValue: p.giveawayValue,
      giveawayClicks: p.giveawayClicks,
      rankMultiplierUnlocked: p.rankMultiplierUnlocked,
      extremeModeEnabled: p.extremeModeEnabled,
      extremeModeToggledAt: p.extremeModeToggledAt,
      extremeModeCooldownUntil: p.extremeModeCooldownUntil,
      extremeWinStreak: p.extremeWinStreak,
      extremeLastDecayHour: p.extremeLastDecayHour,
      stats: p.stats,
      othelloStats: p.othelloStats,
      createdAt: p.createdAt,
      lastSeenAt: p.lastSeenAt
    }));
}

async function loadPlayersFromDisk() {
  try {
    if (!fs.existsSync(playersFile)) return;
    const raw = await fsp.readFile(playersFile, "utf-8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error("players.json is not an array");
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (!item.id || !item.playerId || !item.playerSecretHash) continue;
      if (players.has(String(item.id)) || playerIdToId.has(String(item.playerId))) continue;
      const gender = genderInfo(String(item.genderId || "male"));
      const stats = item.stats && typeof item.stats === "object" ? item.stats : undefined;
      const player: PlayerState = {
        id: String(item.id),
        name: String(item.name || "玩家"),
        genderId: gender.genderId,
        genderLabel: gender.genderLabel,
        factionId: gender.factionId,
        factionLabel: gender.factionLabel,
        factionColors: gender.factionColors,
        displayName: "",
        connected: false,
        nameWarOriginalName: item.nameWarOriginalName || item.name,
        nameWarEnabled: item.nameWarEnabled,
        nameWarAllowRename: item.nameWarAllowRename,
        nameWarToggledAt: item.nameWarToggledAt,
        nameWarPenaltyName: item.nameWarPenaltyName,
        nameWarPunished: item.nameWarPunished,
        nameWarRenameProtectedUntil: item.nameWarRenameProtectedUntil,
        nameWarRenamedBy: item.nameWarRenamedBy,
        nameWarRenamedByName: item.nameWarRenamedByName,
        nameWarRenameWindowStartedAt: item.nameWarRenameWindowStartedAt,
        nameWarRenameCount: item.nameWarRenameCount,
        giveawayEnabled: item.giveawayEnabled,
        giveawayValue: item.giveawayValue || 0,
        giveawayClicks: item.giveawayClicks || 0,
        giveawayBoardLikes: 0,
        giveawayBoardDislikes: 0,
        giveawayVoteLikesThisHour: 0,
        giveawayVoteDislikesThisHour: 0,
        rankMultiplierUnlocked: item.rankMultiplierUnlocked,
        extremeModeEnabled: item.extremeModeEnabled,
        extremeModeToggledAt: item.extremeModeToggledAt,
        extremeModeCooldownUntil: item.extremeModeCooldownUntil,
        extremeWinStreak: item.extremeWinStreak || 0,
        extremeLastDecayHour: typeof item.extremeLastDecayHour === "number" ? item.extremeLastDecayHour : currentExtremeDecayHour(),
        token: randomId(),
        stats: {
          wins: stats?.wins || 0,
          losses: stats?.losses || 0,
          draws: stats?.draws || 0,
          punishments: stats?.punishments || 0,
          rankedPoints: typeof stats?.rankedPoints === "number" ? stats.rankedPoints : 0,
          title: stats?.title || randomTitleFromSegment(titleSegmentFor(0), gender.factionId),
          titleSegmentId: stats?.titleSegmentId
        },
        othelloStats: item.othelloStats && typeof item.othelloStats === "object" ? { ...freshOthelloStats(), ...item.othelloStats } : freshOthelloStats(),
        recentMoves: [],
        persistent: true,
        playerId: String(item.playerId),
        playerSecretHash: String(item.playerSecretHash),
        createdAt: item.createdAt || Date.now(),
        lastSeenAt: item.lastSeenAt || Date.now()
      };
      player.displayName = formatDisplayName(player);
      players.set(player.id, player);
      playerIdToId.set(player.playerId!, player.id);
      tokenToPlayerId.set(player.token, player.id);
    }
    console.log(`[players] loaded ${players.size} players`);
  } catch (err) {
    console.error("[players] load failed:", err);
  }
}

let persistQueue: Promise<void> = Promise.resolve();
let persistScheduled = false;
let immediateScheduled = false;
let persistDirty = false;

function writeSnapshot() {
  const snapshot = serializePlayers();
  persistQueue = persistQueue
    .then(async () => {
      const tmp = `${playersFile}.tmp`;
      const data = JSON.stringify(snapshot, null, 2);
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.writeFile(tmp, data, "utf-8");
      await fsp.rename(tmp, playersFile);
    })
    .catch((err) => {
      persistDirty = true;
      console.error("[players] persist failed:", err);
    });
  return persistQueue;
}

function requestPersist(mode: "lazy" | "important" = "lazy") {
  persistDirty = true;
  if (mode === "important") {
    if (immediateScheduled) return;
    immediateScheduled = true;
    setImmediate(() => {
      immediateScheduled = false;
      if (persistDirty) {
        persistDirty = false;
        void writeSnapshot();
      }
    });
    return;
  }
  if (persistScheduled) return;
  persistScheduled = true;
  setTimeout(() => {
    persistScheduled = false;
    if (persistDirty) {
      persistDirty = false;
      void writeSnapshot();
    }
  }, 3000);
}

async function flushPersist() {
  if (persistDirty) {
    persistDirty = false;
    await writeSnapshot();
  }
  await persistQueue;
}

function applyRanked(winner: PlayerState | undefined, loser: PlayerState | undefined, stake: RankStake) {
  if (winner) updateRankedPoints(winner, stake);
  if (loser) updateRankedPoints(loser, -stake);
}

function applyRankedDrawPenalty(playerA: PlayerState | undefined, playerB: PlayerState | undefined, stake: RankStake) {
  if (playerA) updateRankedPoints(playerA, -stake);
  if (playerB) updateRankedPoints(playerB, -stake);
}

function rankMultiplierFor(settings: RoomSettings): RankMultiplier {
  if (!settings.enableRanked || !settings.enableRankMultiplier) return 1;
  return ([2, 5, 10] as RankMultiplier[]).includes(settings.rankMultiplier as RankMultiplier)
    ? settings.rankMultiplier as RankMultiplier
    : 1;
}

function effectiveRankedStake(settings: RoomSettings) {
  return settings.stake * rankMultiplierFor(settings);
}

function extremeSegmentId(points: number) {
  if (points >= 750) return "pos4";
  if (points >= 500) return "pos3";
  if (points >= 250) return "pos2";
  if (points >= 1) return "pos1";
  if (points <= -750) return "neg4";
  if (points <= -500) return "neg3";
  if (points <= -250) return "neg2";
  if (points <= -1) return "neg1";
  return "pos0";
}

function adjustedRankedDelta(player: PlayerState | undefined, delta: number) {
  if (!player || !player.extremeModeEnabled || delta === 0) return Math.round(delta);
  const segment = extremeSegmentId(player.stats.rankedPoints);
  if (delta < 0 && player.stats.rankedPoints > 0) {
    const rate = config.extremeMode.positiveLossRates[segment] ?? 1;
    return -Math.round(Math.abs(delta) * rate);
  }
  if (delta > 0 && player.stats.rankedPoints < 0) {
    const rate = config.extremeMode.negativeWinRates[segment] ?? (segment === "neg4" ? 0.5 : 1);
    return Math.round(delta * rate);
  }
  return Math.round(delta);
}

function applyRankedStake(winner: PlayerState | undefined, loser: PlayerState | undefined, stake: number) {
  const winnerDelta = adjustedRankedDelta(winner, stake);
  const loserDelta = adjustedRankedDelta(loser, -stake);
  if (winner) updateRankedPoints(winner, winnerDelta);
  if (loser) updateRankedPoints(loser, loserDelta);
  return { winnerDelta, loserDelta };
}

function applyRankedDrawPenaltyStake(playerA: PlayerState | undefined, playerB: PlayerState | undefined, stake: number) {
  const deltaA = adjustedRankedDelta(playerA, -stake);
  const deltaB = adjustedRankedDelta(playerB, -stake);
  if (playerA) updateRankedPoints(playerA, deltaA);
  if (playerB) updateRankedPoints(playerB, deltaB);
  return { deltaA, deltaB };
}

function createDisconnectForfeit(room: RoomState, player: PlayerState) {
  if (room.phase !== "choosing") return;
  if (room.settings.gameId === "rps" && !room.settings.enableRanked) return;
  if (room.settings.gameId === "othello" && !room.othello) return;
  if (room.settings.gameId === "tictactoe" && !room.tictactoe) return;
  const loserSeat = seatOf(room, player.id);
  if (!loserSeat) return;
  const winnerSeat = loserSeat === "A" ? "B" : "A";
  const winner = room.seats[winnerSeat];
  if (!winner || "isBot" in winner) return;
  const stake = room.settings.gameId === "othello" ? 0 : effectiveRankedStake(room.settings);
  room.disconnectForfeits.set(player.id, {
    loserId: player.id,
    loserSeat,
    loserName: playerShortName(player),
    winnerId: winner.id,
    winnerSeat,
    winnerName: occupantName(winner),
    stake,
    baseStake: room.settings.stake,
    rankMultiplier: rankMultiplierFor(room.settings)
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
  if (room.settings.gameId === "othello") return applyOthelloDisconnectForfeit(room, forfeit);
  if (room.settings.gameId === "tictactoe") return applyTicTacToeDisconnectForfeit(room, forfeit);
  const winner = players.get(forfeit.winnerId);
  const loser = players.get(forfeit.loserId);
  const rankedResult = applyRankedStake(winner, loser, forfeit.stake);
  if (winner) {
    winner.stats.wins += 1;
  }
  if (loser) {
    loser.stats.losses += 1;
  }
  resetExtremeWinStreak(loser);
  const streakText = applyExtremeWinStreakRisk(room, winner);
  room.score[forfeit.winnerSeat] += 1;
  room.seatedScore[forfeit.winnerSeat] += 1;
  room.seatStats[forfeit.winnerSeat].wins += 1;
  room.seatStats[forfeit.loserSeat].losses += 1;
  room.phase = "result";
  room.status = "playing";
  room.revealedChoices = undefined;
  const stakeText = forfeit.rankMultiplier > 1 ? `${forfeit.baseStake} 分 ×${forfeit.rankMultiplier} = ${forfeit.stake} 分` : `${forfeit.stake} 分`;
  room.resultText = `${forfeit.loserName} 断线超时判负，${forfeit.winnerName}胜利，排位 ${stakeText} 已结算（${forfeit.winnerName} ${rankedResult.winnerDelta >= 0 ? "+" : ""}${rankedResult.winnerDelta}，${forfeit.loserName} ${rankedResult.loserDelta}）${streakText}`;
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
    stake: forfeit.baseStake,
    rankMultiplier: forfeit.rankMultiplier,
    effectiveStake: forfeit.stake,
    extremeRanked: Boolean(room.settings.enableExtremeRanked),
    punishmentTasks: [],
    punishedNames: [],
    proofs: []
  });
  roomNotice(room, room.resultText);
  return true;
}

function applyTicTacToeDisconnectForfeit(room: RoomState, forfeit: DisconnectForfeit) {
  if (room.phase === "result" || room.tictactoe?.ended) return true;
  const winner = players.get(forfeit.winnerId);
  const loser = players.get(forfeit.loserId);
  const rankedDelta = room.tictactoe?.rankedDelta || { A: 0, B: 0 };
  let rankedText = "";
  let streakText = "";
  if (room.settings.enableRanked) {
    const rankedResult = applyRankedStake(winner, loser, forfeit.stake);
    rankedDelta[forfeit.winnerSeat] += rankedResult.winnerDelta;
    rankedDelta[forfeit.loserSeat] += rankedResult.loserDelta;
    resetExtremeWinStreak(loser);
    streakText = applyExtremeWinStreakRisk(room, winner);
    rankedText = `，排位 ${forfeit.stake} 分已结算（${forfeit.winnerName} ${rankedResult.winnerDelta >= 0 ? "+" : ""}${rankedResult.winnerDelta}，${forfeit.loserName} ${rankedResult.loserDelta}）`;
  }
  if (winner) winner.stats.wins += 1;
  if (loser) loser.stats.losses += 1;
  room.score[forfeit.winnerSeat] += 1;
  room.seatedScore[forfeit.winnerSeat] += 1;
  room.seatStats[forfeit.winnerSeat].wins += 1;
  room.seatStats[forfeit.loserSeat].losses += 1;
  room.phase = "result";
  room.status = "playing";
  room.tictactoe = room.tictactoe ? {
    ...room.tictactoe,
    rankedDelta,
    ended: true,
    winner: forfeit.winnerSeat
  } : undefined;
  room.resultText = `${forfeit.loserName} 断线超时判负，${forfeit.winnerName} 井字棋胜利${rankedText}${streakText}`;
  const punishedPlayers = punishmentPlayersForResult(room, forfeit.winnerSeat);
  const punishedNames = punishedPlayers.map((player) => playerShortName(player));
  const punishment = currentPunishment(room);
  const punishmentTasks = buildPunishmentTasks(room, punishedPlayers, forfeit.winnerSeat, punishment);
  if (winner) refreshPlayerSnapshots(winner);
  if (loser) refreshPlayerSnapshots(loser);
  addRoundHistory(room, {
    id: randomId(),
    round: room.roundHistory.length + 1,
    at: Date.now(),
    playerA: forfeit.loserSeat === "A" ? forfeit.loserName : forfeit.winnerName,
    playerB: forfeit.loserSeat === "B" ? forfeit.loserName : forfeit.winnerName,
    moveA: forfeit.loserSeat === "A" ? "forfeit" : "noMove",
    moveB: forfeit.loserSeat === "B" ? "forfeit" : "noMove",
    result: forfeit.winnerSeat,
    resultLabel: `${forfeit.winnerName}胜利`,
    resultText: `${room.resultText}（断线判负）`,
    gameId: "tictactoe",
    tictactoeXSeat: room.tictactoe?.xSeat,
    ranked: room.settings.enableRanked,
    stake: room.settings.enableRanked ? forfeit.baseStake : undefined,
    rankMultiplier: room.settings.enableRanked ? forfeit.rankMultiplier : undefined,
    effectiveStake: room.settings.enableRanked ? forfeit.stake : undefined,
    extremeRanked: Boolean(room.settings.enableExtremeRanked),
    punishmentName: punishedNames.length ? punishmentNameForRoom(room, punishment) : undefined,
    punishmentDescription: punishedNames.length && room.settings.punishmentSource !== "player" ? punishment?.description : undefined,
    punishmentTasks,
    punishedNames,
    proofs: []
  });
  roomNotice(room, room.resultText);
  setupPunishmentOrNext(room, forfeit.winnerSeat);
  return true;
}

function applyOthelloDisconnectForfeit(room: RoomState, forfeit: DisconnectForfeit) {
  flushOthelloPendingSettlement(room);
  if (room.phase === "result" || room.othello?.ended) return true;
  const winner = players.get(forfeit.winnerId);
  const loser = players.get(forfeit.loserId);
  const counts = room.othello ? othelloCounts(room.othello.board) : { blackCount: 0, whiteCount: 0 };
  if (winner) winner.stats.wins += 1;
  if (loser) loser.stats.losses += 1;
  const rankedFloorText = applyOthelloForfeitRankedFloor(room, forfeit.winnerSeat, forfeit.loserSeat);
  const fullForfeitText = applyOthelloEscapeRankedPenalty(room, forfeit.winnerSeat, forfeit.loserSeat, 1, "断线全输");
  const rankedDelta = room.othello?.rankedDelta || { A: 0, B: 0 };
  const punishedPlayers = punishmentPlayersForResult(room, forfeit.winnerSeat);
  const punishedNames = punishedPlayers.map((player) => playerShortName(player));
  const punishment = currentPunishment(room);
  const punishmentTasks = buildPunishmentTasks(room, punishedPlayers, forfeit.winnerSeat, punishment);
  addOthelloOutcomeStats(
    forfeit.winnerSeat === "A" ? winner : loser,
    forfeit.winnerSeat === "B" ? winner : loser,
    forfeit.winnerSeat
  );
  resetExtremeWinStreak(loser);
  const streakText = room.settings.enableRanked ? applyExtremeWinStreakRisk(room, winner) : "";
  room.score[forfeit.winnerSeat] += 1;
  room.seatedScore[forfeit.winnerSeat] += 1;
  room.seatStats[forfeit.winnerSeat].wins += 1;
  room.seatStats[forfeit.loserSeat].losses += 1;
  room.phase = "result";
  room.status = "playing";
  room.othello = room.othello ? {
    ...room.othello,
    ...counts,
    ended: true,
    winner: forfeit.winnerSeat,
    legalMoves: [],
    surrenderRequest: undefined
  } : undefined;
  room.resultText = `${forfeit.loserName} 断线超时判负，${forfeit.winnerName}胜利（黑 ${counts.blackCount}，白 ${counts.whiteCount}；实时结算：${othelloRankedText(room.othello)}${rankedFloorText}${fullForfeitText}）${streakText}${othelloSettlementSummary(room.othello)}`;
  if (winner) refreshPlayerSnapshots(winner);
  if (loser) refreshPlayerSnapshots(loser);
  addRoundHistory(room, {
    id: randomId(),
    round: room.roundHistory.length + 1,
    at: Date.now(),
    playerA: forfeit.loserSeat === "A" ? forfeit.loserName : forfeit.winnerName,
    playerB: forfeit.loserSeat === "B" ? forfeit.loserName : forfeit.winnerName,
    moveA: forfeit.loserSeat === "A" ? "forfeit" : "noMove",
    moveB: forfeit.loserSeat === "B" ? "forfeit" : "noMove",
    result: forfeit.winnerSeat,
    resultLabel: `${forfeit.winnerName}胜利`,
    resultText: `${room.resultText}（断线判负）`,
    gameId: "othello",
    othelloScore: { black: counts.blackCount, white: counts.whiteCount },
    othelloBlackSeat: room.othello?.blackSeat,
    ranked: room.settings.enableRanked,
    stake: room.settings.enableRanked ? forfeit.baseStake : undefined,
    rankMultiplier: room.settings.enableRanked ? forfeit.rankMultiplier : undefined,
    effectiveStake: room.settings.enableRanked ? Math.max(Math.abs(rankedDelta.A), Math.abs(rankedDelta.B)) : undefined,
    extremeRanked: Boolean(room.settings.enableExtremeRanked),
    punishmentName: punishedNames.length ? punishmentNameForRoom(room, punishment) : undefined,
    punishmentDescription: punishedNames.length && room.settings.punishmentSource !== "player" ? punishment?.description : undefined,
    punishmentTasks,
    punishedNames,
    proofs: []
  });
  roomNotice(room, room.resultText);
  setupPunishmentOrNext(room, forfeit.winnerSeat);
  return true;
}

function updateRankedPoints(player: PlayerState, delta: number) {
  const minPoints = player.nameWarEnabled ? -1999 : -999;
  player.stats.rankedPoints = clamp(player.stats.rankedPoints + delta, minPoints, 999);
  refreshNameWarState(player);
  refreshPlayerSnapshots(player);
  broadcastPlayerUpdate(player);
  if (player.persistent) requestPersist("important");
}

function setRankedPointsByAdmin(player: PlayerState, points: number) {
  const minPoints = player.nameWarEnabled ? -1999 : -999;
  player.stats.rankedPoints = clamp(Math.round(points), minPoints, 999);
  refreshNameWarState(player);
  if (player.persistent) requestPersist("important");
}

function extremeHourlyDecayAmount(player: PlayerState) {
  const segment = extremeSegmentId(player.stats.rankedPoints);
  const amount = config.extremeMode.hourlyDecay[segment] ?? config.extremeMode.hourlyDecay.default ?? 2;
  return Math.max(0, Math.round(amount));
}

function applyExtremeHourlyDecay(now = Date.now()) {
  const hour = currentExtremeDecayHour(now);
  const changedRoomIds = new Set<string>();
  let changed = false;
  for (const player of players.values()) {
    if (!player.extremeModeEnabled) continue;
    if (player.extremeLastDecayHour === hour) continue;
    player.extremeLastDecayHour = hour;
    const amount = extremeHourlyDecayAmount(player);
    if (amount <= 0) continue;
    updateRankedPoints(player, -amount);
    changed = true;
    if (player.roomId) changedRoomIds.add(player.roomId);
  }
  if (!changed) return;
  for (const roomId of changedRoomIds) broadcastRoom(roomId);
}

function scheduleExtremeHourlyDecay() {
  const now = Date.now();
  const nextHour = (currentExtremeDecayHour(now) + 1) * 3_600_000;
  setTimeout(() => {
    applyExtremeHourlyDecay();
    setInterval(() => applyExtremeHourlyDecay(), 3_600_000);
  }, Math.max(1_000, nextHour - now + 500));
}

function resetExtremeWinStreak(player: PlayerState | undefined) {
  if (player?.extremeModeEnabled) player.extremeWinStreak = 0;
}

function applyExtremeWinStreakRisk(room: RoomState, winner: PlayerState | undefined) {
  if (!winner?.extremeModeEnabled || !room.settings.enableRanked) return "";
  winner.extremeWinStreak = (winner.extremeWinStreak || 0) + 1;
  const threshold = config.extremeMode.winStreakThreshold;
  if (winner.extremeWinStreak < threshold) return "";
  if (Math.random() >= config.extremeMode.winStreakCrashChance) return "";
  const penalty = Math.max(1, Math.round(config.extremeMode.crashTargetPoints));
  updateRankedPoints(winner, -penalty);
  refreshPlayerSnapshots(winner);
  return `；${playerShortName(winner)} 极限连胜触发风险，额外扣 ${penalty} 分`;
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

const othelloDirections = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1]
] as const;

function initialOthelloBoard(): OthelloCell[][] {
  const board: OthelloCell[][] = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
  board[3][3] = "white";
  board[3][4] = "black";
  board[4][3] = "black";
  board[4][4] = "white";
  return board;
}

function randomSeat(): SeatKey {
  return Math.random() < 0.5 ? "A" : "B";
}

function oppositeSeat(seat: SeatKey): SeatKey {
  return seat === "A" ? "B" : "A";
}

function othelloColorForSeat(state: OthelloState, seat: SeatKey) {
  return state.blackSeat === seat ? "black" : "white";
}

function oppositeOthelloColor(color: Exclude<OthelloCell, null>) {
  return color === "black" ? "white" : "black";
}

function othelloSeatForColor(state: OthelloState, color: Exclude<OthelloCell, null>): SeatKey {
  return color === "black" ? state.blackSeat : oppositeSeat(state.blackSeat);
}

function inOthelloBoard(row: number, col: number) {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function othelloFlips(board: OthelloCell[][], row: number, col: number, color: Exclude<OthelloCell, null>) {
  if (!inOthelloBoard(row, col) || board[row][col]) return [];
  const opponent = oppositeOthelloColor(color);
  const flips: Array<{ row: number; col: number }> = [];
  for (const [dr, dc] of othelloDirections) {
    const line: Array<{ row: number; col: number }> = [];
    let r = row + dr;
    let c = col + dc;
    while (inOthelloBoard(r, c) && board[r][c] === opponent) {
      line.push({ row: r, col: c });
      r += dr;
      c += dc;
    }
    if (line.length && inOthelloBoard(r, c) && board[r][c] === color) flips.push(...line);
  }
  return flips;
}

function othelloLegalMoves(board: OthelloCell[][], color: Exclude<OthelloCell, null>) {
  const moves: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      if (othelloFlips(board, row, col, color).length) moves.push({ row, col });
    }
  }
  return moves;
}

function othelloCounts(board: OthelloCell[][]) {
  let blackCount = 0;
  let whiteCount = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === "black") blackCount += 1;
      if (cell === "white") whiteCount += 1;
    }
  }
  return { blackCount, whiteCount };
}

function addOthelloCaptureStats(player: PlayerState | undefined, opponent: PlayerState | undefined, captured: number) {
  if (captured <= 0) return;
  if (player) {
    if (!player.othelloStats) player.othelloStats = freshOthelloStats();
    player.othelloStats.captured += captured;
  }
  if (opponent) {
    if (!opponent.othelloStats) opponent.othelloStats = freshOthelloStats();
    opponent.othelloStats.lost += captured;
  }
}

function addOthelloOutcomeStats(playerA: PlayerState | undefined, playerB: PlayerState | undefined, result: RoundResult) {
  if (playerA) {
    if (!playerA.othelloStats) playerA.othelloStats = freshOthelloStats();
    playerA.othelloStats.games += 1;
  }
  if (playerB) {
    if (!playerB.othelloStats) playerB.othelloStats = freshOthelloStats();
    playerB.othelloStats.games += 1;
  }
  if (result === "draw") {
    if (playerA) playerA.othelloStats.draws += 1;
    if (playerB) playerB.othelloStats.draws += 1;
    return;
  }
  if (result === "doubleLoss") {
    if (playerA) playerA.othelloStats.losses += 1;
    if (playerB) playerB.othelloStats.losses += 1;
    return;
  }
  const winner = result === "A" ? playerA : playerB;
  const loser = result === "A" ? playerB : playerA;
  if (winner) winner.othelloStats.wins += 1;
  if (loser) loser.othelloStats.losses += 1;
}

function othelloRankedText(state: OthelloState | undefined) {
  if (!state?.rankedDelta) return "";
  const blackDelta = state.rankedDelta[state.blackSeat] || 0;
  const whiteDelta = state.rankedDelta[oppositeSeat(state.blackSeat)] || 0;
  return `黑棋 ${blackDelta >= 0 ? "+" : ""}${blackDelta}，白棋 ${whiteDelta >= 0 ? "+" : ""}${whiteDelta}`;
}

function othelloSettlementSummary(state: OthelloState | undefined) {
  const events = state?.settlementEvents || [];
  return events.length ? `；本局白给/上贡：${events.join("；")}` : "";
}

function initialTicTacToeBoard(): TicTacToeCell[][] {
  return Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => null));
}

function freshTicTacToeState(xSeat: SeatKey = randomSeat()): TicTacToeState {
  return {
    board: initialTicTacToeBoard(),
    turn: xSeat,
    xSeat,
    moveCount: 0,
    rankedDelta: { A: 0, B: 0 }
  };
}

function tictactoeMarkForSeat(state: TicTacToeState, seat: SeatKey) {
  return state.xSeat === seat ? "X" : "O";
}

function tictactoeSeatForMark(state: TicTacToeState, mark: Exclude<TicTacToeCell, null>): SeatKey {
  return mark === "X" ? state.xSeat : oppositeSeat(state.xSeat);
}

const tictactoeLines = [
  [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }],
  [{ row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }],
  [{ row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 }],
  [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }],
  [{ row: 0, col: 1 }, { row: 1, col: 1 }, { row: 2, col: 1 }],
  [{ row: 0, col: 2 }, { row: 1, col: 2 }, { row: 2, col: 2 }],
  [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 2 }],
  [{ row: 0, col: 2 }, { row: 1, col: 1 }, { row: 2, col: 0 }]
] as const;

function tictactoeWinningLine(board: TicTacToeCell[][]) {
  for (const line of tictactoeLines) {
    const [first, second, third] = line;
    const mark = board[first.row][first.col];
    if (mark && board[second.row][second.col] === mark && board[third.row][third.col] === mark) {
      return line.map((cell) => ({ ...cell }));
    }
  }
  return undefined;
}

function tictactoeEmptyCells(board: TicTacToeCell[][]) {
  const cells: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (!board[row][col]) cells.push({ row, col });
    }
  }
  return cells;
}

function ticTacToeTurnPlayer(room: RoomState) {
  const seat = room.tictactoe?.turn;
  const occupant = seat ? room.seats[seat] : undefined;
  return occupant && !("isBot" in occupant) ? players.get(occupant.id) : undefined;
}

function resetTicTacToeRoom(room: RoomState) {
  clearTicTacToeGiveawayTimer(room.id);
  room.tictactoe = undefined;
  room.phase = "ready";
  room.status = "waiting";
  room.resultText = undefined;
  room.revealedChoices = undefined;
  room.choices = {};
  room.disconnectForfeits.clear();
  room.ready = { A: false, B: false };
}

function startTicTacToeRoom(room: RoomState) {
  if (!room.seats.A || !room.seats.B) return;
  clearTicTacToeGiveawayTimer(room.id);
  const xSeat = randomSeat();
  room.phase = "choosing";
  room.status = "playing";
  room.resultText = undefined;
  room.choices = {};
  room.revealedChoices = undefined;
  room.disconnectForfeits.clear();
  room.tictactoe = freshTicTacToeState(xSeat);
  room.ready = { A: false, B: false };
}

function scheduleTicTacToeReadyStart(room: RoomState) {
  if (room.settings.gameId !== "tictactoe") return;
  if (!room.seats.A || !room.seats.B) return;
  if (room.phase !== "ready") return;
  if (!room.ready.A || !room.ready.B) return;
  if (room.resultText === "正在随机井字棋先手...") return;
  room.resultText = "正在随机井字棋先手...";
  broadcastRoom(room.id, true);
  setTimeout(() => {
    const current = rooms.get(room.id);
    if (!current || current.settings.gameId !== "tictactoe") return;
    if (current.phase !== "ready" || !current.seats.A || !current.seats.B || !current.ready.A || !current.ready.B) return;
    startTicTacToeRoom(current);
    prepareTicTacToeGiveawayPrompt(current);
    const xSeat = current.tictactoe?.xSeat || "A";
    roomNotice(current, `随机完成：${occupantName(current.seats[xSeat])} 执 X 先手。`);
    broadcastRoom(current.id, true);
  }, 1200);
}

function tictactoeRankedText(state: TicTacToeState | undefined) {
  if (!state?.rankedDelta) return "";
  const xDelta = state.rankedDelta[state.xSeat] || 0;
  const oDelta = state.rankedDelta[oppositeSeat(state.xSeat)] || 0;
  return `X ${xDelta >= 0 ? "+" : ""}${xDelta}，O ${oDelta >= 0 ? "+" : ""}${oDelta}`;
}

function finishTicTacToeGame(room: RoomState, result: RoundResult, winningLine?: Array<{ row: number; col: number }>) {
  if (!room.tictactoe) return;
  clearTicTacToeGiveawayTimer(room.id);
  const playerA = room.seats.A && !("isBot" in room.seats.A) ? players.get(room.seats.A.id) : undefined;
  const playerB = room.seats.B && !("isBot" in room.seats.B) ? players.get(room.seats.B.id) : undefined;
  const rankedDelta = room.tictactoe.rankedDelta || { A: 0, B: 0 };
  let rankedText = "";
  let streakText = "";
  if (result === "draw") {
    if (playerA) playerA.stats.draws += 1;
    if (playerB) playerB.stats.draws += 1;
    room.seatStats.A.draws += 1;
    room.seatStats.B.draws += 1;
    if (room.settings.enableRanked && room.settings.tieDoublePunish) {
      const penalty = applyRankedDrawPenaltyStake(playerA, playerB, effectiveRankedStake(room.settings));
      rankedDelta.A += penalty.deltaA;
      rankedDelta.B += penalty.deltaB;
      rankedText = `（平局双扣：A ${penalty.deltaA}，B ${penalty.deltaB}）`;
    }
  } else if (result === "A" || result === "B") {
    const loserSeat = oppositeSeat(result);
    const winner = result === "A" ? playerA : playerB;
    const loser = loserSeat === "A" ? playerA : playerB;
    if (winner) winner.stats.wins += 1;
    if (loser) loser.stats.losses += 1;
    room.score[result] += 1;
    room.seatedScore[result] += 1;
    room.seatStats[result].wins += 1;
    room.seatStats[loserSeat].losses += 1;
    if (room.settings.enableRanked) {
      const rankedResult = applyRankedStake(winner, loser, effectiveRankedStake(room.settings));
      rankedDelta[result] += rankedResult.winnerDelta;
      rankedDelta[loserSeat] += rankedResult.loserDelta;
      resetExtremeWinStreak(loser);
      streakText = applyExtremeWinStreakRisk(room, winner);
      rankedText = `（${occupantName(room.seats[result])} ${rankedResult.winnerDelta >= 0 ? "+" : ""}${rankedResult.winnerDelta}，${occupantName(room.seats[loserSeat])} ${rankedResult.loserDelta}）`;
    }
  }
  room.tictactoe = {
    ...room.tictactoe,
    rankedDelta,
    winningLine,
    ended: true,
    winner: result
  };
  room.phase = "result";
  room.status = "playing";
  const winnerName = result === "A" || result === "B" ? occupantName(room.seats[result]) : "";
  room.resultText = result === "draw"
    ? `井字棋平局${rankedText}`
    : `${winnerName} 井字棋胜利${rankedText}${streakText}`;
  const punishedPlayers = punishmentPlayersForResult(room, result);
  const punishedNames = punishedPlayers.map((player) => playerShortName(player));
  const punishment = currentPunishment(room);
  const punishmentTasks = buildPunishmentTasks(room, punishedPlayers, result, punishment);
  if (playerA) refreshPlayerSnapshots(playerA);
  if (playerB) refreshPlayerSnapshots(playerB);
  addRoundHistory(room, {
    id: randomId(),
    round: room.roundHistory.length + 1,
    at: Date.now(),
    playerA: occupantName(room.seats.A),
    playerB: occupantName(room.seats.B),
    moveA: "noMove",
    moveB: "noMove",
    result,
    resultLabel: result === "draw" ? "井字棋平局" : `${winnerName}胜利`,
    resultText: room.resultText,
    gameId: "tictactoe",
    tictactoeXSeat: room.tictactoe.xSeat,
    tictactoeLine: winningLine,
    ranked: room.settings.enableRanked,
    stake: room.settings.enableRanked ? room.settings.stake : undefined,
    rankMultiplier: room.settings.enableRanked ? rankMultiplierFor(room.settings) : undefined,
    effectiveStake: room.settings.enableRanked ? effectiveRankedStake(room.settings) : undefined,
    extremeRanked: Boolean(room.settings.enableExtremeRanked),
    punishmentName: punishedNames.length ? punishmentNameForRoom(room, punishment) : undefined,
    punishmentDescription: punishedNames.length && room.settings.punishmentSource !== "player" ? punishment?.description : undefined,
    punishmentTasks,
    punishedNames,
    proofs: []
  });
  roomNotice(room, room.resultText);
  setupPunishmentOrNext(room, result);
}

function clearTicTacToeGiveawayTimer(roomId: string) {
  const timer = ticTacToeGiveawayTimers.get(roomId);
  if (timer) clearTimeout(timer);
  ticTacToeGiveawayTimers.delete(roomId);
}

function scheduleTicTacToeGiveawayPrompt(room: RoomState) {
  clearTicTacToeGiveawayTimer(room.id);
  const prompt = room.tictactoe?.giveawayPrompt;
  if (!prompt) return;
  const timer = setTimeout(() => {
    ticTacToeGiveawayTimers.delete(room.id);
    const current = rooms.get(room.id);
    const currentPrompt = current?.tictactoe?.giveawayPrompt;
    if (!current || !currentPrompt || currentPrompt.startedAt !== prompt.startedAt) return;
    if (!current.tictactoe || current.phase !== "choosing" || current.tictactoe.ended) return;
    if (current.tictactoe.turn !== currentPrompt.seat) return;
    if (currentPrompt.forced) {
      const forcedPlayer = ticTacToeTurnPlayer(current);
      const result = applyTicTacToeRandomMove(current, currentPrompt.seat, "forcedGiveaway");
      if (result.ok && forcedPlayer) {
        roomNotice(current, `${playerShortName(forcedPlayer)} 触发强制白给，系统随机落在第 ${result.row + 1} 行第 ${result.col + 1} 列。`);
      }
    } else {
      current.tictactoe = { ...current.tictactoe, giveawayPrompt: undefined };
      current.resultText = `${occupantName(current.seats[currentPrompt.seat])} 10 秒未选择，自动不白给。`;
    }
    broadcastRoom(current.id, true);
  }, Math.max(250, prompt.expiresAt - Date.now()));
  ticTacToeGiveawayTimers.set(room.id, timer);
}

function prepareTicTacToeGiveawayPrompt(room: RoomState) {
  if (!room.tictactoe || room.tictactoe.ended || room.phase !== "choosing") return;
  const player = ticTacToeTurnPlayer(room);
  const seat = room.tictactoe.turn;
  if (!player?.giveawayEnabled || tictactoeEmptyCells(room.tictactoe.board).length === 0) {
    clearTicTacToeGiveawayTimer(room.id);
    room.tictactoe = { ...room.tictactoe, giveawayPrompt: undefined };
    return;
  }
  const forced = shouldTriggerGiveaway(player);
  const promptStartedAt = Date.now();
  room.tictactoe = {
    ...room.tictactoe,
    giveawayPrompt: { seat, forced, startedAt: promptStartedAt, expiresAt: promptStartedAt + (forced ? 2400 : 10_000) }
  };
  scheduleTicTacToeGiveawayPrompt(room);
}

function applyTicTacToeRandomMove(room: RoomState, seat: SeatKey, mode: "giveaway" | "forcedGiveaway"): { ok: true; row: number; col: number } | { ok: false; error: string } {
  if (!room.tictactoe) return { ok: false, error: "井字棋还没有开始" };
  const cells = tictactoeEmptyCells(room.tictactoe.board);
  if (!cells.length) return { ok: false, error: "已经没有空格可以落子" };
  const cell = randomFrom(cells);
  const player = ticTacToeTurnPlayer(room);
  const result = applyTicTacToeMove(room, seat, cell.row, cell.col, mode);
  if (result.ok && player) addGiveawayValue(player, 0.3);
  return result.ok ? { ok: true, row: cell.row, col: cell.col } : { ok: false, error: result.error || "井字棋白给落子失败" };
}

function applyTicTacToeMove(room: RoomState, seat: SeatKey, row: number, col: number, mode: "normal" | "giveaway" | "forcedGiveaway" = "normal") {
  if (!room.tictactoe) return { ok: false, error: "井字棋还没有开始" };
  if (room.phase !== "choosing") return { ok: false, error: "当前不能落子" };
  if (room.tictactoe.ended) return { ok: false, error: "当前井字棋对局已经结束" };
  if (room.tictactoe.turn !== seat) return { ok: false, error: "还没轮到你落子" };
  const prompt = room.tictactoe.giveawayPrompt;
  if (prompt?.seat === seat) {
    if (prompt.forced && mode !== "forcedGiveaway") return { ok: false, error: "强制白给中，系统正在随机落子" };
    if (!prompt.forced && mode === "normal") return { ok: false, error: "请先选择不白给或白给落子" };
    if (!prompt.forced && mode !== "normal" && mode !== "giveaway") return { ok: false, error: "井字棋白给状态不正确" };
  }
  const safeRow = Math.trunc(Number(row));
  const safeCol = Math.trunc(Number(col));
  if (safeRow < 0 || safeRow >= 3 || safeCol < 0 || safeCol >= 3) return { ok: false, error: "这个位置不能落子" };
  if (room.tictactoe.board[safeRow][safeCol]) return { ok: false, error: "这个位置已经有棋子" };
  clearTicTacToeGiveawayTimer(room.id);
  const mark = tictactoeMarkForSeat(room.tictactoe, seat);
  const board = room.tictactoe.board.map((line) => [...line]);
  board[safeRow][safeCol] = mark;
  const moveCount = room.tictactoe.moveCount + 1;
  const winningLine = tictactoeWinningLine(board);
  room.tictactoe = {
    ...room.tictactoe,
    board,
    moveCount,
    turn: oppositeSeat(seat),
    giveawayPrompt: undefined
  };
  if (winningLine) {
    finishTicTacToeGame(room, tictactoeSeatForMark(room.tictactoe, mark), winningLine);
  } else if (moveCount >= 9) {
    finishTicTacToeGame(room, "draw");
  } else {
    const playerName = occupantName(room.seats[seat]);
    room.resultText = mode === "giveaway"
      ? `${playerName} 选择白给落子，系统随机落在第 ${safeRow + 1} 行第 ${safeCol + 1} 列。`
      : mode === "forcedGiveaway"
        ? `${playerName} 触发强制白给，系统随机落在第 ${safeRow + 1} 行第 ${safeCol + 1} 列。`
        : undefined;
    prepareTicTacToeGiveawayPrompt(room);
  }
  return { ok: true };
}

function applyOthelloForfeitRankedFloor(room: RoomState, winnerSeat: SeatKey, loserSeat: SeatKey) {
  if (!room.settings.enableRanked || !room.othello?.rankedDelta) return "";
  const winner = room.seats[winnerSeat] && !("isBot" in room.seats[winnerSeat]!) ? players.get(room.seats[winnerSeat]!.id) : undefined;
  const loser = room.seats[loserSeat] && !("isBot" in room.seats[loserSeat]!) ? players.get(room.seats[loserSeat]!.id) : undefined;
  const minimumWin = room.settings.stake * rankMultiplierFor(room.settings);
  const currentWinnerDelta = room.othello.rankedDelta[winnerSeat] || 0;
  const currentLoserDelta = room.othello.rankedDelta[loserSeat] || 0;
  const targetWinnerDelta = Math.max(currentWinnerDelta, minimumWin);
  const targetLoserDelta = Math.min(currentLoserDelta, -minimumWin);
  const winnerAdjustment = targetWinnerDelta - currentWinnerDelta;
  const loserAdjustment = targetLoserDelta - currentLoserDelta;
  if (winner && winnerAdjustment) updateRankedPoints(winner, winnerAdjustment);
  if (loser && loserAdjustment) updateRankedPoints(loser, loserAdjustment);
  room.othello.rankedDelta[winnerSeat] = targetWinnerDelta;
  room.othello.rankedDelta[loserSeat] = targetLoserDelta;
  if (!winnerAdjustment && !loserAdjustment) return "";
  return `；判负兜底：赢家至少 +${minimumWin}，输家至少 -${minimumWin}`;
}

function applyOthelloEscapeRankedPenalty(room: RoomState, winnerSeat: SeatKey, loserSeat: SeatKey, ratio: number, label: string) {
  if (!room.settings.enableRanked || !room.othello?.rankedDelta) return "";
  const winner = room.seats[winnerSeat] && !("isBot" in room.seats[winnerSeat]!) ? players.get(room.seats[winnerSeat]!.id) : undefined;
  const loser = room.seats[loserSeat] && !("isBot" in room.seats[loserSeat]!) ? players.get(room.seats[loserSeat]!.id) : undefined;
  const unit = room.settings.stake * rankMultiplierFor(room.settings);
  const remainingSpaces = room.othello.board.flat().filter((cell) => cell === null).length;
  const penalty = Math.max(unit, Math.round(remainingSpaces * unit * ratio));
  if (winner) updateRankedPoints(winner, penalty);
  if (loser) updateRankedPoints(loser, -penalty);
  room.othello.rankedDelta[winnerSeat] = (room.othello.rankedDelta[winnerSeat] || 0) + penalty;
  room.othello.rankedDelta[loserSeat] = (room.othello.rankedDelta[loserSeat] || 0) - penalty;
  const ratioText = ratio === 0.5 ? "1/2" : `${ratio}`;
  return `；${label}追加：剩余 ${remainingSpaces} 格 × ${unit} × ${ratioText} = ${penalty}`;
}

function clearOthelloSettlementTimer(roomId: string) {
  const timer = othelloSettlementTimers.get(roomId);
  if (timer) clearTimeout(timer);
  othelloSettlementTimers.delete(roomId);
}

function scheduleOthelloSettlement(room: RoomState) {
  clearOthelloSettlementTimer(room.id);
  const pending = room.othello?.pendingSettlement;
  if (!pending) return;
  const timer = setTimeout(() => {
    const current = rooms.get(room.id);
    if (!current?.othello?.pendingSettlement || current.othello.pendingSettlement.id !== pending.id) return;
    settleOthelloPendingMove(current, pending.forced || "normal", "timeout");
    broadcastRoom(current.id, true);
  }, Math.max(250, pending.expiresAt - Date.now()));
  othelloSettlementTimers.set(room.id, timer);
}

function settleOthelloPendingMove(room: RoomState, mode: "normal" | "giveaway" | "tribute", reason: "choice" | "timeout" | "forced" | "cleanup" = "choice") {
  const pending = room.othello?.pendingSettlement;
  if (!room.othello || !pending) return { ok: false, error: "当前没有待结算落子" };
  const finalMode = pending.forced || mode;
  clearOthelloSettlementTimer(room.id);
  const player = room.seats[pending.seat] && !("isBot" in room.seats[pending.seat]!) ? players.get(room.seats[pending.seat]!.id) : undefined;
  const opponent = room.seats[pending.opponentSeat] && !("isBot" in room.seats[pending.opponentSeat]!) ? players.get(room.seats[pending.opponentSeat]!.id) : undefined;
  const rankedDelta = room.othello.rankedDelta || { A: 0, B: 0 };
  let resultText = "";

  if (finalMode === "normal") {
    const rankedResult = applyRankedStake(player, opponent, pending.stake);
    rankedDelta[pending.seat] += rankedResult.winnerDelta;
    rankedDelta[pending.opponentSeat] += rankedResult.loserDelta;
    resultText = `${occupantName(room.seats[pending.seat])} 本手正常结算：${rankedResult.winnerDelta >= 0 ? "+" : ""}${rankedResult.winnerDelta}`;
  } else if (finalMode === "giveaway") {
    if (player) addGiveawayValue(player, pending.flips * 0.1);
    resultText = `${occupantName(room.seats[pending.seat])} 本手白给，${pending.flips} 子不结算排位分`;
  } else {
    const rankedResult = applyRankedStake(opponent, player, pending.stake);
    rankedDelta[pending.opponentSeat] += rankedResult.winnerDelta;
    rankedDelta[pending.seat] += rankedResult.loserDelta;
    if (player) addGiveawayValue(player, pending.flips * 0.2);
    resultText = `${occupantName(room.seats[pending.seat])} 本手上贡，${occupantName(room.seats[pending.opponentSeat])} 获得 ${rankedResult.winnerDelta >= 0 ? "+" : ""}${rankedResult.winnerDelta}`;
  }

  if (reason === "timeout" && finalMode === "normal") resultText += "（10 秒未选择，自动不白给）";
  if (pending.forced === "giveaway") resultText += "（强制白给）";
  if (pending.forced === "tribute") resultText += "（强制上贡）";

  const settlementEvents = [...(room.othello.settlementEvents || []), resultText].slice(-30);
  if (player) refreshPlayerSnapshots(player);
  if (opponent) refreshPlayerSnapshots(opponent);
  room.othello = {
    ...room.othello,
    rankedDelta,
    settlementEvents,
    pendingSettlement: undefined,
    surrenderRequest: undefined
  };
  room.resultText = resultText;
  roomNotice(room, resultText);
  advanceOthelloTurn(room, pending.nextTurn, 0);
  return { ok: true };
}

function flushOthelloPendingSettlement(room: RoomState) {
  if (!room.othello?.pendingSettlement) return;
  settleOthelloPendingMove(room, "normal", "cleanup");
}

function freshOthelloState(blackSeat: SeatKey = randomSeat()): OthelloState {
  const board = initialOthelloBoard();
  return {
    board,
    turn: blackSeat,
    blackSeat,
    legalMoves: othelloLegalMoves(board, "black"),
    passCount: 0,
    rankedDelta: { A: 0, B: 0 },
    settlementEvents: [],
    ...othelloCounts(board)
  };
}

function resetOthelloRoom(room: RoomState) {
  clearOthelloSettlementTimer(room.id);
  room.othello = undefined;
  room.phase = "ready";
  room.status = "waiting";
  room.resultText = undefined;
  room.revealedChoices = undefined;
  room.choices = {};
  room.disconnectForfeits.clear();
  room.ready = { A: false, B: false };
}

function startOthelloRoom(room: RoomState) {
  if (!room.seats.A || !room.seats.B) return;
  const blackSeat = randomSeat();
  room.phase = "choosing";
  room.status = "playing";
  room.resultText = undefined;
  room.choices = {};
  room.revealedChoices = undefined;
  room.disconnectForfeits.clear();
  room.othello = freshOthelloState(blackSeat);
  room.ready = { A: false, B: false };
}

function scheduleOthelloReadyStart(room: RoomState) {
  if (room.settings.gameId !== "othello") return;
  if (!room.seats.A || !room.seats.B) return;
  if (room.phase !== "ready") return;
  if (!room.ready.A || !room.ready.B) return;
  if (room.resultText === "正在随机执黑先手...") return;
  room.resultText = "正在随机执黑先手...";
  broadcastRoom(room.id, true);
  setTimeout(() => {
    const current = rooms.get(room.id);
    if (!current || current.settings.gameId !== "othello") return;
    if (current.phase !== "ready" || !current.seats.A || !current.seats.B || !current.ready.A || !current.ready.B) return;
    startOthelloRoom(current);
    const blackSeat = current.othello?.blackSeat || "A";
    const blackName = occupantName(current.seats[blackSeat]);
    roomNotice(current, `随机完成：${blackName} 执黑先手。`);
    broadcastRoom(current.id, true);
  }, 1400);
}

function finishOthelloGame(room: RoomState) {
  if (!room.othello) return;
  clearOthelloSettlementTimer(room.id);
  const { blackCount, whiteCount } = othelloCounts(room.othello.board);
  const blackSeat = room.othello.blackSeat;
  const whiteSeat = oppositeSeat(blackSeat);
  const result: RoundResult = blackCount === whiteCount ? "draw" : blackCount > whiteCount ? blackSeat : whiteSeat;
  const punishedPlayers = punishmentPlayersForResult(room, result);
  const punishedNames = punishedPlayers.map((player) => playerShortName(player));
  const punishment = currentPunishment(room);
  const punishmentTasks = buildPunishmentTasks(room, punishedPlayers, result, punishment);
  room.othello = {
    ...room.othello,
    blackCount,
    whiteCount,
    ended: true,
    winner: result,
    legalMoves: []
  };
  room.phase = "result";
  room.status = "playing";
  room.resultText = result === "draw"
    ? `黑白棋平局：黑 ${blackCount}，白 ${whiteCount}`
    : `${occupantName(room.seats[result])}胜利：黑 ${blackCount}，白 ${whiteCount}`;
  const playerA = room.seats.A && !("isBot" in room.seats.A) ? players.get(room.seats.A.id) : undefined;
  const playerB = room.seats.B && !("isBot" in room.seats.B) ? players.get(room.seats.B.id) : undefined;
  const rankedDelta = room.othello.rankedDelta || { A: 0, B: 0 };
  const rankedText = room.settings.enableRanked ? `（实时结算：${othelloRankedText(room.othello)}）` : "";
  if (result === "draw") {
    if (playerA) playerA.stats.draws += 1;
    if (playerB) playerB.stats.draws += 1;
    room.seatStats.A.draws += 1;
    room.seatStats.B.draws += 1;
  } else if (result === "A" || result === "B") {
    const loserSeat = result === "A" ? "B" : "A";
    const winner = result === "A" ? playerA : playerB;
    const loser = loserSeat === "A" ? playerA : playerB;
    if (winner) winner.stats.wins += 1;
    if (loser) loser.stats.losses += 1;
    room.score[result] += 1;
    room.seatedScore[result] += 1;
    room.seatStats[result].wins += 1;
    room.seatStats[loserSeat].losses += 1;
  }
  addOthelloOutcomeStats(playerA, playerB, result);
  if (rankedText) room.resultText += rankedText;
  room.resultText += othelloSettlementSummary(room.othello);
  if (playerA) refreshPlayerSnapshots(playerA);
  if (playerB) refreshPlayerSnapshots(playerB);
  addRoundHistory(room, {
    id: randomId(),
    round: room.roundHistory.length + 1,
    at: Date.now(),
    playerA: occupantName(room.seats.A),
    playerB: occupantName(room.seats.B),
    moveA: "noMove",
    moveB: "noMove",
    result,
    resultLabel: result === "draw" ? "黑白棋平局" : `${occupantName(room.seats[result])}胜利`,
    resultText: room.resultText,
    gameId: "othello",
    othelloScore: { black: blackCount, white: whiteCount },
    othelloBlackSeat: blackSeat,
    ranked: room.settings.enableRanked,
    stake: room.settings.enableRanked ? room.settings.stake : undefined,
    rankMultiplier: room.settings.enableRanked ? rankMultiplierFor(room.settings) : undefined,
    effectiveStake: room.settings.enableRanked ? Math.max(Math.abs(rankedDelta.A), Math.abs(rankedDelta.B)) : undefined,
    punishmentName: punishedNames.length ? punishmentNameForRoom(room, punishment) : undefined,
    punishmentDescription: punishedNames.length && room.settings.punishmentSource !== "player" ? punishment?.description : undefined,
    punishmentTasks,
    punishedNames,
    proofs: []
  });
  setupPunishmentOrNext(room, result);
}

function forceEndOthelloGame(room: RoomState, result: RoundResult, options: { label?: string; historyNote?: string; notice?: string; forfeitRankedFloor?: boolean; escapePenaltyRatio?: number; escapePenaltyLabel?: string } = {}) {
  if (!room.othello) return { ok: false, error: "黑白棋还没有开始" };
  if (room.othello.ended || room.phase === "result") return { ok: false, error: "当前黑白棋对局已经结束" };
  flushOthelloPendingSettlement(room);
  if (!room.othello || room.othello.ended) return { ok: false, error: "当前黑白棋对局已经结束" };
  clearOthelloSettlementTimer(room.id);
  const { blackCount, whiteCount } = othelloCounts(room.othello.board);
  const punishedPlayers = punishmentPlayersForResult(room, result);
  const punishedNames = punishedPlayers.map((player) => playerShortName(player));
  const punishment = currentPunishment(room);
  const punishmentTasks = buildPunishmentTasks(room, punishedPlayers, result, punishment);
  const playerA = room.seats.A && !("isBot" in room.seats.A) ? players.get(room.seats.A.id) : undefined;
  const playerB = room.seats.B && !("isBot" in room.seats.B) ? players.get(room.seats.B.id) : undefined;
  room.othello = {
    ...room.othello,
    blackCount,
    whiteCount,
    ended: true,
    winner: result,
    legalMoves: [],
    surrenderRequest: undefined
  };
  room.phase = "result";
  room.status = "playing";
  const blackSeat = room.othello.blackSeat;
  const label = options.label || (result === "draw" ? "管理员判定平局" : `管理员判定${result === blackSeat ? "黑方" : "白方"}胜利`);
  const rankedFloorText = options.forfeitRankedFloor && (result === "A" || result === "B")
    ? applyOthelloForfeitRankedFloor(room, result, oppositeSeat(result))
    : "";
  const escapePenaltyText = options.escapePenaltyRatio && (result === "A" || result === "B")
    ? applyOthelloEscapeRankedPenalty(room, result, oppositeSeat(result), options.escapePenaltyRatio, options.escapePenaltyLabel || "逃跑")
    : "";
  if (result === "draw") {
    if (playerA) playerA.stats.draws += 1;
    if (playerB) playerB.stats.draws += 1;
    room.seatStats.A.draws += 1;
    room.seatStats.B.draws += 1;
  } else if (result === "A" || result === "B") {
    const loserSeat = result === "A" ? "B" : "A";
    const winner = result === "A" ? playerA : playerB;
    const loser = loserSeat === "A" ? playerA : playerB;
    if (winner) winner.stats.wins += 1;
    if (loser) loser.stats.losses += 1;
    room.score[result] += 1;
    room.seatedScore[result] += 1;
    room.seatStats[result].wins += 1;
    room.seatStats[loserSeat].losses += 1;
  }
  addOthelloOutcomeStats(playerA, playerB, result);
  const rankedText = room.settings.enableRanked ? `；实时结算：${othelloRankedText(room.othello)}${rankedFloorText}${escapePenaltyText}` : "";
  room.resultText = `${label}：黑 ${blackCount}，白 ${whiteCount}${rankedText}${othelloSettlementSummary(room.othello)}`;
  if (playerA) refreshPlayerSnapshots(playerA);
  if (playerB) refreshPlayerSnapshots(playerB);
  const finalRankedDelta = room.othello.rankedDelta || { A: 0, B: 0 };
  addRoundHistory(room, {
    id: randomId(),
    round: room.roundHistory.length + 1,
    at: Date.now(),
    playerA: occupantName(room.seats.A),
    playerB: occupantName(room.seats.B),
    moveA: "noMove",
    moveB: "noMove",
    result,
    resultLabel: label,
    resultText: options.historyNote ? `${room.resultText}（${options.historyNote}）` : `${room.resultText}（管理员处理）`,
    gameId: "othello",
    othelloScore: { black: blackCount, white: whiteCount },
    othelloBlackSeat: blackSeat,
    ranked: room.settings.enableRanked,
    stake: room.settings.enableRanked ? room.settings.stake : undefined,
    rankMultiplier: room.settings.enableRanked ? rankMultiplierFor(room.settings) : undefined,
    effectiveStake: room.settings.enableRanked ? Math.max(Math.abs(finalRankedDelta.A), Math.abs(finalRankedDelta.B)) : undefined,
    extremeRanked: Boolean(room.settings.enableExtremeRanked),
    punishmentName: punishedNames.length ? punishmentNameForRoom(room, punishment) : undefined,
    punishmentDescription: punishedNames.length && room.settings.punishmentSource !== "player" ? punishment?.description : undefined,
    punishmentTasks,
    punishedNames,
    proofs: []
  });
  roomNotice(room, options.notice || `${label}，本局已结束。`);
  setupPunishmentOrNext(room, result);
  return { ok: true };
}

function advanceOthelloTurn(room: RoomState, nextTurn: SeatKey, passCount: number) {
  if (!room.othello) return;
  const nextColor = othelloColorForSeat(room.othello, nextTurn);
  const legalMoves = othelloLegalMoves(room.othello.board, nextColor);
  if (legalMoves.length) {
    room.othello = { ...room.othello, turn: nextTurn, legalMoves, passCount, ...othelloCounts(room.othello.board) };
    room.resultText = undefined;
    return;
  }
  if (passCount + 1 >= 2) {
    finishOthelloGame(room);
    return;
  }
  const skippedName = occupantName(room.seats[nextTurn]);
  const fallbackTurn = nextTurn === "A" ? "B" : "A";
  const fallbackColor = othelloColorForSeat(room.othello, fallbackTurn);
  const fallbackLegalMoves = othelloLegalMoves(room.othello.board, fallbackColor);
  if (!fallbackLegalMoves.length) {
    finishOthelloGame(room);
    return;
  }
  roomNotice(room, `${skippedName} 没有合法落子，系统自动跳过。`);
  room.othello = {
    ...room.othello,
    turn: fallbackTurn,
    legalMoves: fallbackLegalMoves,
    passCount: passCount + 1,
    ...othelloCounts(room.othello.board)
  };
}

function applyOthelloMove(room: RoomState, seat: SeatKey, row: number, col: number) {
  if (!room.othello) return { ok: false, error: "黑白棋还没有开始" };
  if (room.phase !== "choosing") return { ok: false, error: "当前不能落子" };
  if (room.othello.pendingSettlement) return { ok: false, error: "上一手还在等待白给/上贡结算" };
  if (room.othello.turn !== seat) return { ok: false, error: "还没轮到你落子" };
  const color = othelloColorForSeat(room.othello, seat);
  const flips = othelloFlips(room.othello.board, row, col, color);
  if (!flips.length) return { ok: false, error: "这个位置不能落子" };
  const board = room.othello.board.map((line) => [...line]);
  board[row][col] = color;
  for (const item of flips) board[item.row][item.col] = color;
  const rankedDelta = room.othello.rankedDelta || { A: 0, B: 0 };
  const opponentSeat: SeatKey = seat === "A" ? "B" : "A";
  const player = room.seats[seat] && !("isBot" in room.seats[seat]!) ? players.get(room.seats[seat]!.id) : undefined;
  const opponent = room.seats[opponentSeat] && !("isBot" in room.seats[opponentSeat]!) ? players.get(room.seats[opponentSeat]!.id) : undefined;
  addOthelloCaptureStats(player, opponent, flips.length);
  const liveStake = flips.length * room.settings.stake * rankMultiplierFor(room.settings);
  const useGiveawaySettlement = Boolean(room.settings.enableRanked && player?.giveawayEnabled && isHumanVsHumanRoom(room));
  const nextTurn = othelloSeatForColor(room.othello, oppositeOthelloColor(color));
  if (useGiveawaySettlement) {
    const forcedGiveaway = player ? shouldTriggerGiveaway(player) : false;
    const forced: "giveaway" | "tribute" | undefined = forcedGiveaway
      ? (player && (player.giveawayValue || 0) >= 75 && Math.random() < 0.5 ? "tribute" : "giveaway")
      : undefined;
    const pending = {
      id: randomId(),
      seat,
      opponentSeat,
      flips: flips.length,
      stake: liveStake,
      nextTurn,
      expiresAt: Date.now() + (forced ? 2400 : 10_000),
      forced
    };
    room.othello = {
      ...room.othello,
      board,
      passCount: 0,
      rankedDelta,
      pendingSettlement: pending,
      surrenderRequest: undefined,
      legalMoves: [],
      ...othelloCounts(board)
    };
    room.resultText = forced === "tribute"
      ? `${occupantName(room.seats[seat])} 触发强制上贡，正在结算...`
      : forced === "giveaway"
        ? `${occupantName(room.seats[seat])} 触发强制白给，正在结算...`
        : `${occupantName(room.seats[seat])} 请在 10 秒内选择：不白给 / 白给 / 上贡。`;
    if (player) refreshPlayerSnapshots(player);
    if (opponent) refreshPlayerSnapshots(opponent);
    scheduleOthelloSettlement(room);
    return { ok: true };
  }
  if (room.settings.enableRanked) {
    const rankedResult = applyRankedStake(player, opponent, liveStake);
    rankedDelta[seat] += rankedResult.winnerDelta;
    rankedDelta[opponentSeat] += rankedResult.loserDelta;
  }
  if (player) refreshPlayerSnapshots(player);
  if (opponent) refreshPlayerSnapshots(opponent);
  room.othello = { ...room.othello, board, passCount: 0, rankedDelta, surrenderRequest: undefined, ...othelloCounts(board) };
  advanceOthelloTurn(room, nextTurn, 0);
  return { ok: true };
}

function maybeStartChoosing(room: RoomState) {
  // 只在等待/正常选拳阶段补齐座位后开局。
  // 惩罚阶段或结算阶段有人进房时，绝不能清空惩罚状态。
  if (room.phase === "punishment" || room.phase === "result") return;
  if (room.settings.gameId === "othello") {
    // 黑白棋由“双方准备”来开局；观战玩家进房、聊天、重连等广播都不能重置棋盘。
    // 如果当前已经在准备或落子阶段，保持原状态。
    if (room.phase === "ready" || room.phase === "choosing") return;
    if (room.seats.A && room.seats.B) resetOthelloRoom(room);
    return;
  }
  if (room.settings.gameId === "tictactoe") {
    if (room.phase === "ready" || room.phase === "choosing") return;
    if (room.seats.A && room.seats.B) resetTicTacToeRoom(room);
    return;
  }
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
  if (room.settings.gameId === "othello") {
    resetOthelloRoom(room);
    return;
  }
  if (room.settings.gameId === "tictactoe") {
    resetTicTacToeRoom(room);
    return;
  }
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
  const rankedMultiplier = rankMultiplierFor(room.settings);
  const rankedStake = effectiveRankedStake(room.settings);
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
    resetExtremeWinStreak(playerA);
    resetExtremeWinStreak(playerB);
    const rankedPenalty = room.settings.enableRanked ? applyRankedDrawPenaltyStake(playerA, playerB, rankedStake) : undefined;
    room.resultText = room.settings.enableRanked
      ? `双方白给，双输：A ${rankedPenalty?.deltaA || 0} 分，B ${rankedPenalty?.deltaB || 0} 分`
      : "双方白给，双输";
  } else if (result === "draw") {
    if (playerA) playerA.stats.draws += 1;
    if (playerB) playerB.stats.draws += 1;
    room.seatStats.A.draws += 1;
    room.seatStats.B.draws += 1;
    resetExtremeWinStreak(playerA);
    resetExtremeWinStreak(playerB);
    if (room.settings.enableRanked && room.settings.tieDoublePunish) {
      const rankedPenalty = applyRankedDrawPenaltyStake(playerA, playerB, rankedStake);
      room.resultText = `平局双罚：双方都出了 ${moveText(finalChoices.A)}，A ${rankedPenalty.deltaA} 分，B ${rankedPenalty.deltaB} 分`;
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
    let streakText = "";
    let rankedText = "";
    if (room.settings.enableRanked) {
      const rankedResult = applyRankedStake(winner, loser, rankedStake);
      resetExtremeWinStreak(loser);
      streakText = applyExtremeWinStreakRisk(room, winner);
      rankedText = `（${occupantName(room.seats[winnerSeat])} ${rankedResult.winnerDelta >= 0 ? "+" : ""}${rankedResult.winnerDelta}，${occupantName(room.seats[loserSeat])} ${rankedResult.loserDelta}）`;
    }
    room.resultText = giveawayText
      ? `${giveawayText}，${occupantName(room.seats[winnerSeat])}胜利${rankedText}${streakText}`
      : `${occupantName(room.seats[winnerSeat])}胜利${rankedText}${streakText}`;
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
    rankMultiplier: room.settings.enableRanked ? rankedMultiplier : undefined,
    effectiveStake: room.settings.enableRanked ? rankedStake : undefined,
    extremeRanked: Boolean(room.settings.enableExtremeRanked),
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
  io.to(room.id).emit("room:historyAppend", { roomId: room.id, item, total: room.roundHistory.length });
  // 任意对局结算都会写一条战绩，这里统一触发一次惰性持久化，覆盖排位/非排位/断线判负。
  requestPersist("lazy");
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
  if (settings.gameId === "othello" && !settings.enablePunishment) return uniqueRoomName(defaultOthelloRoomName);
  if (settings.gameId === "tictactoe" && !settings.enablePunishment) return uniqueRoomName(defaultTicTacToeRoomName);
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
  if (!cleanName || cleanName === defaultRoomName || cleanName === defaultOthelloRoomName || cleanName === defaultTicTacToeRoomName) return generatedRoomName(settings);
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
  if (!room) return { ok: true };
  const isProtectedReason = reason === "manual" || reason === "switchRoom" || reason === "spectate";
  if (room.settings.gameId === "othello" && room.phase === "choosing" && seatOf(room, player.id) && isProtectedReason) {
    return { ok: false, error: "黑白棋对局进行中不能离开战斗席，可以申请认输、逃跑或等待对局结束" };
  }
  if (room.settings.gameId === "tictactoe" && room.phase === "choosing" && seatOf(room, player.id) && isProtectedReason) {
    return { ok: false, error: "井字棋对局进行中不能离开战斗席，请等待对局结束" };
  }
  if (room.phase !== "punishment") return { ok: true };
  const isPunished = room.punishedPlayerIds.includes(player.id);
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
  if (room.settings.gameId === "othello" && room.phase !== "result" && room.phase !== "choosing") resetOthelloRoom(room);
  if (room.settings.gameId === "tictactoe" && room.phase !== "result" && room.phase !== "choosing") resetTicTacToeRoom(room);
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
  if (reason === "adminKick" && (room.settings.gameId === "othello" || room.settings.gameId === "tictactoe") && room.phase === "choosing" && seatOf(room, player.id)) {
    createDisconnectForfeit(room, player);
    applyDisconnectForfeit(room, player);
  }
  const seat = seatOf(room, player.id);
  if (seat) {
    clearSeatForPlayer(room, seat);
  }
  if (player.socketId) io.sockets.sockets.get(player.socketId)?.leave(room.id);
  room.spectatorIds = room.spectatorIds.filter((id) => id !== player.id);
  player.roomId = undefined;
  const roomDeleted = cleanupRoomIfEmpty(room);
  if (!roomDeleted) {
    broadcastRoom(room.id);
    broadcastLobby();
  }
  return { ok: true };
}

io.on("connection", (socket) => {
  socket.use(([event], next) => {
    const ipAddress = socketIp(socket);
    const eventName = String(event || "unknown");
    // guardedOn handles per-event granular rate limits with cooldowns;
    // this global middleware is a generous backstop (600/60s) against flood attacks.
    if (consumeRateLimit(`socket:${ipAddress}:${eventName}`, 60_000, 600)) return next();
    next(new Error("rate limited"));
  });
  socket.emit("config:update", publicConfig());
  socket.join(lobbyChannel);
  socket.emit("lobby:update", lobbySnapshot({ includeSuggestions: true }));

  guardedOn(socket, "player:join", { limit: 8, windowMs: 60_000, cooldownMs: 60_000 }, ({ name, genderId, playerId, playerSecret }: { name: string; genderId: string; token?: string; playerId?: string; playerSecret?: string }, reply) => {
    const cleanName = cleanText(name, 12);
    if (cleanName.length < 2) return reply?.({ error: config.messages.nameRequired });

    const sid = String(socket.data.sid || "");
    const ipAddress = String(socket.data.ipAddress || socketIp(socket));
    const identityPlayerId = typeof playerId === "string" && playerId ? playerId : undefined;
    const identityPlayerSecret = typeof playerSecret === "string" && playerSecret ? playerSecret : undefined;
    // 身份解析：优先用长期 playerId 定位玩家，回退到 sid（无身份的临时玩家）。
    let player = identityPlayerId ? players.get(playerIdToId.get(identityPlayerId) || "") : players.get(sid);
    if (player?.persistent) {
      if (!identityPlayerSecret || player.playerSecretHash !== hashSecret(identityPlayerSecret)) {
        securityLog("player_identity_invalid", { sid, ip: ipAddress, userAgent: socket.handshake.headers["user-agent"] });
        return reply?.({ error: "玩家身份校验失败", code: "PLAYER_IDENTITY_INVALID" });
      }
    }
    if (!player) {
      if (onlinePlayersFromIp(ipAddress) >= config.accessControl.maxOnlinePerIp) {
        return reply?.({ error: `当前网络下在线人数过多，最多允许 ${config.accessControl.maxOnlinePerIp} 人同时在线` });
      }
      if (!canCreateFromIp(ipAddress)) {
        return reply?.({ error: `当前网络 10 分钟内新建玩家过多，最多允许 ${config.accessControl.maxCreatesPer10Min} 次` });
      }
      player = createPlayer(cleanName, genderId, String(socket.data.token || ""), { playerId: identityPlayerId, playerSecret: identityPlayerSecret });
      securityLog("player_created", { sid, ip: ipAddress, userAgent: socket.handshake.headers["user-agent"] });
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
    player.currentSid = sid;
    player.lastSeenAt = Date.now();
    player.disconnectedAt = undefined;
    player.disconnectExpiresAt = undefined;
    // sid/token 与 player.id 重新建立映射，供断线重连、上传鉴权使用。
    socket.data.playerId = player.id;
    if (sid) sidToPlayerId.set(sid, player.id);
    const sessionToken = String(socket.data.token || player.token);
    tokenToPlayerId.set(sessionToken, player.id);
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
    if (player.roomId) {
      socket.leave(lobbyChannel);
      socket.join(player.roomId);
    } else {
      socket.join(lobbyChannel);
      socket.join(lobbySuggestionChannel);
    }
    const currentRoom = player.roomId ? rooms.get(player.roomId) : undefined;
    reply?.({ player: publicPlayer(player), token: player.token, roomId: player.roomId, room: currentRoom ? roomSnapshot(currentRoom, { includeChat: true, includeHistory: true }) : undefined });
    if (player.persistent) requestPersist("lazy");
    broadcastLobby();
    if (player.roomId) {
      if (currentRoom?.phase === "punishment" && hadDisconnectHold) {
        roomNotice(currentRoom, `${playerShortName(player)} 已重新连接，恢复到未完成的惩罚房间。`);
      }
      broadcastRoom(player.roomId);
    }
  });

  guardedOn(socket, "admin:login", { limit: 5, windowMs: 60_000, cooldownMs: 60_000 }, ({ password }: { password: string }, reply) => {
    const player = getPlayer(socket.id);
    if (!adminPasswordMatches(password)) return reply?.({ error: "管理员口令不正确或尚未设置" });
    adminSocketIds.add(socket.id);
    if (player) player.isAdmin = true;
    reply?.({ ok: true });
    broadcastLobby();
  });

  guardedOn(socket, "lobby:subscribe", { limit: 20, windowMs: 60_000, cooldownMs: 10_000 }, (_payload, reply) => {
    socket.join(lobbyChannel);
    socket.join(lobbySuggestionChannel);
    socket.emit("lobby:update", lobbySnapshot({ includeSuggestions: true }));
    reply?.({ ok: true });
  });

  guardedOn(socket, "lobby:unsubscribe", { limit: 20, windowMs: 60_000, cooldownMs: 10_000 }, (_payload, reply) => {
    socket.leave(lobbyChannel);
    socket.leave(lobbySuggestionChannel);
    reply?.({ ok: true });
  });

  guardedOn(socket, "lobby:suggestions:subscribe", { limit: 20, windowMs: 60_000, cooldownMs: 10_000 }, (_payload, reply) => {
    socket.join(lobbySuggestionChannel);
    reply?.({ suggestions: suggestions.slice(0, 50) });
  });

  guardedOn(socket, "lobby:suggestions:unsubscribe", { limit: 20, windowMs: 60_000, cooldownMs: 10_000 }, (_payload, reply) => {
    socket.leave(lobbySuggestionChannel);
    reply?.({ ok: true });
  });

  guardedOn(socket, "player:updateProfile", { limit: 10, windowMs: 60_000, cooldownMs: 30_000 }, ({ name, genderId, nameWarEnabled, nameWarAllowRename, giveawayEnabled, extremeModeEnabled }: { name: string; genderId: string; nameWarEnabled?: boolean; nameWarAllowRename?: boolean; giveawayEnabled?: boolean; extremeModeEnabled?: boolean }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入大厅" });
    const cleanName = cleanText(name, 12);
    if (cleanName.length < 2) return reply?.({ error: config.messages.nameRequired });

    const now = Date.now();
    const nameChanged = cleanName !== player.name;
    const nextNameWarEnabled = Boolean(nameWarEnabled);
    const nextAllowRename = nextNameWarEnabled && Boolean(nameWarAllowRename);
    const nameWarChanged = nextNameWarEnabled !== Boolean(player.nameWarEnabled);
    const allowRenameChanged = nextAllowRename !== Boolean(player.nameWarAllowRename);
    const nextGiveawayEnabled = Boolean(giveawayEnabled);
    const nextExtremeModeEnabled = Boolean(extremeModeEnabled);
    const extremeModeChanged = nextExtremeModeEnabled !== Boolean(player.extremeModeEnabled);
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
    if (extremeModeChanged && nextExtremeModeEnabled) {
      if (player.extremeModeCooldownUntil && player.extremeModeCooldownUntil > now) {
        const hours = Math.ceil((player.extremeModeCooldownUntil - now) / 3_600_000);
        return reply?.({ error: `极限模式冷却中，请 ${hours} 小时后再开启` });
      }
      if (player.stats.rankedPoints < 0) return reply?.({ error: "负分玩家不能开启极限模式" });
    }
    if (extremeModeChanged && !nextExtremeModeEnabled && player.stats.rankedPoints <= 0) {
      return reply?.({ error: "排位分必须大于 0 才能关闭极限模式，0 分不能关闭" });
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
    if (extremeModeChanged) {
      player.extremeModeEnabled = nextExtremeModeEnabled;
      player.extremeModeToggledAt = now;
      player.extremeWinStreak = 0;
      if (nextExtremeModeEnabled) {
        player.stats.rankedPoints = 0;
        player.extremeLastDecayHour = currentExtremeDecayHour(now);
        syncTitleForRankSegment(player);
      } else {
        player.extremeModeCooldownUntil = now + config.extremeMode.cooldownHours * 3_600_000;
      }
    }
    if (nameChanged) player.profileUpdatedAt = now;
    player.displayName = formatDisplayName(player);
    refreshPlayerSnapshots(player);
    broadcastPlayerUpdate(player);
    if (player.persistent) requestPersist("lazy");
    reply?.({ player: publicPlayer(player) });
    if (player.roomId) broadcastRoom(player.roomId);
  });

  guardedOn(socket, "giveaway:boost", { limit: 20, windowMs: 60_000, cooldownMs: 30_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (!player.giveawayEnabled) return reply?.({ error: "请先在个人设置开启白给模式" });
    if (!seatOf(room, player.id)) return reply?.({ error: "只有战斗席玩家可以白给" });
    if (!isHumanVsHumanRoom(room)) return reply?.({ error: "Bot 对战不能使用白给模式" });
    if (room.phase === "punishment") return reply?.({ error: "惩罚阶段不能增加白给值" });
    player.giveawayClicks = (player.giveawayClicks || 0) + 1;
    addGiveawayValue(player, 2);
    reply?.({ player: publicPlayer(player) });
    broadcastRoom(room.id);
  });

  guardedOn(socket, "giveaway:submitBoard", { limit: 4, windowMs: 60_000, cooldownMs: 60_000 }, ({ text }: { text: string }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入游戏" });
    if (!player.giveawayEnabled || (player.giveawayValue || 0) <= 0) return reply?.({ error: "白给值大于 0% 时才能上板自救" });
    const cleanBoardText = cleanText(text, 300);
    if (cleanBoardText.length < 2) return reply?.({ error: "自我惩罚宣言至少需要 2 个字" });
    const now = Date.now();
    player.giveawayBoardText = cleanBoardText;
    player.giveawayBoardSubmittedAt = now;
    player.giveawayBoardExpiresAt = now + giveawayBoardDurationMs;
    player.giveawayBoardLikes = 0;
    player.giveawayBoardDislikes = 0;
    player.giveawayBoardLikeWindowStartedAt = now;
    player.giveawayBoardLikesThisHour = 0;
    refreshPlayerSnapshots(player);
    broadcastPlayerUpdate(player);
    reply?.({ player: publicPlayer(player) });
  });

  guardedOn(socket, "giveaway:vote", { limit: 30, windowMs: 60_000, cooldownMs: 30_000 }, ({ targetId, vote }: { targetId: string; vote: "like" | "dislike" }, reply) => {
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
      actor.giveawayVoteLikesThisHour = 0;
      actor.giveawayVoteDislikesThisHour = 0;
    }

    if (vote === "like") {
      if ((actor.giveawayVoteLikesThisHour || 0) >= 3) return reply?.({ error: "你本小时点赞降值次数已满" });
      actor.giveawayVoteLikesThisHour = (actor.giveawayVoteLikesThisHour || 0) + 1;
      target.giveawayBoardLikes = (target.giveawayBoardLikes || 0) + 1;
      addGiveawayValue(target, -1);
      if ((target.giveawayValue || 0) <= 0) {
        target.giveawayBoardText = undefined;
        target.giveawayBoardSubmittedAt = undefined;
        target.giveawayBoardExpiresAt = undefined;
      }
    } else {
      if ((actor.giveawayVoteDislikesThisHour || 0) >= 10) return reply?.({ error: "你本小时倒赞加值次数已满" });
      actor.giveawayVoteDislikesThisHour = (actor.giveawayVoteDislikesThisHour || 0) + 1;
      target.giveawayBoardDislikes = (target.giveawayBoardDislikes || 0) + 1;
      addGiveawayValue(target, 0.1);
    }
    actor.giveawayVoteCount = (actor.giveawayVoteCount || 0) + 1;
    broadcastPlayerUpdate(actor);
    refreshPlayerSnapshots(target);
    broadcastPlayerUpdate(target);
    reply?.({ ok: true });
    if (target.roomId) broadcastRoom(target.roomId);
    if (actor.roomId && actor.roomId !== target.roomId) broadcastRoom(actor.roomId);
  });

  guardedOn(socket, "rankMultiplier:unlock", { limit: 6, windowMs: 60_000, cooldownMs: 30_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入游戏" });
    if (player.extremeModeEnabled) return reply?.({ error: "极限模式玩家不能解锁倍率模式" });
    if (player.rankMultiplierUnlocked) return reply?.({ player: publicPlayer(player) });
    if (player.stats.rankedPoints < 200) return reply?.({ error: "需要至少 200 排位积分才能解锁倍率模式" });
    updateRankedPoints(player, -200);
    player.rankMultiplierUnlocked = true;
    refreshPlayerSnapshots(player);
    broadcastPlayerUpdate(player);
    reply?.({ player: publicPlayer(player) });
    if (player.roomId) broadcastRoom(player.roomId);
  });

  guardedOn(socket, "extreme:forceClose", { limit: 4, windowMs: 60_000, cooldownMs: 60_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入游戏" });
    if (!player.extremeModeEnabled) return reply?.({ error: "你还没有开启极限模式" });
    const now = Date.now();
    player.extremeModeEnabled = false;
    player.extremeModeToggledAt = now;
    player.extremeModeCooldownUntil = now + config.extremeMode.cooldownHours * 3_600_000;
    player.extremeWinStreak = 0;
    player.extremeForceClosed = true;
    player.extremeForceClosedAt = now;
    player.displayName = formatDisplayName(player);
    refreshPlayerSnapshots(player);
    broadcastPlayerUpdate(player);
    reply?.({ player: publicPlayer(player) });
    if (player.roomId) broadcastRoom(player.roomId);
  });

  guardedOn(socket, "nameWar:renameTarget", { limit: 8, windowMs: 60_000, cooldownMs: 60_000 }, ({ targetId, name, kind }: { targetId: string; name: string; kind?: "nameWar" | "extreme" }, reply) => {
    const actor = getPlayer(socket.id);
    const target = players.get(targetId);
    if (!actor) return reply?.({ error: "请先进入游戏" });
    if (!target) return reply?.({ error: "改名目标不存在" });
    refreshNameWarState(target);
    if (actor.id === target.id) return reply?.({ error: "不能修改自己的名字" });
    const now = Date.now();
    const cleanName = cleanText(name, 12);
    if (cleanName.length < 2) return reply?.({ error: "新名字至少需要 2 个字" });
    const renameKind = kind || (isNameWarRenameTarget(target) ? "nameWar" : target.extremeForceClosed ? "extreme" : "nameWar");

    if (renameKind === "extreme") {
      if (!target.extremeForceClosed) return reply?.({ error: "对方不是极限强关可改名目标" });
      if (!actor.extremeModeEnabled) return reply?.({ error: "只有开启极限模式的玩家可以修改极限强关目标" });
      const minPoints = Math.max(1, Math.round(config.extremeMode.forceRenameMinPoints || 1));
      if (actor.stats.rankedPoints < minPoints) return reply?.({ error: `需要极限模式且至少 ${minPoints} 分才能修改极限强关目标` });
      if (target.extremeRenameProtectedUntil && target.extremeRenameProtectedUntil > now) {
        const hours = Math.ceil((target.extremeRenameProtectedUntil - now) / 3_600_000);
        return reply?.({ error: `对方正在极限改名保护期内，请 ${hours} 小时后再试` });
      }
      target.name = cleanName;
      target.nameWarOriginalName = cleanName;
      target.extremeRenameProtectedUntil = now + Math.max(1, config.extremeMode.forceRenameProtectHours || 4) * 3_600_000;
      target.extremeRenamedBy = actor.id;
      target.extremeRenamedByName = playerShortName(actor);
      refreshNameWarState(target, now);
      target.displayName = formatDisplayName(target);
      refreshPlayerSnapshots(target);
      broadcastPlayerUpdate(target);
      reply?.({ ok: true });
      if (target.roomId) broadcastRoom(target.roomId);
      if (actor.roomId && actor.roomId !== target.roomId) broadcastRoom(actor.roomId);
      return;
    }

    if (actor.stats.rankedPoints < 500) return reply?.({ error: "需要 500 分以上才能修改失格者名字" });
    if (!isNameWarRenameTarget(target)) return reply?.({ error: "对方当前不是可改名失格者" });
    if (target.nameWarRenameProtectedUntil && target.nameWarRenameProtectedUntil > now) {
      const hours = Math.ceil((target.nameWarRenameProtectedUntil - now) / 3_600_000);
      return reply?.({ error: `对方正在保护期内，请 ${hours} 小时后再试` });
    }
    if (nameWarRenameQuota(actor, now) <= 0) return reply?.({ error: "你 3 小时内已经修改了 3 个名字" });
    target.nameWarPenaltyName = cleanName;
    target.nameWarPunished = true;
    target.nameWarRenameProtectedUntil = now + 21_600_000;
    target.nameWarRenamedBy = actor.id;
    target.nameWarRenamedByName = playerShortName(actor);
    actor.nameWarRenameCount = (actor.nameWarRenameCount || 0) + 1;
    target.displayName = formatDisplayName(target);
    refreshPlayerSnapshots(target);
    broadcastPlayerUpdate(target);
    reply?.({ ok: true });
    if (target.roomId) broadcastRoom(target.roomId);
    if (actor.roomId && actor.roomId !== target.roomId) broadcastRoom(actor.roomId);
  });

  guardedOn(socket, "config:get", { limit: 6, windowMs: 60_000, cooldownMs: 30_000 }, ({ password }: { password?: string } = {}, reply) => {
    if (!adminPasswordMatches(password)) return reply?.({ error: "管理员口令不正确或尚未设置" });
    reply?.({ config: publicConfig() });
  });
  guardedOn(socket, "config:save", { limit: 6, windowMs: 60_000, cooldownMs: 60_000 }, ({ password, nextConfig }: { password: string; nextConfig: AppConfig }, reply) => {
    if (!adminPasswordMatches(password)) return reply?.({ error: "管理员口令不正确或尚未设置" });
    try {
      if (!String(nextConfig.site?.adminPassword || "").trim()) {
        nextConfig = { ...nextConfig, site: { ...nextConfig.site, adminPassword: config.site.adminPassword } };
      }
      config = saveConfig(nextConfig);
      refreshAllPlayersForConfig();
      reply?.({ config: publicConfig() });
      broadcastLobby();
      io.emit("config:update", publicConfig());
    } catch (error) {
      reply?.({ error: error instanceof Error ? error.message : "配置保存失败" });
    }
  });
  guardedOn(socket, "config:reset", { limit: 3, windowMs: 60_000, cooldownMs: 60_000 }, ({ password }: { password: string }, reply) => {
    if (!adminPasswordMatches(password)) return reply?.({ error: "管理员口令不正确或尚未设置" });
    config = resetConfig();
    refreshAllPlayersForConfig();
    reply?.({ config: publicConfig() });
    broadcastLobby();
    io.emit("config:update", publicConfig());
  });

  guardedOn(socket, "room:create", { limit: 5, windowMs: 60_000, cooldownMs: 60_000 }, ({ settings }: { settings: RoomSettings }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入大厅" });
    const gameId = settings.gameId === "othello" || settings.gameId === "tictactoe" ? settings.gameId : "rps";
    const normalizedSettings: RoomSettings = {
      ...settings,
      gameId,
      stake: settings.stake || 5,
      allowProofImage: settings.allowProofImage !== false,
      punishmentSource: settings.punishmentSource || "system",
      enableRankMultiplier: Boolean(settings.enableRanked && settings.enableRankMultiplier),
      rankMultiplier: settings.enableRankMultiplier && ([2, 5, 10] as RankMultiplier[]).includes(settings.rankMultiplier as RankMultiplier)
        ? settings.rankMultiplier as RankMultiplier
        : 1,
      enableExtremeRanked: Boolean(settings.enableRanked && settings.enableExtremeRanked)
    };
    if (normalizedSettings.gameId === "othello") {
      if (![1, 2, 5, 10].includes(normalizedSettings.stake)) normalizedSettings.stake = 5;
      if (!["classic", "pastel", "midnight", "wood", "neon"].includes(String(normalizedSettings.othelloBoardTheme || ""))) {
        normalizedSettings.othelloBoardTheme = "classic";
      }
      normalizedSettings.enableBot = false;
    } else if (normalizedSettings.gameId === "tictactoe") {
      if (![5, 10, 20].includes(normalizedSettings.stake)) normalizedSettings.stake = 5;
      if (!["paper", "mint", "midnight", "candy", "arcade"].includes(String(normalizedSettings.tictactoeBoardTheme || ""))) {
        normalizedSettings.tictactoeBoardTheme = "paper";
      }
      normalizedSettings.enableBot = false;
    } else if (![5, 10, 20].includes(normalizedSettings.stake)) {
      normalizedSettings.stake = 5;
    }
    if (!normalizedSettings.enableRanked) {
      normalizedSettings.enableRankMultiplier = false;
      normalizedSettings.rankMultiplier = 1;
      normalizedSettings.enableExtremeRanked = false;
    }
    if (normalizedSettings.enableExtremeRanked) {
      normalizedSettings.enableRankMultiplier = false;
      normalizedSettings.rankMultiplier = 1;
    }
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
    if (normalizedSettings.enableRanked && player.extremeModeEnabled !== Boolean(normalizedSettings.enableExtremeRanked)) {
      return reply?.({ error: player.extremeModeEnabled ? "极限模式玩家只能创建极限排位房" : "只有极限模式玩家可以创建极限排位房" });
    }
    if (normalizedSettings.enableExtremeRanked && normalizedSettings.enableBot) {
      return reply?.({ error: "极限排位不能开启 Bot" });
    }
    if (normalizedSettings.enableExtremeRanked && normalizedSettings.enableRankMultiplier) {
      return reply?.({ error: "极限排位不能开启倍率模式" });
    }
    if (normalizedSettings.enableRankMultiplier && !player.rankMultiplierUnlocked) {
      return reply?.({ error: "请先提交 200 排位积分解锁倍率模式" });
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
      othello: undefined,
      tictactoe: undefined,
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
    socket.leave(lobbyChannel);
    socket.join(roomId);
    securityLog("room_created", { sid: player.id, ip: player.ipAddress, roomId, event: "room:create", userAgent: socket.handshake.headers["user-agent"] });
    roomNotice(room, `${playerShortName(player)} 进入房间，坐在战斗席 A。`);
    reply?.({ room: roomSnapshot(room, { includeChat: true, includeHistory: true }) });
    broadcastRoom(roomId, true);
  });

  guardedOn(socket, "room:join", { limit: 12, windowMs: 60_000, cooldownMs: 45_000 }, ({ roomId, password }: { roomId: string; password?: string }, reply) => {
    const player = getPlayer(socket.id);
    const room = rooms.get(roomId);
    if (!player || !room) return reply?.({ error: "房间不存在" });
    if (room.settings.password && room.settings.password !== password) return reply?.({ error: config.messages.passwordWrong });
    const leaveResult = leaveRoom(player, "switchRoom");
    if (!leaveResult.ok) return reply?.({ error: leaveResult.error });
    player.roomId = room.id;
    let joinRole = "观战";
    if (canAutoSeatOnJoin(room, player) && !room.seats.A) {
      room.seats.A = publicPlayer(player);
      joinRole = "战斗席 A";
    }
    else if (canAutoSeatOnJoin(room, player) && !room.seats.B) {
      room.seats.B = publicPlayer(player);
      joinRole = "战斗席 B";
    }
    else room.spectatorIds.push(player.id);
    socket.leave(lobbyChannel);
    socket.join(room.id);
    securityLog("room_joined", { sid: player.id, ip: player.ipAddress, roomId: room.id, event: "room:join", userAgent: socket.handshake.headers["user-agent"] });
    roomNotice(room, `${playerShortName(player)} 进入房间，位置：${joinRole}。`);
    maybeStartChoosing(room);
    reply?.({ room: roomSnapshot(room, { includeChat: true, includeHistory: true }) });
    broadcastRoom(room.id, true);
  });

  guardedOn(socket, "room:leave", { limit: 12, windowMs: 60_000, cooldownMs: 45_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return;
    const leaveResult = leaveRoom(player, "manual");
    if (!leaveResult.ok) return reply?.({ error: leaveResult.error });
    securityLog("room_left", { sid: player.id, ip: player.ipAddress, event: "room:leave", userAgent: socket.handshake.headers["user-agent"] });
    reply?.({ ok: true });
  });

  guardedOn(socket, "room:history", { limit: 30, windowMs: 60_000, cooldownMs: 30_000 }, ({ roomId, offset, limit }: { roomId: string; offset?: number; limit?: number }, reply) => {
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

  guardedOn(socket, "room:sit", { limit: 12, windowMs: 60_000, cooldownMs: 30_000 }, ({ seat }: { seat: SeatKey }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.phase === "punishment") return reply?.({ error: "惩罚完成前不能切换座位" });
    const rankedRestriction = rankedSeatRestrictionText(room, player);
    if (rankedRestriction) return reply?.({ error: rankedRestriction });
    if (room.seats[seat]) return reply?.({ error: "这个战斗席已经有人了" });
    const oldSeat = seatOf(room, player.id);
    // 如果本局已经有人出拳，已坐下的玩家不能换座躲避本局。
    // 但空战斗席仍允许观战/新加入玩家补位，否则会出现“一边已出拳，另一边空位永远坐不上”的卡房间问题。
    if (oldSeat && room.settings.gameId === "othello" && room.phase === "choosing") return reply?.({ error: "黑白棋对局进行中不能换座" });
    if (oldSeat && room.settings.gameId === "tictactoe" && room.phase === "choosing") return reply?.({ error: "井字棋对局进行中不能换座" });
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
    if (room.settings.gameId === "othello" && room.seats.A && room.seats.B && room.phase !== "choosing") resetOthelloRoom(room);
    else if (room.settings.gameId === "tictactoe" && room.seats.A && room.seats.B && room.phase !== "choosing") resetTicTacToeRoom(room);
    else maybeStartChoosing(room);
    broadcastRoom(room.id, true);
  });

  guardedOn(socket, "room:spectate", { limit: 12, windowMs: 60_000, cooldownMs: 30_000 }, (_payload, reply) => {
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

  guardedOn(socket, "room:move", { limit: 20, windowMs: 10_000, cooldownMs: 20_000 }, ({ move }: { move: Move }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "rps") return reply?.({ error: "当前玩法不能出拳" });
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

  guardedOn(socket, "othello:ready", { limit: 12, windowMs: 60_000, cooldownMs: 30_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋" });
    const seat = seatOf(room, player.id);
    if (!seat) return reply?.({ error: "只有战斗席玩家可以准备" });
    if (!room.seats.A || !room.seats.B) return reply?.({ error: "需要双方都坐下才能准备" });
    if (room.phase !== "ready") return reply?.({ error: "当前不能准备" });
    room.ready[seat] = true;
    roomNotice(room, `${playerShortName(player)} 已准备黑白棋。`);
    reply?.({ ok: true });
    scheduleOthelloReadyStart(room);
    broadcastRoom(room.id, true);
  });

  guardedOn(socket, "othello:move", { limit: 30, windowMs: 10_000, cooldownMs: 15_000 }, ({ row, col }: { row: number; col: number }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋" });
    const seat = seatOf(room, player.id);
    if (!seat) return reply?.({ error: "只有战斗席玩家可以落子" });
    if (!room.seats.A || !room.seats.B) return reply?.({ error: "需要双方都坐下才能开始" });
    const result = applyOthelloMove(room, seat, Number(row), Number(col));
    if (!result.ok) return reply?.({ error: result.error });
    broadcastRoom(room.id, true);
    reply?.({ ok: true });
  });

  guardedOn(socket, "othello:settleMove", { limit: 12, windowMs: 60_000, cooldownMs: 3_000 }, ({ mode }: { mode: "normal" | "giveaway" | "tribute" }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋" });
    if (mode !== "normal" && mode !== "giveaway" && mode !== "tribute") return reply?.({ error: "结算选择无效" });
    const seat = seatOf(room, player.id);
    if (!seat) return reply?.({ error: "只有战斗席玩家可以结算本手" });
    const pending = room.othello?.pendingSettlement;
    if (!pending) return reply?.({ error: "当前没有待结算落子" });
    if (pending.seat !== seat) return reply?.({ error: "只能由本手落子玩家选择" });
    if (pending.forced) return reply?.({ error: "本手已触发强制结算，不能改选" });
    const result = settleOthelloPendingMove(room, mode, "choice");
    if (!result.ok) return reply?.({ error: result.error });
    reply?.({ ok: true });
    broadcastRoom(room.id, true);
  });

  function requestOthelloSurrender(reply?: (payload: unknown) => void) {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋" });
    const fromSeat = seatOf(room, player.id);
    if (!fromSeat) return reply?.({ error: "只有战斗席玩家可以申请认输" });
    if (!room.othello || room.phase !== "choosing" || room.othello.ended) return reply?.({ error: "当前不能申请认输" });
    if (room.othello.pendingSettlement) return reply?.({ error: "本手白给/上贡结算完成前不能申请认输" });
    const toSeat = oppositeSeat(fromSeat);
    if (!room.seats[toSeat]) return reply?.({ error: "对手不在战斗席，不能申请认输" });
    if (room.othello.surrenderRequest?.fromSeat === fromSeat) return reply?.({ error: "你已经申请认输，正在等待对方确认" });
    if (room.othello.surrenderRequest) return reply?.({ error: "当前已有认输请求，请先处理" });
    room.othello.surrenderRequest = { fromSeat, toSeat, createdAt: Date.now() };
    roomNotice(room, `${playerShortName(player)} 申请认输，等待对方确认。`);
    reply?.({ ok: true });
    broadcastRoom(room.id, true);
  }

  guardedOn(socket, "othello:requestSurrender", { limit: 5, windowMs: 60_000, cooldownMs: 8_000 }, (_payload, reply) => {
    requestOthelloSurrender(reply);
  });

  guardedOn(socket, "othello:surrender", { limit: 5, windowMs: 60_000, cooldownMs: 8_000 }, (_payload, reply) => {
    requestOthelloSurrender(reply);
  });

  guardedOn(socket, "othello:respondSurrender", { limit: 8, windowMs: 60_000, cooldownMs: 5_000 }, ({ accept }: { accept?: boolean }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋" });
    const seat = seatOf(room, player.id);
    if (!seat) return reply?.({ error: "只有战斗席玩家可以处理认输请求" });
    if (!room.othello || room.phase !== "choosing" || room.othello.ended) return reply?.({ error: "当前不能处理认输请求" });
    const request = room.othello.surrenderRequest;
    if (!request) return reply?.({ error: "当前没有认输请求" });
    if (request.toSeat !== seat) return reply?.({ error: "这个认输请求不是发给你的" });
    const loserSeat = request.fromSeat;
    const winnerSeat = request.toSeat;
    const loserName = occupantName(room.seats[loserSeat]);
    const winnerName = occupantName(room.seats[winnerSeat]);
    if (!accept) {
      room.othello.surrenderRequest = undefined;
      roomNotice(room, `${winnerName} 拒绝认输，对局继续。`);
      reply?.({ ok: true });
      broadcastRoom(room.id, true);
      return;
    }
    const result = forceEndOthelloGame(room, winnerSeat, {
      label: `${loserName}认输，${winnerName}胜利`,
      historyNote: "认输",
      notice: `${winnerName} 同意 ${loserName} 认输，本局结束。`,
      forfeitRankedFloor: true
    });
    if (!result.ok) return reply?.({ error: result.error });
    reply?.({ ok: true });
    broadcastRoom(room.id, true);
  });

  guardedOn(socket, "othello:escape", { limit: 3, windowMs: 60_000, cooldownMs: 20_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋" });
    const loserSeat = seatOf(room, player.id);
    if (!loserSeat) return reply?.({ error: "只有战斗席玩家可以逃跑" });
    if (!room.othello || room.phase !== "choosing" || room.othello.ended) return reply?.({ error: "当前不能逃跑" });
    if (room.othello.pendingSettlement) return reply?.({ error: "本手白给/上贡结算完成前不能逃跑" });
    const winnerSeat = oppositeSeat(loserSeat);
    if (!room.seats[winnerSeat]) return reply?.({ error: "对手不在战斗席，不能逃跑" });
    const loserName = playerShortName(player);
    const winnerName = occupantName(room.seats[winnerSeat]);
    const result = forceEndOthelloGame(room, winnerSeat, {
      label: `${loserName}逃跑，${winnerName}胜利`,
      historyNote: "逃跑",
      notice: `${loserName} 选择逃跑，本局立即判负。`,
      forfeitRankedFloor: true,
      escapePenaltyRatio: 0.5,
      escapePenaltyLabel: "逃跑"
    });
    if (!result.ok) return reply?.({ error: result.error });
    reply?.({ ok: true });
    broadcastRoom(room.id, true);
  });

  guardedOn(socket, "othello:restart", { limit: 8, windowMs: 60_000, cooldownMs: 30_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋" });
    if (!seatOf(room, player.id)) return reply?.({ error: "只有战斗席玩家可以重新开始" });
    if (!room.seats.A || !room.seats.B) return reply?.({ error: "需要双方都坐下才能重新开始" });
    if (room.phase === "punishment") return reply?.({ error: "惩罚完成前不能重新开始" });
    resetOthelloRoom(room);
    roomNotice(room, `${playerShortName(player)} 发起黑白棋再来一局，请双方准备。`);
    broadcastRoom(room.id, true);
    reply?.({ ok: true });
  });

  guardedOn(socket, "tictactoe:ready", { limit: 12, windowMs: 60_000, cooldownMs: 30_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "tictactoe") return reply?.({ error: "当前房间不是井字棋" });
    const seat = seatOf(room, player.id);
    if (!seat) return reply?.({ error: "只有战斗席玩家可以准备" });
    if (!room.seats.A || !room.seats.B) return reply?.({ error: "需要双方都坐下才能准备" });
    if (room.phase !== "ready") return reply?.({ error: "当前不能准备" });
    room.ready[seat] = true;
    roomNotice(room, `${playerShortName(player)} 已准备井字棋。`);
    reply?.({ ok: true });
    scheduleTicTacToeReadyStart(room);
    broadcastRoom(room.id, true);
  });

  guardedOn(socket, "tictactoe:move", { limit: 30, windowMs: 10_000, cooldownMs: 15_000 }, ({ row, col }: { row: number; col: number }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "tictactoe") return reply?.({ error: "当前房间不是井字棋" });
    const seat = seatOf(room, player.id);
    if (!seat) return reply?.({ error: "只有战斗席玩家可以落子" });
    if (!room.seats.A || !room.seats.B) return reply?.({ error: "需要双方都坐下才能开始" });
    const result = applyTicTacToeMove(room, seat, Number(row), Number(col));
    if (!result.ok) return reply?.({ error: result.error });
    reply?.({ ok: true });
    broadcastRoom(room.id, true);
  });

  guardedOn(socket, "tictactoe:giveawayChoice", { limit: 20, windowMs: 10_000, cooldownMs: 15_000 }, ({ mode }: { mode: "normal" | "giveaway" }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "tictactoe") return reply?.({ error: "当前房间不是井字棋" });
    if (!room.tictactoe) return reply?.({ error: "井字棋还没有开始" });
    const seat = seatOf(room, player.id);
    if (!seat) return reply?.({ error: "只有战斗席玩家可以选择白给" });
    if (room.phase !== "choosing" || room.tictactoe.ended) return reply?.({ error: "当前不能选择白给" });
    if (room.tictactoe.turn !== seat) return reply?.({ error: "还没轮到你落子" });
    const prompt = room.tictactoe.giveawayPrompt;
    if (!prompt || prompt.seat !== seat) return reply?.({ error: "当前没有井字棋白给选择" });
    if (prompt.forced) return reply?.({ error: "强制白给中，系统正在随机落子" });
    if (mode !== "normal" && mode !== "giveaway") return reply?.({ error: "白给选择不正确" });
    if (mode === "normal") {
      clearTicTacToeGiveawayTimer(room.id);
      room.tictactoe = { ...room.tictactoe, giveawayPrompt: undefined };
      room.resultText = `${playerShortName(player)} 选择不白给，请正常落子。`;
      reply?.({ ok: true });
      broadcastRoom(room.id, true);
      return;
    }
    const result = applyTicTacToeRandomMove(room, seat, "giveaway");
    if (!result.ok) return reply?.({ error: result.error });
    roomNotice(room, `${playerShortName(player)} 选择白给落子，系统随机落在第 ${result.row! + 1} 行第 ${result.col! + 1} 列。`);
    reply?.({ ok: true });
    broadcastRoom(room.id, true);
  });

  guardedOn(socket, "tictactoe:restart", { limit: 8, windowMs: 60_000, cooldownMs: 30_000 }, (_payload, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room) return reply?.({ error: "你不在房间中" });
    if (room.settings.gameId !== "tictactoe") return reply?.({ error: "当前房间不是井字棋" });
    if (!seatOf(room, player.id)) return reply?.({ error: "只有战斗席玩家可以重新开始" });
    if (!room.seats.A || !room.seats.B) return reply?.({ error: "需要双方都坐下才能重新开始" });
    if (room.phase === "punishment") return reply?.({ error: "惩罚完成前不能重新开始" });
    resetTicTacToeRoom(room);
    roomNotice(room, `${playerShortName(player)} 发起井字棋再来一局，请双方准备。`);
    broadcastRoom(room.id, true);
    reply?.({ ok: true });
  });

  guardedOn(socket, "punishment:submit", { limit: 8, windowMs: 60_000, cooldownMs: 60_000 }, ({ text, imageUrl }: { text: string; imageUrl?: string }, reply) => {
    const player = getPlayer(socket.id);
    const room = player?.roomId ? rooms.get(player.roomId) : undefined;
    if (!player || !room || !room.punishedPlayerIds.includes(player.id)) return reply?.({ error: "你当前不需要提交惩罚" });
    const cleanProofText = cleanText(text, 500);
    const cleanImageUrl = safeUploadUrl(imageUrl);
    if (!cleanProofText) return reply?.({ error: "请填写文字证明" });
    if (imageUrl && !cleanImageUrl) return reply?.({ error: "图片地址无效" });
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
      text: cleanProofText,
      imageUrl: cleanImageUrl,
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
      text: cleanProofText,
      imageUrl: cleanImageUrl,
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

  guardedOn(socket, "punishment:assignTask", { limit: 10, windowMs: 60_000, cooldownMs: 45_000 }, ({ playerId, taskText }: { playerId: string; taskText: string }, reply) => {
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
    const cleanTask = cleanText(taskText, 300);
    if (!cleanTask) return reply?.({ error: "请填写惩罚任务" });
    updatePunishmentTask(room, playerId, cleanTask, player);
    broadcastRoom(room.id);
    reply?.({ ok: true });
  });

  guardedOn(socket, "punishment:review", { limit: 15, windowMs: 60_000, cooldownMs: 45_000 }, ({ playerId, action, redoTaskText }: { playerId: string; action: "approve" | "forgive" | "reject"; redoTaskText?: string }, reply) => {
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
      const cleanTask = cleanText(redoTaskText, 300);
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

  guardedOn(socket, "punishment:confirm", { limit: 15, windowMs: 60_000, cooldownMs: 45_000 }, ({ playerId }: { playerId: string }, reply) => {
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

  guardedOn(socket, "chat:send", { limit: 20, windowMs: 60_000, cooldownMs: 30_000 }, ({ roomId, text }: { roomId?: string; text: string }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入游戏" });
    const cleanMessageText = cleanText(text, 300);
    if (!cleanMessageText) return reply?.({ error: "请输入聊天内容" });
    refreshNameWarState(player);
    refreshPlayerSnapshots(player);
    const message: ChatMessage = {
      id: randomId(),
      roomId,
      playerId: player.id,
      author: player.displayName,
      authorPlayer: publicPlayer(player),
      text: cleanMessageText,
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
      emitLobbyChatAppend(message);
    }
    reply?.({ ok: true });
  });

  guardedOn(socket, "suggestion:add", { limit: 5, windowMs: 60_000, cooldownMs: 60_000 }, ({ text }: { text: string }, reply) => {
    const player = getPlayer(socket.id);
    if (!player) return reply?.({ error: "请先进入游戏" });
    const cleanSuggestionText = cleanText(text, 500);
    if (!cleanSuggestionText) return reply?.({ error: "请输入留言内容" });
    const suggestion = { id: randomId(), playerId: player.id, author: player.displayName, authorPlayer: publicPlayer(player), text: cleanSuggestionText, at: Date.now() };
    appendSuggestion(suggestion);
    io.to(lobbySuggestionChannel).emit("suggestion:append", suggestion);
    reply?.({ ok: true });
  });

  guardedOn(socket, "admin:action", { limit: 30, windowMs: 60_000, cooldownMs: 60_000 }, ({ action, roomId, playerId, name, rankedPoints, title, message, durationSeconds, othelloResult }: { action: string; roomId?: string; playerId?: string; name?: string; rankedPoints?: number | string; title?: string; message?: string; durationSeconds?: number | string; othelloResult?: RoundResult }, reply) => {
    const admin = getPlayer(socket.id);
    if (!admin?.isAdmin && !adminSocketIds.has(socket.id)) return reply?.({ error: "需要管理员权限" });
    let roomDeleted = false;
    let changedPlayerRoomId: string | undefined;
    if (action === "clearSuggestions") suggestions.length = 0;
    if (action === "clearLobbyChat") lobbyChat.length = 0;
    if (action === "broadcastAnnouncement") {
      const cleanMessage = cleanText(message, 200);
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
        clearOthelloSettlementTimer(roomId);
        clearRoomBroadcastTimer(roomId);
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
    if (action === "forceOthelloRestart" && roomId) {
      const room = rooms.get(roomId);
      if (!room || room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋房间" });
      flushOthelloPendingSettlement(room);
      resetOthelloRoom(room);
      roomNotice(room, "管理员已重开黑白棋对局。");
    }
    if (action === "forceOthelloEnd" && roomId) {
      const room = rooms.get(roomId);
      if (!room || room.settings.gameId !== "othello") return reply?.({ error: "当前房间不是黑白棋房间" });
      if (othelloResult !== "A" && othelloResult !== "B" && othelloResult !== "draw") return reply?.({ error: "请选择黑方胜、白方胜或平局" });
      const forcedResult: RoundResult = othelloResult === "draw"
        ? "draw"
        : room.othello?.blackSeat
          ? othelloResult === "A" ? room.othello.blackSeat : oppositeSeat(room.othello.blackSeat)
          : othelloResult;
      const result = forceEndOthelloGame(room, forcedResult);
      if (!result.ok) return reply?.({ error: result.error });
    }
    if (action === "kick" && playerId) {
      const player = players.get(playerId);
      if (player) {
        leaveRoom(player, "adminKick");
        clearDisconnectHold(player);
        players.delete(player.id);
        tokenToPlayerId.delete(player.token);
        if (player.playerId) playerIdToId.delete(player.playerId);
        if (player.currentSid && sidToPlayerId.get(player.currentSid) === player.id) sidToPlayerId.delete(player.currentSid);
        if (player.persistent) requestPersist("important");
        if (player.socketId) io.to(player.socketId).emit("player:kicked");
      }
    }
    if (action === "editPlayer" && playerId) {
      const player = players.get(playerId);
      if (!player) return reply?.({ error: "玩家不存在" });
      const cleanName = cleanText(name, 12);
      const cleanTitle = cleanText(title, 18);
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
    const sid = socketIdToSid.get(socket.id);
    const ipAddress = String(socket.data.ipAddress || socketIp(socket));
    if (sidToSocketId.get(String(sid)) === socket.id) sidToSocketId.delete(String(sid));
    socketIdToSid.delete(socket.id);
    const socketsForIp = socketIdsByIp.get(ipAddress);
    if (socketsForIp) {
      socketsForIp.delete(socket.id);
      if (socketsForIp.size === 0) socketIdsByIp.delete(ipAddress);
    }
    adminSocketIds.delete(socket.id);
    const player = getPlayer(socket.id);
    if (!player) return;
    securityLog("socket_disconnected", { sid: player.id, ip: ipAddress, socketId: socket.id, userAgent: socket.handshake.headers["user-agent"] });
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
      current.disconnectedAt = Date.now();
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
        // 释放过期的 sid 映射；sid/token 可以销毁，但持久玩家档案保留。
        if (expired.currentSid && sidToPlayerId.get(expired.currentSid) === expired.id) {
          sidToPlayerId.delete(expired.currentSid);
        }
        if (expired.persistent) {
          // 持久玩家：超过可见倒计时后只清掉房间/座位保护，不删除档案。
          // 否则玩家稍后回来时会被当成新玩家，积分和战绩看起来像“莫名清零”。
          expired.lastSeenAt = Date.now();
          requestPersist("lazy");
        } else {
          // 临时游客：没有长期身份，超时后回收，避免内存泄漏。
          players.delete(expired.id);
          tokenToPlayerId.delete(expired.token);
        }
        expired.disconnectExpiresAt = undefined;
        expired.disconnectTimer = undefined;
        broadcastLobby();
      }, 60_000);
    }, 30_000);
  });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, flushing players...`);
  try {
    await flushPersist();
  } catch (err) {
    console.error("[players] flush on shutdown failed:", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
// 兜底：周期性地把待写入的快照落盘，避免依赖单一触发点。
setInterval(() => void flushPersist(), 60_000).unref?.();

loadPlayersFromDisk().finally(() => {
  server.listen(port, host, () => {
    scheduleExtremeHourlyDecay();
    console.log(`RPS Online server listening on http://${host}:${port}`);
  });
});

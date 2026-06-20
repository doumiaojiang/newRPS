import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, useEffect, useRef, useState } from "react";
import { Coffee, Crown, DoorOpen, Download, ExternalLink, Eye, HeartHandshake, MessageCircle, Moon, Pencil, RefreshCcw, Save, Send, Settings, Shield, Sun, Swords, Upload, UserRound, Users } from "lucide-react";
import { socket } from "./main";
import type { AppConfig, BotDifficulty, ChatMessage, GenderFaction, LobbySnapshot, Move, PublicPlayer, PunishmentTaskConfig, RoomInfoTagStyle, RoomNamePool, RoomSettings, RoomSnapshot, RoundResult, SeatKey, SeatOccupant } from "../shared/types";

const tokenKey = "rps-online-token";
const playerIdKey = "rps-player-id";
const playerSecretKey = "rps-player-secret";
const dailyAnnouncementKey = "rps-online-daily-announcement";
const defaultRoomName = "新的锤子剪刀布房间";
const defaultOthelloRoomName = "新的黑白棋房间";
const defaultTicTacToeRoomName = "新的井字棋房间";
const maxImageUploadBytes = 8 * 1024 * 1024;
const leaderboardRefreshMs = 10 * 60 * 1000;
const othelloBoardThemes = [
  { id: "classic", name: "经典绿", description: "传统棋盘，最清楚耐看。", board: "#2f8a64", cell: "#38a474", line: "rgba(18, 72, 52, 0.55)", hover: "#45b883", border: "#2f7a5c", blackDisc: "radial-gradient(circle at 32% 28%, #5f6670, #10151a 64%)", whiteDisc: "radial-gradient(circle at 32% 28%, #ffffff, #d8e1e8 70%)", blackRing: "#e3eef5", whiteRing: "#2b4f40" },
  { id: "pastel", name: "粉蓝白", description: "柔和一点，适合夜里轻松玩。", board: "#d8f0ff", cell: "#f8d7e9", line: "rgba(81, 124, 155, 0.35)", hover: "#e9f7ff", border: "#8fc7e8", blackDisc: "radial-gradient(circle at 32% 28%, #526070, #101821 66%)", whiteDisc: "radial-gradient(circle at 32% 28%, #ffffff, #f2f7ff 72%)", blackRing: "#ffffff", whiteRing: "#6f8aa4" },
  { id: "midnight", name: "深夜蓝", description: "暗色棋盘，不刺眼。", board: "#172339", cell: "#24395d", line: "rgba(159, 190, 255, 0.24)", hover: "#2f4a78", border: "#6b8dd6", blackDisc: "radial-gradient(circle at 32% 28%, #707b90, #090d16 66%)", whiteDisc: "radial-gradient(circle at 32% 28%, #ffffff, #d9ecff 72%)", blackRing: "#8fb2ff", whiteRing: "#ffffff" },
  { id: "wood", name: "木纹棕", description: "温暖桌游感。", board: "#9a6a3d", cell: "#b8844d", line: "rgba(78, 46, 20, 0.45)", hover: "#c89459", border: "#7a4e2a", blackDisc: "radial-gradient(circle at 32% 28%, #695b50, #17100b 66%)", whiteDisc: "radial-gradient(circle at 32% 28%, #fff9ec, #ead6b9 72%)", blackRing: "#f0d09d", whiteRing: "#6d4324" },
  { id: "neon", name: "霓虹紫", description: "更游戏感，适合整活。", board: "#24133e", cell: "#43206f", line: "rgba(244, 157, 255, 0.34)", hover: "#5b2b94", border: "#f49dff", blackDisc: "radial-gradient(circle at 32% 28%, #7f6d94, #0e0718 66%)", whiteDisc: "radial-gradient(circle at 32% 28%, #ffffff, #f4d7ff 72%)", blackRing: "#f49dff", whiteRing: "#ffffff" }
] as const;
type OthelloBoardThemeId = typeof othelloBoardThemes[number]["id"];
const tictactoeBoardThemes = [
  { id: "paper", name: "纸面白", description: "干净清楚，像便签纸。", board: "#f0d18f", cell: "#fffaf0", line: "#d6aa55", hover: "#fff2cf", border: "#c68b32", x: "#2f6f9f", o: "#9d3860", win: "#ffe082" },
  { id: "mint", name: "薄荷绿", description: "清爽一点，不刺眼。", board: "#8bd7bc", cell: "#effdf7", line: "#58b395", hover: "#dcf8ee", border: "#3a9c7e", x: "#176d86", o: "#b64268", win: "#bdf3cd" },
  { id: "midnight", name: "夜间蓝", description: "晚上玩更舒服。", board: "#172339", cell: "#223553", line: "#48628d", hover: "#2f466c", border: "#6b8dd6", x: "#74c7ff", o: "#ff9fc2", win: "#4c416c" },
  { id: "candy", name: "糖果粉", description: "偏可爱，适合轻松局。", board: "#f7b6d2", cell: "#fff4fb", line: "#ea86b5", hover: "#ffe4f2", border: "#d65c98", x: "#4f83c7", o: "#c93674", win: "#ffe6a8" },
  { id: "arcade", name: "街机紫", description: "更亮一点，有游戏感。", board: "#24133e", cell: "#351a5b", line: "#7a42c8", hover: "#43206f", border: "#f49dff", x: "#6ff7ff", o: "#ff78d2", win: "#64427f" }
] as const;
type TicTacToeBoardThemeId = typeof tictactoeBoardThemes[number]["id"];
const sponsorLinks = [
  { id: "x", label: "X", title: "关注 X 账号", description: "看更新、吐槽和临时公告。", href: "https://x.com/home", icon: "𝕏", tone: "#111827" },
  { id: "telegram", label: "TG", title: "加入 TG 群", description: "一起聊天、反馈 bug、催新玩法。", href: "https://t.me/+X1Jr4GPxgIwzOWY1", icon: "✈", tone: "#229ed9" },
  { id: "afdian", label: "爱发电", title: "爱发电支持", description: "国内赞助入口，支持一点服务器电费。", href: "https://afdian.com/a/doumiaojiang", icon: "⚡", tone: "#946cff" },
  { id: "patreon", label: "Patreon", title: "Patreon", description: "海外赞助入口，适合长期支持。", href: "https://www.patreon.com/customize?step=navigation", icon: "P", tone: "#ff424d" },
  { id: "coffee", label: "Coffee", title: "来一杯咖啡", description: "请作者喝杯咖啡，继续加玩法。", href: "https://buymeacoffee.com/doumiaojiang", icon: "☕", tone: "#f2b84b" }
] as const;

function randomUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // 兜底：旧浏览器没有 crypto.randomUUID 时，用 getRandomValues 拼一个 v4 UUID。
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// 长期身份：playerId + playerSecret 一旦生成就长期保存在本地，和短期的 session token 解耦。
// 积分、战绩、称号只跟 playerId 走，token 过期/重发都不会清空玩家档案。
function ensurePlayerIdentity() {
  let playerId = localStorage.getItem(playerIdKey);
  let playerSecret = localStorage.getItem(playerSecretKey);
  if (!playerId || !playerSecret) {
    playerId = randomUuid();
    playerSecret = `${randomUuid()}-${randomUuid()}`;
    localStorage.setItem(playerIdKey, playerId);
    localStorage.setItem(playerSecretKey, playerSecret);
  }
  return { playerId, playerSecret };
}

async function ensureSessionToken() {
  const existing = localStorage.getItem(tokenKey);
  if (existing && existing.split(".").length === 3) return existing;
  if (existing) localStorage.removeItem(tokenKey);
  const response = await fetch("/api/session", { method: "POST" });
  const data = await response.json();
  if (!response.ok || !data.token) throw new Error(data.message || "Session failed");
  localStorage.setItem(tokenKey, data.token);
  return String(data.token);
}

async function connectSocketWithSession() {
  const token = await ensureSessionToken();
  socket.auth = { token };
  if (!socket.connected) socket.connect();
  return token;
}

type MeState = { player: PublicPlayer; token: string; roomId?: string; room?: RoomSnapshot };
type AnnouncementPayload = { id: string; message: string; durationMs: number; createdAt: number };

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dailyAnnouncementSeenKey(config: AppConfig) {
  const daily = config.dailyAnnouncement;
  return `${todayKey()}|${daily.version}|${daily.title}|${daily.content}`;
}

function isAdminRoute() {
  return window.location.hash === "#admin" || window.location.pathname.replace(/\/$/, "").endsWith("/admin");
}

function ask<T>(event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (response: T & { error?: string }) => {
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

function appendCappedUnique<T extends { id: string }>(items: T[], item: T, max: number) {
  if (items.some((old) => old.id === item.id)) return items;
  return [...items, item].slice(-max);
}

function prependCappedUnique<T extends { id: string }>(items: T[], item: T, max: number) {
  if (items.some((old) => old.id === item.id)) return items;
  return [item, ...items].slice(0, max);
}

function isNearScrollBottom(element: HTMLElement, threshold = 72) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
}

function scrollToBottomSoon(element: HTMLElement) {
  window.requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
  });
}

function stickChatToBottom(element: HTMLElement | null, stickRef: MutableRefObject<boolean>, setSticking: (value: boolean) => void) {
  if (!element) return;
  stickRef.current = true;
  setSticking(true);
  scrollToBottomSoon(element);
}

async function compressImageForUpload(file: File) {
  if (!file.type.startsWith("image/")) return file;
  const bitmap = await createImageBitmap(file);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close?.();
    return file;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", 0.82);
  }) ?? await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.86);
  });
  if (!blob || blob.size >= file.size) return file;
  const extension = blob.type === "image/webp" ? "webp" : "jpg";
  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${baseName}-compressed.${extension}`, { type: blob.type, lastModified: Date.now() });
}

function playerSyncKey(player: PublicPlayer) {
  return [
    player.name,
    player.displayName,
    player.genderId,
    player.genderLabel,
    player.factionId,
    player.connected ? "1" : "0",
    player.disconnectedAt || 0,
    player.disconnectExpiresAt || 0,
    player.stats.wins,
    player.stats.losses,
    player.stats.draws,
    player.stats.punishments,
    player.stats.rankedPoints,
    player.stats.title,
    player.nameWarEnabled ? "1" : "0",
    player.nameWarPunished ? "1" : "0",
    player.nameWarPenaltyName || "",
    player.nameWarAllowRename ? "1" : "0",
    player.nameWarRenameProtectedUntil || 0,
    player.nameWarRenamedBy || "",
    player.nameWarRenamedByName || "",
    player.nameWarRenameWindowStartedAt || 0,
    player.nameWarRenameCount || 0,
    player.giveawayEnabled ? "1" : "0",
    player.giveawayValue || 0,
    player.giveawayClicks || 0,
    player.giveawayBoardText || "",
    player.giveawayBoardExpiresAt || 0,
    player.giveawayBoardLikes || 0,
    player.giveawayBoardDislikes || 0,
    player.giveawayVoteWindowStartedAt || 0,
    player.giveawayVoteCount || 0,
    player.giveawayVoteLikesThisHour || 0,
    player.giveawayVoteDislikesThisHour || 0,
    player.rankMultiplierUnlocked ? "1" : "0",
    player.extremeModeEnabled ? "1" : "0",
    player.extremeModeToggledAt || 0,
    player.extremeModeCooldownUntil || 0,
    player.extremeWinStreak || 0,
    player.extremeLastDecayHour || 0,
    player.extremeForceClosed ? "1" : "0",
    player.extremeForceClosedAt || 0,
    player.extremeRenameProtectedUntil || 0,
    player.extremeRenamedBy || "",
    player.extremeRenamedByName || ""
  ].join("|");
}

function appendHistoryPage(oldItems: RoomSnapshot["roundHistory"], newItems: RoomSnapshot["roundHistory"], currentItems: RoomSnapshot["roundHistory"]) {
  const seen = new Set([...currentItems, ...oldItems].map((item) => item.id));
  return [...oldItems, ...newItems.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  })];
}

function playerWinRate(player: PublicPlayer) {
  const decisive = player.stats.wins + player.stats.losses;
  return decisive === 0 ? 0 : player.stats.wins / decisive;
}

function rankedPlayers(players: PublicPlayer[]) {
  return players
    .filter((player) => player.connected)
    .sort((a, b) => b.stats.rankedPoints - a.stats.rankedPoints || b.stats.wins - a.stats.wins);
}

function normalWinRatePlayers(players: PublicPlayer[]) {
  return players
    .filter((player) => player.stats.wins + player.stats.losses + player.stats.draws >= 5)
    .sort((a, b) => playerWinRate(b) - playerWinRate(a) || b.stats.wins - a.stats.wins)
    .slice(0, 10);
}

function replacePlayerInRoom(room: RoomSnapshot, player: PublicPlayer) {
  let changed = false;
  const seats = { ...room.seats };
  for (const seat of ["A", "B"] as SeatKey[]) {
    const occupant = seats[seat];
    if (occupant?.id === player.id && !("isBot" in occupant)) {
      seats[seat] = player;
      changed = true;
    }
  }
  const spectators = room.spectators.map((spectator) => {
    if (spectator.id !== player.id) return spectator;
    changed = true;
    return player;
  });
  return changed ? { ...room, seats, spectators } : room;
}

function replaceLobbyVersusPlayer(versus: LobbySnapshot["rooms"][number]["versus"], player: PublicPlayer) {
  return {
    A: versus.A && !("isBot" in versus.A) && versus.A.player.id === player.id ? { player } : versus.A,
    B: versus.B && !("isBot" in versus.B) && versus.B.player.id === player.id ? { player } : versus.B
  };
}

function replacePlayerInLobby(lobby: LobbySnapshot, player: PublicPlayer) {
  const players = lobby.players.map((item) => item.id === player.id ? player : item);
  return {
    ...lobby,
    players,
    normalLeaderboard: normalWinRatePlayers(players),
    rankedLeaderboard: rankedPlayers(players),
    rooms: lobby.rooms.map((roomInfo) => ({
      ...roomInfo,
      versus: replaceLobbyVersusPlayer(roomInfo.versus, player)
    }))
  };
}

function normalizeLobbySnapshot(snapshot: LobbySnapshot, old?: LobbySnapshot | null) {
  const lobbyChat = snapshot.lobbyChat.length === 0 && old ? old.lobbyChat : snapshot.lobbyChat;
  return {
    ...snapshot,
    lobbyChat,
    normalLeaderboard: normalWinRatePlayers(snapshot.players),
    rankedLeaderboard: rankedPlayers(snapshot.players)
  };
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [leaderboardPlayersSnapshot, setLeaderboardPlayersSnapshot] = useState<PublicPlayer[]>([]);
  const [view, setView] = useState<"login" | "lobby" | "room" | "admin">(() => isAdminRoute() ? "admin" : "login");
  const [profileOpen, setProfileOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [sponsorOpen, setSponsorOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [announcement, setAnnouncement] = useState<AnnouncementPayload | null>(null);
  const [dailyAnnouncementOpen, setDailyAnnouncementOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<"connected" | "connecting" | "disconnected">(() => socket.connected ? "connected" : "connecting");
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("rps-online-theme") === "dark" ? "dark" : "light"));
  const restoreInFlightRef = useRef(false);
  const latestLobbyPlayersRef = useRef<PublicPlayer[]>([]);
  const leaderboardSnapshotAtRef = useRef(0);

  useEffect(() => {
    connectSocketWithSession().catch(() => {
      localStorage.removeItem(tokenKey);
      setConnectionState("disconnected");
      setNotice("连接认证失败，请刷新后重试。");
    });
  }, []);

  async function restoreSession(options: { showRecoveredNotice?: boolean; clearBadToken?: boolean } = {}) {
    if (restoreInFlightRef.current) return;
    const token = localStorage.getItem(tokenKey);
    const cachedName = localStorage.getItem("rps-online-name") || "";
    const cachedGender = localStorage.getItem("rps-online-gender") || "male";
    if (!token || !cachedName) return;
    restoreInFlightRef.current = true;
    try {
      const next = await ask<MeState>("player:join", { name: cachedName, genderId: cachedGender, token, ...ensurePlayerIdentity() });
      setMe(next);
      if (next.room) setRoom(next.room);
      else setRoom(null);
      if (!isAdminRoute()) {
        setView(next.room ? "room" : "lobby");
        if (next.room?.phase === "punishment") setNotice("已恢复到未完成的惩罚房间。");
        else if (options.showRecoveredNotice) setNotice("连接已恢复，玩家状态已同步。");
      }
    } catch {
      if (options.clearBadToken) localStorage.removeItem(tokenKey);
      if (options.showRecoveredNotice) setNotice("连接已恢复，但玩家状态同步失败，请刷新或重新进入。");
    } finally {
      restoreInFlightRef.current = false;
    }
  }

  function refreshLeaderboardSnapshot(players: PublicPlayer[], now = Date.now()) {
    latestLobbyPlayersRef.current = players;
    leaderboardSnapshotAtRef.current = now;
    setLeaderboardPlayersSnapshot(players);
  }

  useEffect(() => {
    socket.on("lobby:update", (nextLobby: LobbySnapshot) => {
      if (nextLobby.config) setConfig(nextLobby.config);
      latestLobbyPlayersRef.current = nextLobby.players;
      const now = Date.now();
      if (!leaderboardSnapshotAtRef.current || now - leaderboardSnapshotAtRef.current >= leaderboardRefreshMs) {
        refreshLeaderboardSnapshot(nextLobby.players, now);
      }
      setLobby((old) => normalizeLobbySnapshot(nextLobby, old));
    });
    socket.on("room:update", (nextRoom: RoomSnapshot) => {
      setRoom((old) => {
        if (old?.id === nextRoom.id && nextRoom.updatedAt < old.updatedAt) return old;
        if (old?.id === nextRoom.id) {
          return {
            ...nextRoom,
            chat: nextRoom.chat.length === 0 ? old.chat : nextRoom.chat,
            roundHistory: nextRoom.roundHistory.length === 0 ? old.roundHistory : nextRoom.roundHistory
          };
        }
        return nextRoom;
      });
      if (!isAdminRoute()) setView("room");
    });
    socket.on("room:historyAppend", ({ roomId, item, total }: { roomId: string; item: RoomSnapshot["roundHistory"][number]; total: number }) => {
      setRoom((old) => old?.id === roomId ? {
        ...old,
        roundHistory: prependCappedUnique(old.roundHistory, item, 20),
        roundHistoryTotal: total
      } : old);
    });
    socket.on("player:update", (player: PublicPlayer) => {
      latestLobbyPlayersRef.current = latestLobbyPlayersRef.current.map((item) => item.id === player.id ? player : item);
      setLobby((old) => old ? replacePlayerInLobby(old, player) : old);
      setRoom((old) => old ? replacePlayerInRoom(old, player) : old);
      setMe((old) => old?.player.id === player.id ? { ...old, player, room: old.room ? replacePlayerInRoom(old.room, player) : old.room } : old);
    });
    socket.on("player:kicked", () => {
      localStorage.removeItem(tokenKey);
      setMe(null);
      setRoom(null);
      setView("login");
      setNotice("你已被管理员移出。");
    });
    socket.on("room:closed", ({ message }: { message?: string }) => {
      setRoom(null);
      setMe((old) => old ? { ...old, roomId: undefined } : old);
      if (!isAdminRoute()) setView("lobby");
      setNotice(message || "房间已被管理员关闭。");
    });
    socket.on("config:update", (config: AppConfig) => {
      setConfig(config);
    });
    socket.on("chat:append", (message: ChatMessage) => {
      if (!message.roomId) {
        setLobby((old) => old ? { ...old, lobbyChat: appendCappedUnique(old.lobbyChat || [], message, 100) } : old);
        return;
      }
      setRoom((old) => {
        if (!old || message.roomId !== old.id) return old;
        return { ...old, chat: appendCappedUnique(old.chat, message, 200) };
      });
    });
    socket.on("suggestion:append", (suggestion: LobbySnapshot["suggestions"][number]) => {
      setLobby((old) => old ? { ...old, suggestions: prependCappedUnique(old.suggestions, suggestion, 100) } : old);
    });
    socket.on("announcement:show", (payload: AnnouncementPayload) => {
      setAnnouncement(payload);
    });
    socket.on("connect", () => {
      setConnectionState("connected");
      restoreSession({ showRecoveredNotice: true });
    });
    socket.on("disconnect", () => {
      setConnectionState("disconnected");
      setNotice("连接已断开，正在重连。");
    });
    socket.on("connect_error", (error: Error & { data?: { code?: string } }) => {
      setConnectionState("disconnected");
      const code = error?.data?.code;
      // 只有会话相关错误才清掉 token 重新换发；身份相关（playerId/secret）不清 token。
      if (code === "SESSION_INVALID" || code === "SESSION_EXPIRED" || code === "SESSION_MISSING" || !code) {
        localStorage.removeItem(tokenKey);
        connectSocketWithSession().catch(() => setConnectionState("disconnected"));
      }
    });
    socket.io.on("reconnect_attempt", () => setConnectionState("connecting"));
    return () => {
      socket.off("lobby:update");
      socket.off("room:update");
      socket.off("room:historyAppend");
      socket.off("player:update");
      socket.off("player:kicked");
      socket.off("room:closed");
      socket.off("config:update");
      socket.off("chat:append");
      socket.off("suggestion:append");
      socket.off("announcement:show");
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.io.off("reconnect_attempt");
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (latestLobbyPlayersRef.current.length) refreshLeaderboardSnapshot(latestLobbyPlayersRef.current);
    }, leaderboardRefreshMs);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("rps-online-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!config) return;
    if (!config.dailyAnnouncement.enabled) {
      setDailyAnnouncementOpen(false);
      return;
    }
    const seenKey = dailyAnnouncementSeenKey(config);
    setDailyAnnouncementOpen(localStorage.getItem(dailyAnnouncementKey) !== seenKey);
  }, [config]);

  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(null), announcement.durationMs);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  function closeDailyAnnouncement() {
    if (!config) return;
    localStorage.setItem(dailyAnnouncementKey, dailyAnnouncementSeenKey(config));
    setDailyAnnouncementOpen(false);
  }

  useEffect(() => {
    // 管理入口故意不放在普通页面按钮里：地址加 #admin，或按 Ctrl/Command + Shift + A。
    function openHiddenAdmin(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "a") {
        window.location.hash = "admin";
        setView("admin");
      }
    }
    function openFromHash() {
      if (isAdminRoute()) setView("admin");
    }
    if (isAdminRoute()) setView("admin");
    window.addEventListener("keydown", openHiddenAdmin);
    window.addEventListener("hashchange", openFromHash);
    return () => {
      window.removeEventListener("keydown", openHiddenAdmin);
      window.removeEventListener("hashchange", openFromHash);
    };
  }, []);

  useEffect(() => {
    restoreSession({ clearBadToken: true });
  }, []);

  useEffect(() => {
    if (!me || isAdminRoute()) return;
    ask(view === "room" ? "lobby:unsubscribe" : "lobby:subscribe", {}).catch(() => undefined);
  }, [view, me?.player.id]);

  useEffect(() => {
    if (!me || !lobby) return;
    const latest = lobby.players.find((player) => player.id === me.player.id);
    if (latest && playerSyncKey(latest) !== playerSyncKey(me.player)) {
      setMe((old) => old ? { ...old, player: latest } : old);
    }
  }, [lobby, me]);

  if (!config) return <div className="loading">正在连接服务器...</div>;
  const leaderboardSource = leaderboardPlayersSnapshot.length ? leaderboardPlayersSnapshot : lobby?.players || [];

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>{config.site.name}</h1>
          <span className="top-summary">{view === "room" && room ? `⚔️ ${phaseText(room.phase)}` : lobby ? `当前连接 ${lobby.onlineCount} 人` : "正在连接"}</span>
          <span className={`connection-pill ${connectionState}`}>{connectionStateText(connectionState)}</span>
        </div>
        <div className="top-actions">
          {me && <PlayerBadge player={me.player} compact />}
          <button className="soft-button top-sponsor-button" title="赞助支持" onClick={() => setSponsorOpen(true)}>
            <HeartHandshake size={18} /> <span>赞助</span>
          </button>
          {me && (
            <button className="soft-button top-profile-button" title="个人设置" onClick={() => setProfileOpen(true)}>
              <UserRound size={18} /> <span>个人设置</span>
            </button>
          )}
          {me && lobby && (
            <button className="soft-button top-leaderboard-button" title="排行榜" onClick={() => setLeaderboardOpen(true)}>
              <Crown size={18} /> <span>排行榜</span>
            </button>
          )}
          <button className="icon-button" title={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      {notice && <div className="notice">{notice}</div>}
      {announcement && (
        <div className="announcement-popup" role="alert">
          <div>
            <b>全服公告</b>
            <p>{announcement.message}</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭公告" onClick={() => setAnnouncement(null)}>×</button>
        </div>
      )}
      {dailyAnnouncementOpen && (
        <div className="daily-announcement-backdrop" role="dialog" aria-modal="true" aria-labelledby="daily-announcement-title">
          <section className="daily-announcement-card">
            <div>
              <span className="daily-announcement-kicker">📢 每日公告</span>
              <h2 id="daily-announcement-title">{config.dailyAnnouncement.title}</h2>
              <p>{config.dailyAnnouncement.content}</p>
            </div>
            <button className="primary" type="button" onClick={closeDailyAnnouncement}>{config.dailyAnnouncement.buttonText}</button>
          </section>
        </div>
      )}
      {view === "login" && <Login config={config} onDone={(next) => {
        setMe(next);
        if (next.room) setRoom(next.room);
        setView(isAdminRoute() ? "admin" : next.room ? "room" : "lobby");
        if (next.room?.phase === "punishment") setNotice("已恢复到未完成的惩罚房间。");
      }} onError={setNotice} />}
      {view === "lobby" && me && lobby && <Lobby config={config} lobby={lobby} me={me.player} onError={setNotice} onGoRoom={(nextRoom) => { if (nextRoom) setRoom(nextRoom); setView("room"); }} />}
      {view === "room" && me && room && <Room config={config} room={room} lobbySuggestions={lobby?.suggestions || []} me={me.player} onBack={() => setView("lobby")} onError={setNotice} />}
      {view === "admin" && lobby && <AdminPanel config={config} lobby={lobby} onBack={() => { if (window.location.hash === "#admin") window.location.hash = ""; setView(me ? "lobby" : "login"); }} onError={setNotice} />}
      {view === "room" && !room && <section className="panel">你暂时不在房间里。</section>}
      {sponsorOpen && <SponsorPanel onClose={() => setSponsorOpen(false)} />}
      {profileOpen && me && <ProfilePanel config={config} me={me.player} onClose={() => setProfileOpen(false)} onUpdated={(player) => { setMe({ ...me, player }); localStorage.setItem("rps-online-name", player.name); localStorage.setItem("rps-online-gender", player.genderId); }} onError={setNotice} />}
      {leaderboardOpen && <GlobalLeaderboardPanel players={leaderboardSource} onClose={() => setLeaderboardOpen(false)} />}
    </main>
  );
}

function Login({ config, onDone, onError }: { config: AppConfig; onDone: (me: MeState) => void; onError: (message: string) => void }) {
  const [name, setName] = useState("");
  const [genderId, setGenderId] = useState(firstGenderId(config));

  async function submit() {
    try {
      const result = await ask<MeState>("player:join", { name, genderId, token: localStorage.getItem(tokenKey), ...ensurePlayerIdentity() });
      localStorage.setItem(tokenKey, result.token);
      localStorage.setItem("rps-online-name", name);
      localStorage.setItem("rps-online-gender", genderId);
      onDone(result);
    } catch (error) {
      onError(error instanceof Error ? error.message : "进入失败");
    }
  }

  return (
    <section className="login-card">
      <h2>进入游戏</h2>
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={12} placeholder="你的名字，允许重复" />
      <GenderPicker config={config} value={genderId} onChange={setGenderId} />
      <button className="primary" onClick={submit}>进入大厅</button>
    </section>
  );
}

function PlayerBadge({ player, compact = false }: { player: PublicPlayer; compact?: boolean }) {
  if (player.nameWarPunished && player.nameWarPenaltyName) {
    return (
      <span className={`player-badge name-war-badge ${compact ? "compact" : ""}`}>
        <strong>{displayPlayerName(player)}</strong>
        <GiveawayChip player={player} />
      </span>
    );
  }
  return (
    <span className={`player-badge ${compact ? "compact" : ""}`}>
      <span className="gender-chip" style={genderStyle(player)} title={player.factionLabel}>{player.genderLabel}</span>
      <span className={`title-chip ${titleClass(player.stats.rankedPoints)}`}>{player.stats.title}</span>
      <strong>{displayPlayerName(player)}</strong>
      <ModeChip player={player} />
      <GiveawayChip player={player} />
    </span>
  );
}

function ModeChip({ player }: { player: PublicPlayer }) {
  const showNameWar = Boolean(player.nameWarEnabled && !player.nameWarPunished);
  if (player.extremeModeEnabled && showNameWar) return <span className="mode-chip">⚡⚔️ 极限名争</span>;
  if (player.extremeModeEnabled) return <span className="mode-chip">⚡ 极限</span>;
  if (showNameWar) return <span className="mode-chip">⚔️ 名争</span>;
  return null;
}

function shouldShowGiveawayValue(player: PublicPlayer) {
  return Boolean(player.giveawayEnabled || (player.giveawayValue || 0) > 0);
}

function GiveawayChip({ player }: { player: PublicPlayer }) {
  if (!shouldShowGiveawayValue(player)) return null;
  return <span className="giveaway-chip">白给 {formatGiveawayValue(player.giveawayValue || 0)}%</span>;
}

function displayPlayerName(player: PublicPlayer) {
  if (player.nameWarPunished && player.nameWarPenaltyName) return `${player.extremeModeEnabled ? "极 " : ""}${player.nameWarPenaltyName}`;
  return player.name;
}

function firstGenderId(config: AppConfig) {
  return config.genderFactions[0]?.genders[0]?.id || config.genders[0]?.id || "male";
}

function genderStyle(player: PublicPlayer): CSSProperties {
  return {
    color: player.factionColors.textColor,
    backgroundColor: player.factionColors.backgroundColor,
    borderColor: player.factionColors.borderColor
  };
}

function factionStyle(faction: GenderFaction): CSSProperties {
  return {
    color: faction.textColor,
    backgroundColor: faction.backgroundColor,
    borderColor: faction.borderColor
  };
}

function genderInfoFromConfig(config: AppConfig, genderId: string) {
  for (const faction of config.genderFactions) {
    const gender = faction.genders.find((item) => item.id === genderId);
    if (gender) return { ...gender, factionId: faction.id, factionLabel: faction.label };
  }
  return config.genders.find((item) => item.id === genderId);
}

function GenderPicker({ config, value, onChange, compact = false }: { config: AppConfig; value: string; onChange: (genderId: string) => void; compact?: boolean }) {
  return (
    <div className={`gender-faction-picker ${compact ? "compact" : ""}`}>
      {config.genderFactions.map((faction) => (
        <div className="gender-faction-group" key={faction.id}>
          <span className="faction-label" style={factionStyle(faction)}>{faction.label}</span>
          <div className="gender-options">
            {faction.genders.map((gender) => (
              <button key={gender.id} className={value === gender.id ? "active" : ""} onClick={() => onChange(gender.id)}>
                {gender.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function titleClass(points: number) {
  if (points < -500) return "title-bad";
  if (points < 0) return "title-low";
  if (points < 500) return "title-mid";
  return "title-high";
}

function Lobby({ config, lobby, me, onError, onGoRoom }: { config: AppConfig; lobby: LobbySnapshot; me: PublicPlayer; onError: (message: string) => void; onGoRoom: (room?: RoomSnapshot) => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [suggestion, setSuggestion] = useState("");
  const suggestionListRef = useRef<HTMLDivElement | null>(null);
  const suggestionStickToBottomRef = useRef(true);
  const [suggestionStickToBottom, setSuggestionStickToBottom] = useState(true);
  const visibleSuggestions = lobby.suggestions.slice(0, 50).reverse();
  const [now, setNow] = useState(Date.now());
  const renameTargets = lobby.players.filter((player) => isRenameTargetVisible(player, now));

  useEffect(() => {
    const list = suggestionListRef.current;
    if (list && suggestionStickToBottomRef.current) scrollToBottomSoon(list);
  }, [visibleSuggestions.length]);

  useEffect(() => {
    if (!lobby.players.some((player) => !player.connected && isRenameTarget(player) && player.disconnectedAt)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [lobby.players]);

  async function joinRoom(roomId: string) {
    try {
      const targetRoom = lobby.rooms.find((room) => room.id === roomId);
      if (targetRoom?.enableRanked && Boolean(targetRoom.enableExtremeRanked) !== Boolean(me.extremeModeEnabled)) {
        const ok = window.confirm(me.extremeModeEnabled
          ? "你是极限模式玩家，进入普通排位房后只能在观战席，不能上桌。确认进入？"
          : "你不是极限模式玩家，进入极限排位房后只能在观战席，不能上桌。确认进入？");
        if (!ok) return;
      }
      if (targetRoom?.enableExtremeRanked && me.extremeModeEnabled) {
        const ok = window.confirm(`这是极限排位房，胜负会按极限模式规则结算，并存在连胜风险，确认进入？`);
        if (!ok) return;
      }
      if (targetRoom?.enableRanked && (targetRoom.rankMultiplier || 1) > 1) {
        const multiplier = targetRoom.rankMultiplier || 1;
        const effectiveStake = targetRoom.stake * multiplier;
        const ok = window.confirm(targetRoom.gameId === "othello"
          ? `这是 ${multiplier} 倍黑白棋排位房，每翻 1 子按 ${effectiveStake} 分实时结算，确认进入？`
          : `这是 ${multiplier} 倍排位房，本局胜负按 ${effectiveStake} 分结算，确认进入？`);
        if (!ok) return;
      }
      const result = await ask<{ room: RoomSnapshot }>("room:join", { roomId, password: passwords[roomId] });
      onGoRoom(result.room);
    } catch (error) {
      onError(error instanceof Error ? error.message : "加入失败");
    }
  }

  async function sendSuggestion() {
    const text = suggestion.trim();
    if (!text) return;
    setSuggestion("");
    try {
      await ask("suggestion:add", { text });
    } catch (error) {
      setSuggestion(text);
      onError(error instanceof Error ? error.message : "留言发送失败");
    }
  }

  return (
    <section className="dashboard">
      <div className="panel lobby-main">
        <div className="panel-title lobby-title">
          <h2><Users size={20} /> 大厅</h2>
          <button type="button" className="primary small" onClick={() => setShowCreate((value) => !value)}>创建房间</button>
        </div>
        <div className="room-list">
          {lobby.rooms.map((room) => (
            <div
              className={`room-card ${room.roomBackgroundImage ? "has-room-card-background" : ""}`}
              key={room.id}
              style={room.roomBackgroundImage ? { "--room-card-bg": `url(${room.roomBackgroundImage})` } as CSSProperties : undefined}
            >
              <div>
                <h3>{room.name} <ExtremeRankedBadge enabled={room.enableExtremeRanked} /> <RankMultiplierBadge multiplier={room.rankMultiplier} /></h3>
                {room.tags?.length ? <RoomTagList tags={room.tags} /> : null}
                <RoomVersusLine room={room} />
                <p>{room.status} · {room.players}/2 战斗席 · {room.spectators} 观战</p>
                <RoomInfoTagList tags={lobbyRoomInfoTags(config, room)} />
              </div>
              <div className="join-box">
                {room.hasPassword && <input placeholder="房间密码" value={passwords[room.id] || ""} onChange={(event) => setPasswords({ ...passwords, [room.id]: event.target.value })} />}
                <button onClick={() => joinRoom(room.id)}>加入</button>
              </div>
            </div>
          ))}
          {lobby.rooms.length === 0 && <p className="empty">还没有房间，先创建一个吧。</p>}
        </div>
        <div className="lobby-lower-grid">
          <UniversalRenamePanel config={config} targets={renameTargets} me={me} onError={onError} />
          <GiveawayPanel config={config} players={lobby.players} me={me} onError={onError} />
        </div>
      </div>
      <aside className="side-column">
        <Leaderboard title="在线积分榜" players={lobby.rankedLeaderboard} />
        <div className="panel lobby-message-board">
          <h2><MessageCircle size={18} /> 留言板</h2>
          <div className="chat-scroll-shell">
            <div
              className="messages lobby-suggestion-messages"
              ref={suggestionListRef}
              onScroll={(event) => {
                const nextStick = isNearScrollBottom(event.currentTarget);
                if (suggestionStickToBottomRef.current === nextStick) return;
                suggestionStickToBottomRef.current = nextStick;
                setSuggestionStickToBottom(nextStick);
              }}
            >
              {visibleSuggestions.map((item) => <ChatBubble key={item.id} message={suggestionToMessage(item)} me={me} />)}
              {lobby.suggestions.length === 0 && <p className="empty">还没有留言</p>}
            </div>
            {!suggestionStickToBottom && visibleSuggestions.length > 0 && (
              <button type="button" className="chat-stick-button" onClick={() => stickChatToBottom(suggestionListRef.current, suggestionStickToBottomRef, setSuggestionStickToBottom)}>
                ↓ 回到底部
              </button>
            )}
          </div>
          <div className="send-row">
            <input value={suggestion} onChange={(event) => setSuggestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendSuggestion(); }} placeholder="写下建议、bug 或新惩罚..." />
            <button onClick={sendSuggestion}>发送</button>
          </div>
        </div>
      </aside>
      {showCreate && <CreateRoom config={config} me={me} onCreated={onGoRoom} onCancel={() => setShowCreate(false)} onError={onError} />}
    </section>
  );
}

function suggestionToMessage(item: LobbySnapshot["suggestions"][number]): ChatMessage {
  return {
    id: item.id,
    playerId: item.playerId,
    author: item.author,
    authorPlayer: item.authorPlayer,
    text: item.text,
    at: item.at
  };
}

function CreateRoom({ config, me, onCreated, onCancel, onError }: { config: AppConfig; me: PublicPlayer; onCreated: (room?: RoomSnapshot) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [settings, setSettings] = useState<RoomSettings>({
    name: defaultRoomName,
    gameId: "rps",
    enableBot: false,
    botDifficulty: "easy",
    enablePunishment: false,
    punishmentSource: "system",
    punishmentId: config.punishments[0]?.id,
    punishmentIds: config.punishments[0]?.id ? [config.punishments[0].id] : [],
    enableTags: false,
    tags: [],
    allowProofImage: true,
    tieDoublePunish: false,
    requireOpponentConfirm: false,
    enableRanked: false,
    stake: 5,
    enableRankMultiplier: false,
    rankMultiplier: 1,
    enableExtremeRanked: false,
    othelloBoardTheme: "classic",
    tictactoeBoardTheme: "paper"
  });
  const [customRoomName, setCustomRoomName] = useState(false);

  useEffect(() => {
    setSettings((old) => {
      let changed = false;
      const next = { ...old };
      const validPunishmentIds = selectedPunishmentIdsForConfig(config, next);
      if ((next.punishmentSource || "system") === "system" && !sameStringArray(validPunishmentIds, next.punishmentIds || [])) {
        next.punishmentIds = validPunishmentIds;
        next.punishmentId = validPunishmentIds[validPunishmentIds.length - 1];
        changed = true;
      }
      if (!config.bots.difficulties.some((difficulty) => difficulty.id === next.botDifficulty)) {
        next.botDifficulty = config.bots.difficulties[0]?.id || "easy";
        changed = true;
      }
      if (next.tags?.some((tag) => !config.roomTags.includes(tag))) {
        next.tags = next.tags.filter((tag) => config.roomTags.includes(tag));
        next.enableTags = Boolean(next.tags.length);
        changed = true;
      }
      return changed ? next : old;
    });
  }, [config.punishments, config.bots.difficulties, config.roomTags]);

function patch(next: Partial<RoomSettings>) {
    setSettings((old) => {
      const merged = { ...old, ...next };
      if (!customRoomName && next.gameId) {
        merged.name = next.gameId === "othello" ? defaultOthelloRoomName : next.gameId === "tictactoe" ? defaultTicTacToeRoomName : defaultRoomName;
      }
      if (next.gameId === "othello" || merged.gameId === "othello") {
        merged.othelloBoardTheme = merged.othelloBoardTheme || "classic";
        merged.enableBot = false;
      }
      if (next.gameId === "tictactoe" || merged.gameId === "tictactoe") {
        merged.tictactoeBoardTheme = merged.tictactoeBoardTheme || "paper";
        merged.enableBot = false;
      }
      if (next.punishmentSource === "player") {
        merged.enablePunishment = true;
        merged.enableBot = false;
      }
      if (next.enableBot) {
        merged.enableRanked = false;
        merged.enableRankMultiplier = false;
        merged.rankMultiplier = 1;
        merged.enableExtremeRanked = false;
      }
      if (next.enableRanked) {
        merged.enableBot = false;
      }
      if (next.enableRanked === false) {
        merged.enableRankMultiplier = false;
        merged.rankMultiplier = 1;
        merged.enableExtremeRanked = false;
      }
      if (next.enableRankMultiplier) {
        merged.enableRanked = true;
        merged.enableBot = false;
        merged.enableExtremeRanked = false;
        if (!([2, 5, 10] as const).includes(merged.rankMultiplier as 2 | 5 | 10)) merged.rankMultiplier = 2;
      }
      if (next.enableExtremeRanked) {
        merged.enableRanked = true;
        merged.enableBot = false;
        merged.enableRankMultiplier = false;
        merged.rankMultiplier = 1;
      }
      if (!merged.enableRankMultiplier) {
        merged.rankMultiplier = 1;
      }
      if (!merged.enableRanked) {
        merged.enableExtremeRanked = false;
      }
      if (merged.gameId === "othello") {
        if (!([1, 2, 5, 10] as const).includes(merged.stake as 1 | 2 | 5 | 10)) merged.stake = 5;
        merged.enableBot = false;
        if (merged.enableExtremeRanked) {
          merged.enableRankMultiplier = false;
          merged.rankMultiplier = 1;
        }
      } else if (merged.gameId === "tictactoe") {
        if (!([5, 10, 20] as const).includes(merged.stake as 5 | 10 | 20)) merged.stake = 5;
        merged.enableBot = false;
      } else if (!([5, 10, 20] as const).includes(merged.stake as 5 | 10 | 20)) {
        merged.stake = 5;
      }
      if (next.enableBot && merged.punishmentSource === "player") {
        merged.punishmentSource = "system";
      }
      if (merged.punishmentSource === "system") {
        merged.punishmentIds = selectedPunishmentIdsForConfig(config, merged);
        merged.punishmentId = merged.punishmentIds[merged.punishmentIds.length - 1];
      } else {
        merged.punishmentIds = [];
        merged.punishmentId = undefined;
      }
      if (next.enableTags === false) {
        merged.tags = [];
      }
      if (next.tags) {
        merged.tags = next.tags.filter((tag) => config.roomTags.includes(tag)).slice(0, 5);
        merged.enableTags = merged.tags.length > 0;
      }
      if (!customRoomName && merged.enablePunishment && ("enablePunishment" in next || "punishmentId" in next || "punishmentIds" in next || "punishmentSource" in next)) {
        merged.name = generateRoomName(config, merged);
      }
      return merged;
    });
  }

  function togglePunishment(punishmentId: string) {
    const current = selectedPunishmentIdsForConfig(config, settings);
    const nextIds = current.includes(punishmentId)
      ? current.length > 1 ? current.filter((id) => id !== punishmentId) : current
      : [...current, punishmentId];
    patch({ punishmentIds: nextIds, punishmentId: nextIds[nextIds.length - 1] });
  }

  async function create() {
    try {
      const result = await ask<{ room: RoomSnapshot }>("room:create", { settings });
      onCreated(result.room);
    } catch (error) {
      onError(error instanceof Error ? error.message : "创建失败");
    }
  }

  async function unlockMultiplierMode() {
    try {
      await ask("rankMultiplier:unlock", {});
      onError("倍率模式已解锁，已扣除 200 排位积分。");
    } catch (error) {
      onError(error instanceof Error ? error.message : "解锁失败");
    }
  }

  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) event.stopPropagation(); }}>
      <section className="create-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <h2>🏠 创建房间</h2>
            <p className="hint">选择玩法后就可以邀请朋友加入。</p>
          </div>
          <button type="button" className="icon-button" onClick={onCancel}>×</button>
        </div>
        <div className="create-scroll-area">
        <div className="create-box">
          <div className="create-section game-create-section">
            <h3>游戏</h3>
            <div className="game-choice-grid">
              {config.games.map((game) => (
                <button
                  type="button"
                  className={`game-choice-card ${settings.gameId === game.id ? "active" : ""}`}
                  key={game.id}
                  onClick={() => patch({ gameId: game.id })}
                >
                  <span className="game-choice-icon" aria-hidden="true">{gameIcon(game.id)}</span>
                  <span className="game-choice-copy">
                    <strong>{game.name}</strong>
                    <small>{game.description}</small>
                  </span>
                </button>
              ))}
            </div>
            {settings.gameId === "othello" && <p className="hint">黑白棋支持真人 1v1、观战、聊天、排位和惩罚；Bot 不开放，排位房会支持白给/上贡结算。</p>}
            {settings.gameId === "tictactoe" && <p className="hint">井字棋支持真人 1v1、观战、聊天、排位和惩罚；双方准备后随机 X/O 先手，Bot 暂不开放。</p>}
            {settings.gameId === "othello" && (
              <div className="othello-theme-grid">
                {othelloBoardThemes.map((theme) => (
                  <button
                    type="button"
                    className={`othello-theme-card ${settings.othelloBoardTheme === theme.id ? "active" : ""}`}
                    key={theme.id}
                    onClick={() => patch({ othelloBoardTheme: theme.id })}
                    style={{
                      "--theme-board": theme.board,
                      "--theme-cell": theme.cell,
                      "--theme-line": theme.line,
                      "--theme-border": theme.border,
                      "--theme-black-disc": theme.blackDisc,
                      "--theme-white-disc": theme.whiteDisc,
                      "--theme-black-ring": theme.blackRing,
                      "--theme-white-ring": theme.whiteRing
                    } as CSSProperties}
                  >
                    <span className="othello-theme-preview">
                      <i><b className="preview-disc black" /></i>
                      <i />
                      <i />
                      <i><b className="preview-disc white" /></i>
                    </span>
                    <strong>{theme.name}</strong>
                    <small>{theme.description}</small>
                  </button>
                ))}
              </div>
            )}
            {settings.gameId === "tictactoe" && (
              <div className="tictactoe-theme-grid">
                {tictactoeBoardThemes.map((theme) => (
                  <button
                    type="button"
                    className={`tictactoe-theme-card ${settings.tictactoeBoardTheme === theme.id ? "active" : ""}`}
                    key={theme.id}
                    onClick={() => patch({ tictactoeBoardTheme: theme.id })}
                    style={{
                      "--ttt-board": theme.board,
                      "--ttt-cell": theme.cell,
                      "--ttt-line": theme.line,
                      "--ttt-border": theme.border,
                      "--ttt-x": theme.x,
                      "--ttt-o": theme.o
                    } as CSSProperties}
                  >
                    <span className="tictactoe-theme-preview">
                      <i>×</i>
                      <i />
                      <i>○</i>
                      <i />
                      <i>×</i>
                      <i />
                      <i>○</i>
                      <i />
                      <i>×</i>
                    </span>
                    <strong>{theme.name}</strong>
                    <small>{theme.description}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="create-section">
            <h3>基础</h3>
            <input value={settings.name} onKeyDown={preventEnterSubmit} onChange={(event) => { setCustomRoomName(true); patch({ name: event.target.value }); }} placeholder="房间名" />
            <input value={settings.password || ""} onKeyDown={preventEnterSubmit} onChange={(event) => patch({ password: event.target.value || undefined })} placeholder="房间密码，可不填" />
            <Toggle label="显示房间 Tag" value={settings.enableTags ?? false} onChange={(value) => patch({ enableTags: value })} />
            {settings.enableTags && (
              <TagPicker
                options={config.roomTags}
                value={settings.tags || []}
                onChange={(tags) => patch({ tags })}
              />
            )}
          </div>
          <div className="create-section">
            <h3>对手</h3>
            <Toggle label="开启 Bot" value={settings.enableBot} disabled={settings.gameId === "othello" || settings.gameId === "tictactoe" || (settings.enablePunishment && settings.punishmentSource === "player") || settings.enableRanked} onChange={(value) => patch({ enableBot: value })} />
            {settings.gameId === "othello" && <p className="hint">黑白棋暂不支持 Bot。</p>}
            {settings.gameId === "tictactoe" && <p className="hint">井字棋暂不支持 Bot。</p>}
            {settings.enablePunishment && settings.punishmentSource === "player" && <p className="hint">玩家发布任务模式需要真人对战，不能开启 Bot。</p>}
            {settings.enableRanked && <p className="hint">排位战需要真人对战，不能开启 Bot。</p>}
            {settings.enableBot && (
              <div className="bot-difficulty-grid">
                {config.bots.difficulties.map((difficulty) => (
                  <button
                    type="button"
                    className={`bot-difficulty-card ${settings.botDifficulty === difficulty.id ? "active" : ""}`}
                    key={difficulty.id}
                    onClick={() => patch({ botDifficulty: difficulty.id })}
                    style={{ "--bot-card-color": difficulty.cardColor || "#9ed7ff" } as CSSProperties}
                  >
                    <span className="bot-card-emoji">{difficulty.emoji || "🤖"}</span>
                    <strong>{difficulty.name}</strong>
                    <em>{botStars(difficulty.level || 1)}</em>
                    <small>{difficulty.description}</small>
                    <b>{botStrategyText(difficulty.strategy)}</b>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="create-section">
            <h3>玩法</h3>
            <div className="ranked-choice-grid">
              <button type="button" className={`ranked-choice-card ${!settings.enableRanked ? "active" : ""}`} onClick={() => patch({ enableRanked: false, enableExtremeRanked: false })}>
                <span>🎮 普通局</span>
                <small>不增加/减少排位积分，可以和 Bot 对战。</small>
              </button>
              {(settings.gameId === "othello" ? ([1, 2, 5, 10] as const) : ([5, 10, 20] as const)).map((stake) => (
                <button type="button" className={`ranked-choice-card ${settings.enableRanked && settings.stake === stake ? "active" : ""}`} key={stake} onClick={() => patch({ enableRanked: true, stake, enableExtremeRanked: Boolean(me.extremeModeEnabled) })}>
                  <span>{settings.gameId === "othello" ? "🏆 黑白棋排位" : settings.gameId === "tictactoe" ? "🏆 井字棋排位" : me.extremeModeEnabled ? "⚡ 极限排位" : "🏆 排位"} {stake}{settings.gameId === "othello" ? " 分/子" : " 分"}</span>
                  <small>{settings.gameId === "othello" ? `每翻掉对方 1 子立即结算 ${stake} 分，终局不重复结算。` : me.extremeModeEnabled ? "只能创建极限排位房；非极限玩家无法进入。" : `胜利 +${stake}，失败 -${stake}；普通平局不扣分，平局双罚时双方 -${stake}。`}</small>
                </button>
              ))}
            </div>
            {settings.gameId === "othello" && <p className="hint">黑白棋排位按实时翻子结算，可选 1/2/5/10 分/子；支持倍率和极限模式，但两者不能同时开启。</p>}
            {settings.gameId === "tictactoe" && <p className="hint">井字棋排位按胜负固定分结算，可选 5/10/20 分；支持倍率和极限模式。</p>}
            {settings.enableBot && <p className="hint">开启 Bot 时不能选择排位战。</p>}
            {settings.enableRanked && me.extremeModeEnabled && (
              <div className="multiplier-box extreme-mode-box">
                <div className="multiplier-head">
                  <strong>⚡ 极限排位已开启</strong>
                  <span>禁用倍率</span>
                </div>
                <p className="hint">极限排位会按你的极限模式分段调整加减分；非极限玩家无法进入这个房间。</p>
              </div>
            )}
            {settings.enableRanked && !me.extremeModeEnabled && (
              <p className="hint">你没有开启极限模式，因此只能创建普通排位房。</p>
            )}
            {settings.enableRanked && (
              <div className="multiplier-box">
                <div className="multiplier-head">
                  <strong>倍率模式</strong>
                  <span>{settings.enableRankMultiplier ? `x${settings.rankMultiplier || 1}` : "未开启"}</span>
                </div>
                {me.extremeModeEnabled ? (
                  <p className="hint danger-hint">极限模式不能开启倍率房间，也不能进入倍率房；黑白棋极限排位会按每次翻子实时套用极限折扣。</p>
                ) : !me.rankMultiplierUnlocked ? (
                  <>
                    <p className="hint">提交 200 排位积分后，本次服务器运行期间可创建 2倍 / 5倍 / 10倍排位房。</p>
                    <button type="button" className="soft-button" disabled={me.stats.rankedPoints < 200} onClick={unlockMultiplierMode}>提交 200 积分解锁</button>
                    {me.stats.rankedPoints < 200 && <p className="hint danger-hint">你的排位积分不足 200，暂时不能解锁。</p>}
                  </>
                ) : (
                  <>
                    <div className="multiplier-choice-grid">
                      {([1, 2, 5, 10] as const).map((multiplier) => (
                        <button
                          type="button"
                          className={`ranked-choice-card ${rankMultiplierForSettings(settings) === multiplier ? "active" : ""}`}
                          key={multiplier}
                          onClick={() => patch({ enableRankMultiplier: multiplier > 1, rankMultiplier: multiplier })}
                        >
                          <span>{multiplier === 1 ? "普通倍率" : `x${multiplier} 倍房`}</span>
                          <small>{multiplier === 1 ? "按基础赌分结算。" : settings.gameId === "othello" ? `每翻 1 子按 ${settings.stake * multiplier} 分结算。` : `胜负按 ${settings.stake * multiplier} 分结算。`}</small>
                        </button>
                      ))}
                    </div>
                    <p className="hint">当前：排位 {settings.stake}{settings.gameId === "othello" ? " 分/子" : " 分"} × {rankMultiplierForSettings(settings)} 倍 = {settings.gameId === "othello" ? `每翻 1 子 ${settings.stake * rankMultiplierForSettings(settings)} 分` : `胜负 ${settings.stake * rankMultiplierForSettings(settings)} 分`}。</p>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="create-section">
            <h3>惩罚</h3>
            <Toggle label="惩罚模式" value={settings.enablePunishment} onChange={(value) => patch({ enablePunishment: value })} />
            {settings.gameId === "othello" && <p className="hint">黑白棋惩罚会在终局、认输、逃跑或断线判负后触发；平局双罚开启时黑白棋平局双方都要惩罚。</p>}
            {settings.gameId === "tictactoe" && <p className="hint">井字棋惩罚会在终局或断线判负后触发；平局双罚开启时井字棋平局双方都要惩罚。</p>}
            {settings.enablePunishment && (
              <>
                <Select value={settings.punishmentSource || "system"} onChange={(value) => patch({ punishmentSource: value as RoomSettings["punishmentSource"] })} options={[
                  { value: "system", label: "系统任务" },
                  { value: "player", label: "玩家发布" }
                ]} />
                {(settings.punishmentSource || "system") === "system" ? (
                  <>
                    <p className="hint">已选择 {selectedPunishmentIdsForConfig(config, settings).length} 个惩罚池；每局会先随机一个惩罚池，再随机任务。</p>
                    <div className="punishment-choice-grid">
                      {config.punishments.map((punishment) => {
                        const active = selectedPunishmentIdsForConfig(config, settings).includes(punishment.id);
                        return (
                          <button
                            type="button"
                            className={`punishment-choice-card ${active ? "active" : ""}`}
                            key={punishment.id}
                            onClick={() => togglePunishment(punishment.id)}
                            style={{
                              "--punishment-bg": punishment.cardImageUrl ? `url(${punishment.cardImageUrl})` : "none",
                              "--punishment-bg-opacity": String(punishment.cardImageOpacity ?? 0.26)
                            } as CSSProperties}
                          >
                            <div className="punishment-choice-meta">
                              <em>{active ? "已选" : "可选"}</em>
                              <em>{punishmentTasks(punishment, config).length} 个任务</em>
                            </div>
                            <span>{punishment.name}</span>
                            <small>{punishment.description}</small>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <p className="hint">本局结算后，由对手临时写惩罚任务；任务不会保存到后台配置。</p>
                )}
                <Toggle label="平局双罚" value={settings.tieDoublePunish} onChange={(value) => patch({ tieDoublePunish: value })} />
                {settings.enableRanked && settings.tieDoublePunish && (
                  <p className="hint">排位平局双罚开启时，平局双方都会扣 {settings.stake} 分。</p>
                )}
                <Toggle label="惩罚需对手确认" value={settings.requireOpponentConfirm} onChange={(value) => patch({ requireOpponentConfirm: value })} />
                <Toggle label="允许图片证明" value={settings.allowProofImage ?? true} onChange={(value) => patch({ allowProofImage: value })} />
              </>
            )}
          </div>
        </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" className="primary" onClick={create}>创建房间</button>
        </div>
      </section>
    </div>
  );
}

function generateRoomName(config: AppConfig, settings: RoomSettings) {
  if (settings.gameId === "othello" && !settings.enablePunishment) return defaultOthelloRoomName;
  const pool = settings.punishmentSource === "player"
    ? config.playerPunishmentRoomNamePool
    : primaryPunishmentForSettings(config, settings)?.roomNamePool;
  if (!pool) return defaultRoomName;
  const subject = randomItem(pool.subjects);
  const roomWord = randomItem(pool.roomWords);
  const adjective = pool.adjectives.length && Math.random() < 0.75 ? randomItem(pool.adjectives) : "";
  return `${adjective}${subject}${roomWord}`;
}

function randomItem(items: string[]) {
  return items[Math.floor(Math.random() * items.length)] || "";
}

function selectedPunishmentIdsForConfig(config: AppConfig, settings: RoomSettings) {
  const rawIds = settings.punishmentIds?.length ? settings.punishmentIds : settings.punishmentId ? [settings.punishmentId] : [];
  const validIds = rawIds.filter((id, index) =>
    rawIds.indexOf(id) === index &&
    config.punishments.some((punishment) => punishment.id === id)
  );
  if (validIds.length) return validIds;
  return config.punishments[0]?.id ? [config.punishments[0].id] : [];
}

function primaryPunishmentForSettings(config: AppConfig, settings: RoomSettings) {
  const ids = selectedPunishmentIdsForConfig(config, settings);
  const lastId = ids[ids.length - 1];
  return config.punishments.find((punishment) => punishment.id === lastId);
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function rankMultiplierForSettings(settings: Pick<RoomSettings, "enableRanked" | "enableRankMultiplier" | "rankMultiplier">) {
  if (!settings.enableRanked || !settings.enableRankMultiplier) return 1;
  return ([2, 5, 10] as const).includes(settings.rankMultiplier as 2 | 5 | 10) ? settings.rankMultiplier || 1 : 1;
}

function RankMultiplierBadge({ multiplier }: { multiplier?: number }) {
  if (!multiplier || multiplier <= 1) return null;
  return <span className="rank-multiplier-badge">x{multiplier}</span>;
}

function gameIcon(gameId: RoomSettings["gameId"]) {
  if (gameId === "othello") return "⚫⚪";
  if (gameId === "tictactoe") return "❌⭕";
  return "✊✌️🖐️";
}

function ExtremeRankedBadge({ enabled }: { enabled?: boolean }) {
  if (!enabled) return null;
  return <span className="rank-multiplier-badge extreme-ranked-badge">⚡ 极限</span>;
}

function preventEnterSubmit(event: ReactKeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter") event.preventDefault();
}

function RoomTagList({ tags }: { tags: string[] }) {
  return (
    <div className="room-tag-list">
      {tags.map((tag) => <span className="room-tag" key={tag}>#{tag}</span>)}
    </div>
  );
}

function RoomVersusLine({ room }: { room: LobbySnapshot["rooms"][number] }) {
  const left = room.versus.A;
  const right = room.versus.B;
  const leftName = left ? "player" in left ? left.player.displayName : left.name : "等待玩家";
  const rightName = right ? "player" in right ? right.player.displayName : right.name : "等待玩家";
  return (
    <div className="room-versus-line" title={`${leftName} VS ${rightName}`}>
      <RoomVersusSeat occupant={left} />
      <b>VS</b>
      <RoomVersusSeat occupant={right} />
    </div>
  );
}

function RoomVersusSeat({ occupant }: { occupant: LobbySnapshot["rooms"][number]["versus"]["A"] }) {
  if (!occupant) return <span className="empty">等待玩家</span>;
  if ("player" in occupant) return <PlayerBadge player={occupant.player} compact />;
  return <span className="bot">{occupant.name}</span>;
}

function TagPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (tags: string[]) => void }) {
  function toggle(tag: string) {
    if (value.includes(tag)) onChange(value.filter((item) => item !== tag));
    else onChange([...value, tag].slice(0, 5));
  }
  return (
    <div className="room-tag-picker">
      {options.map((tag) => (
        <button type="button" className={value.includes(tag) ? "active" : ""} key={tag} onClick={() => toggle(tag)}>
          #{tag}
        </button>
      ))}
      {options.length === 0 && <p className="empty">后台还没有配置房间 Tag</p>}
    </div>
  );
}

function botStars(level: number) {
  const safeLevel = Math.max(1, Math.min(5, Math.round(level)));
  return "★".repeat(safeLevel) + "☆".repeat(5 - safeLevel);
}

function botStrategyText(strategy?: AppConfig["bots"]["difficulties"][number]["strategy"]) {
  if (strategy === "throw") return "白给";
  if (strategy === "win") return "必胜";
  if (strategy === "counter") return "反制";
  if (strategy === "chaos") return "混乱连招";
  return "随机";
}

function Room({ config, room, lobbySuggestions, me, onBack, onError }: { config: AppConfig; room: RoomSnapshot; lobbySuggestions: LobbySnapshot["suggestions"]; me: PublicPlayer; onBack: () => void; onError: (message: string) => void }) {
  const [chat, setChat] = useState("");
  const [chatTab, setChatTab] = useState<"room" | "lobby">("room");
  const [proofText, setProofText] = useState("");
  const [proofImage, setProofImage] = useState("");
  const [localChoice, setLocalChoice] = useState<Move | null>(null);
  const [redoInputs, setRedoInputs] = useState<Record<string, string>>({});
  const [taskInputs, setTaskInputs] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [extraHistory, setExtraHistory] = useState<RoomSnapshot["roundHistory"]>([]);
  const [roomLobbySuggestions, setRoomLobbySuggestions] = useState<LobbySnapshot["suggestions"]>(lobbySuggestions);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatStickToBottomRef = useRef(true);
  const [chatStickToBottom, setChatStickToBottom] = useState(true);
  const mySeat = room.seats.A?.id === me.id ? "A" : room.seats.B?.id === me.id ? "B" : null;
  const myChoice = mySeat ? room.phase === "result" ? undefined : localChoice || room.choices[mySeat] : undefined;
  const resultChoice = mySeat ? room.revealedChoices?.[mySeat] : undefined;
  const canChoose = Boolean(mySeat && room.phase !== "punishment" && (room.phase === "choosing" || room.phase === "result") && room.seats.A && room.seats.B);
  const roomHasBot = Boolean((room.seats.A && "isBot" in room.seats.A) || (room.seats.B && "isBot" in room.seats.B));
  const canShowGiveawayButton = Boolean(mySeat && me.giveawayEnabled && !roomHasBot && room.seats.A && room.seats.B);
  const canGoSpectate = Boolean(mySeat && room.phase !== "punishment" && !room.choices[mySeat] && !(room.settings.gameId === "tictactoe" && room.phase === "choosing"));
  const roomPlayers = roomPlayerList(room);
  const punishedNames = punishedPlayerNames(room);
  const iAmPunished = room.punishedPlayerIds.includes(me.id);
  const visibleChatMessages = room.chat.filter((item) => !item.expiresAt || item.expiresAt > now).slice(-80);
  const visibleLobbyMessages = roomLobbySuggestions.slice(0, 50).reverse().map(suggestionToMessage);
  const displayedChatMessages = chatTab === "room" ? visibleChatMessages : visibleLobbyMessages;
  const visibleRoundHistory = [...room.roundHistory, ...extraHistory.filter((item) => !room.roundHistory.some((fresh) => fresh.id === item.id))];
  const leaveTitle = room.phase === "punishment"
    ? iAmPunished
      ? "惩罚完成前不能离开房间"
      : "离开后，服务器会自动处理你负责的审核或任务"
    : room.settings.gameId === "tictactoe" && room.phase === "choosing" && mySeat
      ? "井字棋对局进行中不能离开战斗席"
    : "离开房间";

  useEffect(() => {
    if (!mySeat || room.phase === "choosing" && !room.choices[mySeat]) setLocalChoice(null);
  }, [mySeat, room.phase, room.choices]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (room.settings.allowProofImage === false) setProofImage("");
  }, [room.settings.allowProofImage]);

  useEffect(() => {
    setExtraHistory([]);
  }, [room.id]);

  useEffect(() => {
    setRoomLobbySuggestions(lobbySuggestions);
  }, [lobbySuggestions]);

  useEffect(() => {
    if (chatTab !== "lobby") {
      ask("lobby:suggestions:unsubscribe", {}).catch(() => undefined);
      return;
    }
    let cancelled = false;
    ask<{ suggestions: LobbySnapshot["suggestions"] }>("lobby:suggestions:subscribe", {})
      .then((result) => {
        if (!cancelled) setRoomLobbySuggestions(result.suggestions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      ask("lobby:suggestions:unsubscribe", {}).catch(() => undefined);
    };
  }, [chatTab]);

  useEffect(() => {
    const list = chatListRef.current;
    if (list && chatStickToBottomRef.current) scrollToBottomSoon(list);
  }, [displayedChatMessages.length, chatTab]);

  useEffect(() => {
    chatStickToBottomRef.current = true;
    setChatStickToBottom(true);
    if (chatListRef.current) scrollToBottomSoon(chatListRef.current);
  }, [chatTab]);

  async function act(event: string, payload: unknown = {}) {
    try {
      await ask(event, payload);
    } catch (error) {
      onError(error instanceof Error ? error.message : "操作失败");
    }
  }

  async function uploadImage(file: File) {
    const uploadFile = await compressImageForUpload(file);
    if (uploadFile.size > maxImageUploadBytes) throw new Error("图片压缩后仍超过 8MB，请换一张或先用相册压缩。");
    const form = new FormData();
    form.append("token", localStorage.getItem(tokenKey) || "");
    form.append("image", uploadFile);
    const response = await fetch("/api/proof-image", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "上传失败");
    setProofImage(data.imageUrl);
  }

  async function choose(move: Move) {
    setLocalChoice(move);
    try {
      await ask("room:move", { move });
    } catch (error) {
      setLocalChoice(null);
      onError(error instanceof Error ? error.message : "出拳失败");
    }
  }

  async function playOthello(row: number, col: number) {
    try {
      await ask("othello:move", { row, col });
    } catch (error) {
      onError(error instanceof Error ? error.message : "落子失败");
    }
  }

  async function playTicTacToe(row: number, col: number) {
    try {
      await ask("tictactoe:move", { row, col });
    } catch (error) {
      onError(error instanceof Error ? error.message : "落子失败");
    }
  }

  async function chooseTicTacToeGiveaway(mode: "normal" | "giveaway") {
    try {
      await ask("tictactoe:giveawayChoice", { mode });
    } catch (error) {
      onError(error instanceof Error ? error.message : "白给选择失败");
    }
  }

  async function settleOthelloMove(mode: "normal" | "giveaway" | "tribute") {
    try {
      await ask("othello:settleMove", { mode });
    } catch (error) {
      onError(error instanceof Error ? error.message : "结算失败");
    }
  }

  async function restartOthello() {
    try {
      await ask("othello:restart", {});
    } catch (error) {
      onError(error instanceof Error ? error.message : "重新开始失败");
    }
  }

  async function readyOthello() {
    try {
      await ask("othello:ready", {});
    } catch (error) {
      onError(error instanceof Error ? error.message : "准备失败");
    }
  }

  async function readyTicTacToe() {
    try {
      await ask("tictactoe:ready", {});
    } catch (error) {
      onError(error instanceof Error ? error.message : "准备失败");
    }
  }

  async function restartTicTacToe() {
    try {
      await ask("tictactoe:restart", {});
    } catch (error) {
      onError(error instanceof Error ? error.message : "重新开始失败");
    }
  }

  async function requestOthelloSurrender() {
    try {
      await ask("othello:requestSurrender", {});
    } catch (error) {
      onError(error instanceof Error ? error.message : "申请认输失败");
    }
  }

  async function respondOthelloSurrender(accept: boolean) {
    try {
      await ask("othello:respondSurrender", { accept });
    } catch (error) {
      onError(error instanceof Error ? error.message : "处理认输失败");
    }
  }

  async function escapeOthello() {
    if (!window.confirm("确定要逃跑吗？本局会立即判负，并按剩余空格追加扣分。")) return;
    try {
      await ask("othello:escape", {});
    } catch (error) {
      onError(error instanceof Error ? error.message : "逃跑失败");
    }
  }

  async function submitProof() {
    try {
      await ask("punishment:submit", { text: proofText, imageUrl: proofImage });
      setProofText("");
      setProofImage("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "提交失败");
    }
  }

  async function reviewProof(playerId: string, action: "approve" | "forgive" | "reject") {
    try {
      await ask("punishment:review", { playerId, action, redoTaskText: redoInputs[playerId] });
      setRedoInputs((old) => ({ ...old, [playerId]: "" }));
    } catch (error) {
      onError(error instanceof Error ? error.message : "审核失败");
    }
  }

  async function assignPunishmentTask(playerId: string) {
    try {
      await ask("punishment:assignTask", { playerId, taskText: taskInputs[playerId] });
      setTaskInputs((old) => ({ ...old, [playerId]: "" }));
    } catch (error) {
      onError(error instanceof Error ? error.message : "发布任务失败");
    }
  }

  async function sendChat() {
    const text = chat.trim();
    if (!text) return;
    setChat("");
    try {
      await ask("chat:send", { roomId: room.id, text });
    } catch (error) {
      setChat(text);
      onError(error instanceof Error ? error.message : "聊天发送失败");
    }
  }

  async function leaveCurrentRoom() {
    if (room.phase === "punishment" && iAmPunished) {
      onError("惩罚完成前不能离开房间");
      return;
    }
    try {
      await ask("room:leave", {});
      onBack();
    } catch (error) {
      onError(error instanceof Error ? error.message : "离开房间失败");
    }
  }

  async function loadMoreHistory() {
    try {
      const result = await ask<{ items: RoomSnapshot["roundHistory"]; total: number }>("room:history", {
        roomId: room.id,
        offset: visibleRoundHistory.length,
        limit: 50
      });
      setExtraHistory((old) => appendHistoryPage(old, result.items, room.roundHistory));
    } catch (error) {
      onError(error instanceof Error ? error.message : "加载对局记录失败");
    }
  }

  return (
    <section className="room-layout">
      <div
        className={`panel room-header ${room.settings.roomBackgroundImage ? "has-room-header-background" : ""}`}
        style={room.settings.roomBackgroundImage ? { "--room-header-bg": `url(${room.settings.roomBackgroundImage})` } as CSSProperties : undefined}
      >
        <div>
          <h2><Swords size={20} /> {room.settings.name} <ExtremeRankedBadge enabled={room.settings.enableExtremeRanked} /> <RankMultiplierBadge multiplier={rankMultiplierForSettings(room.settings)} /></h2>
          {room.settings.enableTags && room.settings.tags?.length ? <RoomTagList tags={room.settings.tags} /> : null}
          <RoomInfoTagList tags={roomInfoTags(config, room)} />
        </div>
        <button className="soft-button" title={leaveTitle} onClick={leaveCurrentRoom}><DoorOpen size={16} /> 离开</button>
      </div>
      <div className="battle-panel">
        <SeatView seat="A" room={room} me={me} now={now} onSit={() => act("room:sit", { seat: "A" })} />
        <div className="versus">
          <span className="versus-label">⚔️ 对战比分</span>
          <strong className="score-number">{room.score.A} : {room.score.B}</strong>
          {room.settings.gameId === "othello" ? <OthelloScore room={room} /> : room.settings.gameId === "tictactoe" ? <TicTacToeScore room={room} /> : <Settlement room={room} />}
        </div>
        <SeatView seat="B" room={room} me={me} now={now} onSit={() => act("room:sit", { seat: "B" })} />
      </div>
      <div className="room-content-grid">
        <div className="actions-panel panel">
          {room.settings.gameId === "othello" ? (
            <OthelloPanel room={room} me={me} now={now} onMove={playOthello} onSettle={settleOthelloMove} onRestart={restartOthello} onReady={readyOthello} onRequestSurrender={requestOthelloSurrender} onRespondSurrender={respondOthelloSurrender} onEscape={escapeOthello} />
          ) : room.settings.gameId === "tictactoe" ? (
            <TicTacToePanel room={room} me={me} now={now} onMove={playTicTacToe} onReady={readyTicTacToe} onRestart={restartTicTacToe} onGiveawayChoice={chooseTicTacToeGiveaway} />
          ) : mySeat && (
            <div className="move-panel">
              <div>
                <h3>请选择出拳</h3>
                <p className="hint">{room.phase === "punishment" ? "惩罚完成前不能出拳。" : myChoice ? `你已锁定：${choiceText(myChoice)}` : resultChoice ? `上一局：${choiceText(resultChoice)}，可直接开始下一局。` : canChoose ? "坐下不算出拳，点一个 emoji 才会锁定。" : "等待另一位玩家坐下。"}</p>
              </div>
              <div className="move-row emoji-row">
                <button disabled={!canChoose || Boolean(myChoice)} onClick={() => choose("rock")}>✊<span>锤子</span></button>
                <button disabled={!canChoose || Boolean(myChoice)} onClick={() => choose("scissors")}>✌️<span>剪刀</span></button>
                <button disabled={!canChoose || Boolean(myChoice)} onClick={() => choose("paper")}>🖐️<span>布</span></button>
                {canShowGiveawayButton && <button className="giveaway-move-button" disabled={!canChoose || Boolean(myChoice)} onClick={() => choose("giveaway")}>🫴<span>白给</span></button>}
              </div>
            </div>
          )}
          {canGoSpectate && <button onClick={() => act("room:spectate")}><Eye size={16} /> 去观战席</button>}
          {room.phase === "punishment" && (
            <div className="punish-box">
              <div className="punish-head">
                <span>🎲 惩罚阶段</span>
                <strong>{punishedNames.length ? punishedNames.join("、") : "等待同步"}</strong>
              </div>
              <div className={`punishment-card-grid ${room.punishedPlayerIds.length === 1 ? "single" : "double"}`}>
                {room.punishedPlayerIds.map((playerId) => {
                  const punishedPlayer = roomPlayerById(room, playerId);
                  const proof = room.proofs.find((item) => item.playerId === playerId);
                  const task = room.roundHistory[0]?.punishmentTasks.find((item) => item.playerId === playerId);
                  const taskAssignerPlayer = task?.assignedBy ? roomPlayerById(room, task.assignedBy) : undefined;
                  const isMine = playerId === me.id;
                  const taskText = proof?.redoTaskText || task?.taskText || "";
                  const taskAssigned = Boolean(taskText.trim());
                  const canAssignTask = Boolean(room.settings.punishmentSource === "player" && task && canAssignPunishmentTask(room, me.id, playerId, task.assignedBy) && !taskAssigned);
                  const canSubmit = isMine && taskAssigned && (!proof || proof.status === "rejected");
                  const canReview = Boolean(mySeat && !isMine && proof && proof.status !== "approved" && proof.status !== "rejected");
                  const taskCardStyle = task?.backgroundImage ? {
                    "--task-bg": `url(${task.backgroundImage})`,
                    "--task-bg-opacity": String(task.backgroundOpacity ?? 0.22)
                  } as CSSProperties : undefined;
                  return (
                    <div className="punishment-card" key={playerId}>
                      <div className="punishment-card-title">
                        <h4>{punishedPlayer ? <PlayerBadge player={punishedPlayer} compact /> : punishedPlayerName(room, playerId)} {isMine ? "（你）" : ""}</h4>
                        <em>{proof?.status === "approved" ? "已完成" : proof?.status === "pending" ? "待审核" : proof?.status === "rejected" ? "重做中" : taskAssigned ? "待提交" : "等任务"}</em>
                      </div>
                      {taskAssigned && task && (
                        <div className={`task-card designed-task-card ${task.backgroundImage ? "has-task-background" : ""}`} style={taskCardStyle}>
                          <b>{isMine ? "你的任务" : "对方任务"}</b>
                          <p>{taskTextOnly(taskText, task.factionLabel)}</p>
                          {(taskAssignerPlayer || task.assignedByName) && <small>发布者：{taskAssignerPlayer ? displayPlayerName(taskAssignerPlayer) : task.assignedByName}</small>}
                        </div>
                      )}
                      {!taskAssigned && room.settings.punishmentSource === "player" && (
                        <div className="assign-task-box">
                          {isMine && <p className="hint">等待对方发布任务，发布后你就可以提交证明。</p>}
                          {canAssignTask && (
                            <>
                              <p className="hint">请给对方发布一个本局临时惩罚任务。</p>
                              <textarea value={taskInputs[playerId] || ""} onChange={(event) => setTaskInputs((old) => ({ ...old, [playerId]: event.target.value }))} placeholder="写下给对方的惩罚任务" />
                              <button className="primary" onClick={() => assignPunishmentTask(playerId)}>发布任务</button>
                            </>
                          )}
                          {!isMine && !canAssignTask && <p className="hint">等待任务发布。</p>}
                        </div>
                      )}
                      {proof && <PunishmentStatus proof={proof} isMine={isMine} requireConfirm={room.settings.requireOpponentConfirm} />}
                      {proof?.text && (
                        <div className="proof">
                          <b>已提交证明</b>
                          <p>{proof.text}</p>
                          {proof.imageUrl && <img src={proof.imageUrl} alt="惩罚证明" loading="lazy" decoding="async" />}
                        </div>
                      )}
                      {canSubmit && (
                        <div className="proof-submit-card">
                          <b>{proof?.status === "rejected" ? "重新提交证明" : "提交完成证明"}</b>
                          <textarea value={proofText} onChange={(event) => setProofText(event.target.value)} placeholder={proof?.status === "rejected" ? "重新提交你的惩罚完成证明" : "写下你的惩罚完成证明"} />
                          <p className="hint">文字证明必须填写；照片证明可以不交。</p>
                          {room.settings.allowProofImage !== false ? (
                            <>
                              <label className="upload">
                                <Upload size={16} /> 上传图片证明
                                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => event.target.files?.[0] && uploadImage(event.target.files[0]).catch((error) => onError(error.message))} />
                              </label>
                              {proofImage && <img className="proof-preview" src={proofImage} alt="惩罚证明" loading="lazy" decoding="async" />}
                            </>
                          ) : (
                            <p className="hint">本房间关闭了图片证明，只需要提交文字证明。</p>
                          )}
                          <button className="primary" onClick={submitProof}>提交证明</button>
                        </div>
                      )}
                      {canReview && (
                        <div className="review-box">
                          <div className="toolbar">
                            <button className="primary" onClick={() => reviewProof(playerId, "approve")}>确认完成</button>
                            <button onClick={() => reviewProof(playerId, "forgive")}>放过对方</button>
                          </div>
                          <p className="hint">放过对方后，对方下一局可能会受到一点命运安排。双方互相放过时会互相抵消。</p>
                          <textarea value={redoInputs[playerId] || ""} onChange={(event) => setRedoInputs((old) => ({ ...old, [playerId]: event.target.value }))} placeholder="不通过时，给对方发布一个新任务" />
                          <button onClick={() => reviewProof(playerId, "reject")}>不通过，发布新任务</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="room-side-stack">
          <div className="panel room-player-panel">
            <h3 className="sticky-panel-title">
              房间玩家名单
              <span>{roomPlayers.length} 人</span>
            </h3>
            <div className="room-player-list">
              {roomPlayers.map((item) => <RoomPlayerRow key={`${item.role}-${item.player.id}`} player={item.player} role={item.role} now={now} />)}
              {roomPlayers.length === 0 && <p className="empty">暂无真人玩家</p>}
            </div>
          </div>
          <div className="panel chat-panel">
            <div className="chat-panel-head">
              <h3>{chatTab === "room" ? "房间聊天" : "大厅聊天室"}</h3>
              <div className="segmented chat-tabs">
                <button className={chatTab === "room" ? "active" : ""} onClick={() => setChatTab("room")}>本房间</button>
                <button className={chatTab === "lobby" ? "active" : ""} onClick={() => setChatTab("lobby")}>大厅</button>
              </div>
            </div>
            <div className="chat-scroll-shell">
              <div
                className="messages room-chat-messages"
                ref={chatListRef}
                onScroll={(event) => {
                  const nextStick = isNearScrollBottom(event.currentTarget);
                  if (chatStickToBottomRef.current === nextStick) return;
                  chatStickToBottomRef.current = nextStick;
                  setChatStickToBottom(nextStick);
                }}
              >
                {displayedChatMessages.map((item) => <ChatBubble key={item.id} message={item} me={me} />)}
                {displayedChatMessages.length === 0 && <p className="empty">{chatTab === "room" ? "还没有房间聊天" : "大厅还没有留言"}</p>}
              </div>
              {!chatStickToBottom && displayedChatMessages.length > 0 && (
                <button type="button" className="chat-stick-button" onClick={() => stickChatToBottom(chatListRef.current, chatStickToBottomRef, setChatStickToBottom)}>
                  ↓ 回到底部
                </button>
              )}
            </div>
            {chatTab === "room" ? (
              <div className="send-row">
                <input value={chat} onChange={(event) => setChat(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendChat(); }} placeholder="发一句话..." />
                <button onClick={sendChat}>发送</button>
              </div>
            ) : <p className="hint chat-readonly-hint">大厅聊天室在房间内只能查看，回到大厅后可以发送。</p>}
          </div>
        </div>
        <div className="panel round-history">
          <h3 className="sticky-panel-title">
            📜 对局记录
            <span>{visibleRoundHistory.length} / {room.roundHistoryTotal}</span>
          </h3>
          <div className="round-history-list">
            {visibleRoundHistory.map((item) => <RoundHistoryCard key={item.id} item={item} onOpenImage={setPreviewImage} />)}
            {visibleRoundHistory.length < room.roundHistoryTotal && <button className="soft-button" onClick={loadMoreHistory}>加载更多记录</button>}
            {visibleRoundHistory.length === 0 && <p className="empty">还没有对局记录</p>}
          </div>
        </div>
      </div>
      {previewImage && (
        <div className="modal-backdrop image-preview-backdrop" onClick={() => setPreviewImage(null)}>
          <div className="image-preview-modal" onClick={(event) => event.stopPropagation()}>
            <button className="icon-button image-preview-close" onClick={() => setPreviewImage(null)}>×</button>
            <img src={previewImage} alt="惩罚证明大图" />
          </div>
        </div>
      )}
    </section>
  );
}

function OthelloScore({ room }: { room: RoomSnapshot }) {
  const state = room.othello;
  if (!state) {
    const bothReady = room.ready.A && room.ready.B;
    return <p className="settlement-placeholder">{bothReady ? "正在随机先手" : "等待准备"}</p>;
  }
  return (
    <div className="othello-score-mini">
      <span>⚫ {state.blackCount}</span>
      <span>⚪ {state.whiteCount}</span>
      {room.settings.enableRanked && state.rankedDelta && <span className="othello-live-rank">黑 {othelloDeltaText(state, "black")} / 白 {othelloDeltaText(state, "white")}</span>}
      <strong>{state.ended ? room.resultText || "对局结束" : `轮到${state.blackSeat === state.turn ? "黑棋" : "白棋"}`}</strong>
    </div>
  );
}

function TicTacToeScore({ room }: { room: RoomSnapshot }) {
  const state = room.tictactoe;
  if (!state) {
    const bothReady = room.ready.A && room.ready.B;
    return <p className="settlement-placeholder">{bothReady ? "正在随机先手" : "等待准备"}</p>;
  }
  return (
    <div className="tictactoe-score-mini">
      <span>❌ {state.xSeat === "A" ? "A" : "B"}</span>
      <span>⭕ {state.xSeat === "A" ? "B" : "A"}</span>
      {room.settings.enableRanked && state.rankedDelta && <span className="tictactoe-live-rank">X {tictactoeDeltaText(state, "X")} / O {tictactoeDeltaText(state, "O")}</span>}
      <strong>{state.ended ? room.resultText || "对局结束" : `轮到 ${state.xSeat === state.turn ? "X" : "O"}`}</strong>
    </div>
  );
}

function TicTacToePanel({ room, me, now, onMove, onReady, onRestart, onGiveawayChoice }: { room: RoomSnapshot; me: PublicPlayer; now: number; onMove: (row: number, col: number) => void; onReady: () => void; onRestart: () => void; onGiveawayChoice: (mode: "normal" | "giveaway") => void }) {
  const state = room.tictactoe;
  const mySeat = room.seats.A?.id === me.id ? "A" : room.seats.B?.id === me.id ? "B" : null;
  const giveawayPrompt = state?.giveawayPrompt;
  const giveawayBlockingTurn = Boolean(giveawayPrompt && giveawayPrompt.seat === state?.turn);
  const isMyGiveawayPrompt = Boolean(state && mySeat && giveawayPrompt?.seat === mySeat && room.phase === "choosing" && !state.ended);
  const isMyTurn = Boolean(state && mySeat && state.turn === mySeat && room.phase === "choosing" && !state.ended && !giveawayBlockingTurn);
  const waitingForReady = room.phase === "ready" && Boolean(room.seats.A && room.seats.B);
  const drawingFirst = waitingForReady && room.ready.A && room.ready.B;
  const myReady = mySeat ? room.ready[mySeat] : false;
  const turnName = state?.turn === "A" ? occupantDisplay(room.seats.A) : occupantDisplay(room.seats.B);
  const giveawayPromptName = giveawayPrompt?.seat === "A" ? occupantDisplay(room.seats.A) : occupantDisplay(room.seats.B);
  const giveawaySecondsLeft = giveawayPrompt ? Math.max(0, Math.ceil((giveawayPrompt.expiresAt - now) / 1000)) : 0;
  const tictactoeGiveawayGain = formatGiveawayValue(0.3);
  const xSeat = state?.xSeat;
  const oSeat = xSeat ? xSeat === "A" ? "B" : "A" : null;
  const winningKeys = new Set((state?.winningLine || []).map((cell) => `${cell.row}-${cell.col}`));
  const board = state?.board || Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => null));
  const boardTheme = tictactoeThemeStyle(room.settings.tictactoeBoardTheme);
  return (
    <div className="tictactoe-panel">
      <div className="tictactoe-head">
        <div>
          <h3>❌⭕ 井字棋</h3>
          <p className="hint">
            {!room.seats.A || !room.seats.B
              ? "等待两个战斗席坐满。"
              : drawingFirst
                ? "正在随机 X/O 先手..."
                : waitingForReady
                  ? "双方准备后随机决定谁执 X 先手。"
                  : state?.ended
                    ? room.resultText || "对局结束"
                    : giveawayPrompt?.forced
                      ? "强制白给中，系统正在随机落子..."
                      : giveawayPrompt
                        ? isMyGiveawayPrompt ? "请选择不白给或白给落子。" : `等待 ${giveawayPromptName} 选择是否白给。`
                    : isMyTurn ? "轮到你落子。" : `轮到 ${turnName} 落子。`}
          </p>
        </div>
        {state && (
          <div className="tictactoe-turn-card">
            <span>{state.xSeat === state.turn ? "❌ X" : "⭕ O"}</span>
            <strong>{state.moveCount} / 9</strong>
            {room.settings.enableRanked && state.rankedDelta && <small>本局排位：X {tictactoeDeltaText(state, "X")} / O {tictactoeDeltaText(state, "O")}</small>}
          </div>
        )}
      </div>
      {waitingForReady && (
        <div className={`tictactoe-ready-card ${drawingFirst ? "drawing" : ""}`}>
          <div className="tictactoe-draw-animation" aria-hidden="true">
            <span>❌</span>
            <span>⭕</span>
            <span>❌</span>
          </div>
          <div>
            <strong>{drawingFirst ? "抽签中..." : myReady ? "你已准备" : "准备开始"}</strong>
            <p className="hint">A：{room.ready.A ? "已准备" : "未准备"} · B：{room.ready.B ? "已准备" : "未准备"}</p>
          </div>
          {mySeat && !myReady && !drawingFirst && <button className="primary" onClick={onReady}>准备</button>}
          {mySeat && myReady && !drawingFirst && <button disabled>等待对方</button>}
        </div>
      )}
      {giveawayPrompt && room.phase === "choosing" && !state?.ended && (
        <div className={`othello-settlement-card tictactoe-giveaway-card ${giveawayPrompt.forced ? "forced" : ""}`}>
          <div>
            <strong>{giveawayPrompt.forced ? "强制白给" : isMyGiveawayPrompt ? "选择本手结算" : "等待本手结算"}</strong>
            <p className="hint">
              {giveawayPrompt.forced
                ? `${giveawayPromptName} 触发强制白给，将在 ${giveawaySecondsLeft} 秒后自动随机乱下。`
                : isMyGiveawayPrompt
                  ? `${giveawaySecondsLeft} 秒后自动选择不白给。`
                  : `等待 ${giveawayPromptName} 选择，${giveawaySecondsLeft} 秒后默认不白给。`}
            </p>
            <p className="othello-settlement-help">
              不白给：正常手动落子；白给：系统随机选择一个空格落子，白给值 +{tictactoeGiveawayGain}%。
            </p>
          </div>
          {giveawayPrompt.forced ? (
            <div className="othello-settlement-forced">
              <span>🫴 白给乱下</span>
            </div>
          ) : isMyGiveawayPrompt ? (
            <div className="othello-settlement-actions tictactoe-giveaway-actions">
              <button className="primary" onClick={() => onGiveawayChoice("normal")}>不白给</button>
              <button className="soft-button" onClick={() => onGiveawayChoice("giveaway")}>白给 +{tictactoeGiveawayGain}%</button>
            </div>
          ) : (
            <div className="othello-settlement-forced">
              <span>⏳ 等待选择</span>
            </div>
          )}
        </div>
      )}
      {state?.ended && mySeat && room.phase === "result" && <button className="primary tictactoe-restart-button" onClick={onRestart}>再来一局</button>}
      <div className="tictactoe-board" role="grid" aria-label="井字棋棋盘" style={boardTheme}>
        {board.map((row, rowIndex) => row.map((cell, colIndex) => {
          const winning = winningKeys.has(`${rowIndex}-${colIndex}`);
          return (
            <button
              type="button"
              className={`tictactoe-cell ${cell ? cell.toLowerCase() : ""} ${winning ? "winning" : ""}`}
              key={`${rowIndex}-${colIndex}`}
              disabled={!isMyTurn || Boolean(cell)}
              onClick={() => onMove(rowIndex, colIndex)}
              aria-label={`第 ${rowIndex + 1} 行第 ${colIndex + 1} 列`}
            >
              {cell ? (cell === "X" ? "×" : "○") : ""}
            </button>
          );
        }))}
      </div>
      <div className="tictactoe-legend">
        <span>❌ X：{xSeat ? occupantDisplay(room.seats[xSeat]) : "准备后随机"}</span>
        <span>⭕ O：{oSeat ? occupantDisplay(room.seats[oSeat]) : "准备后随机"}</span>
        <span>{mySeat ? `你在战斗席 ${mySeat}` : "你正在观战"}</span>
      </div>
    </div>
  );
}

function tictactoeDeltaText(state: NonNullable<RoomSnapshot["tictactoe"]>, mark: "X" | "O") {
  const seat = mark === "X" ? state.xSeat : state.xSeat === "A" ? "B" : "A";
  const delta = state.rankedDelta?.[seat] || 0;
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

function OthelloPanel({ room, me, now, onMove, onSettle, onRestart, onReady, onRequestSurrender, onRespondSurrender, onEscape }: { room: RoomSnapshot; me: PublicPlayer; now: number; onMove: (row: number, col: number) => void; onSettle: (mode: "normal" | "giveaway" | "tribute") => void; onRestart: () => void; onReady: () => void; onRequestSurrender: () => void; onRespondSurrender: (accept: boolean) => void; onEscape: () => void }) {
  const state = room.othello;
  const boardTheme = othelloThemeStyle(room.settings.othelloBoardTheme);
  const mySeat = room.seats.A?.id === me.id ? "A" : room.seats.B?.id === me.id ? "B" : null;
  const pending = state?.pendingSettlement;
  const isMyTurn = Boolean(state && mySeat && state.turn === mySeat && room.phase === "choosing" && !state.ended && !pending);
  const legalKeys = new Set((state?.legalMoves || []).map((move) => `${move.row}-${move.col}`));
  const turnName = state?.turn === "A" ? occupantDisplay(room.seats.A) : occupantDisplay(room.seats.B);
  const waitingForReady = room.phase === "ready" && Boolean(room.seats.A && room.seats.B);
  const drawingFirst = waitingForReady && room.ready.A && room.ready.B;
  const myReady = mySeat ? room.ready[mySeat] : false;
  const canSurrender = Boolean(mySeat && state && room.phase === "choosing" && !state.ended && !pending);
  const surrenderRequest = state?.surrenderRequest;
  const surrenderFromMe = Boolean(mySeat && surrenderRequest?.fromSeat === mySeat);
  const surrenderToMe = Boolean(mySeat && surrenderRequest?.toSeat === mySeat);
  const surrenderFromName = surrenderRequest ? occupantDisplay(room.seats[surrenderRequest.fromSeat]) : "";
  const blackSeat = state?.blackSeat;
  const whiteSeat = blackSeat ? (blackSeat === "A" ? "B" : "A") : null;
  return (
    <div className="othello-panel">
      <div className="othello-head">
        <div>
          <h3>⚫⚪ 黑白棋</h3>
          <p className="hint">
            {!room.seats.A || !room.seats.B
              ? "等待两个战斗席坐满。"
              : drawingFirst
                ? "正在随机执黑先手..."
                : waitingForReady
                  ? "双方准备后随机决定谁执黑先手。"
                  : state?.ended
                    ? room.resultText || "对局结束"
                    : pending ? "正在结算本手白给/上贡。" : isMyTurn ? "轮到你落子。" : `轮到 ${turnName} 落子。`}
          </p>
        </div>
        {state && (
          <div className="othello-turn-card">
            <span>{state.blackSeat === state.turn ? "⚫ 黑棋" : "⚪ 白棋"}</span>
            <strong>{state.blackCount} : {state.whiteCount}</strong>
            {room.settings.enableRanked && state.rankedDelta && <small>本局排位：黑 {othelloDeltaText(state, "black")} / 白 {othelloDeltaText(state, "white")}</small>}
          </div>
        )}
      </div>
      {waitingForReady && (
        <div className={`othello-ready-card ${drawingFirst ? "drawing" : ""}`}>
          <div className="othello-draw-animation" aria-hidden="true">
            <span>⚫</span>
            <span>⚪</span>
            <span>⚫</span>
          </div>
          <div>
            <strong>{drawingFirst ? "抽签中..." : myReady ? "你已准备" : "准备开始"}</strong>
            <p className="hint">A：{room.ready.A ? "已准备" : "未准备"} · B：{room.ready.B ? "已准备" : "未准备"}</p>
          </div>
          {mySeat && !myReady && !drawingFirst && <button className="primary" onClick={onReady}>准备</button>}
          {mySeat && myReady && !drawingFirst && <button disabled>等待对方</button>}
        </div>
      )}
      {state?.ended && mySeat && room.phase === "result" && <button className="primary othello-restart-button" onClick={onRestart}>再来一局</button>}
      {canSurrender && surrenderRequest && (
        <div className={`othello-surrender-card ${surrenderToMe ? "needs-action" : ""}`}>
          <div>
            <strong>{surrenderFromMe ? "已申请认输" : `${surrenderFromName} 申请认输`}</strong>
            <p className="hint">{surrenderFromMe ? "等待对方确认；对局状态会保持不变。" : "你可以同意结束本局，或拒绝后继续下棋。"}</p>
          </div>
          {surrenderToMe && (
            <div className="othello-surrender-actions">
              <button className="primary" onClick={() => onRespondSurrender(true)}>同意认输</button>
              <button className="soft-button" onClick={() => onRespondSurrender(false)}>拒绝，继续下棋</button>
            </div>
          )}
        </div>
      )}
      {canSurrender && (
        <div className="othello-risk-actions">
          <button className="soft-button othello-surrender-button" disabled={Boolean(surrenderRequest)} onClick={onRequestSurrender}>
            申请认输
          </button>
          <button className="soft-button danger-soft othello-surrender-button" onClick={onEscape}>
            逃跑
          </button>
        </div>
      )}
      {pending && (
        <OthelloSettlementCard
          room={room}
          me={me}
          pending={pending}
          now={now}
          onSettle={onSettle}
        />
      )}
      <div className="othello-board" role="grid" aria-label="黑白棋棋盘" style={boardTheme}>
        {(state?.board || Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null))).map((row, rowIndex) => row.map((cell, colIndex) => {
          const legal = legalKeys.has(`${rowIndex}-${colIndex}`);
          return (
            <button
              type="button"
              className={`othello-cell ${cell || ""} ${legal ? "legal" : ""}`}
              key={`${rowIndex}-${colIndex}`}
              disabled={!isMyTurn || !legal}
              onClick={() => onMove(rowIndex, colIndex)}
              aria-label={`第 ${rowIndex + 1} 行第 ${colIndex + 1} 列`}
            >
              {cell && <span className={`othello-disc ${cell}`} />}
              {!cell && legal && <span className="othello-legal-dot" />}
            </button>
          );
        }))}
      </div>
      <div className="othello-legend">
        <span>⚫ 黑棋：{blackSeat ? occupantDisplay(room.seats[blackSeat]) : "准备后随机"}</span>
        <span>⚪ 白棋：{whiteSeat ? occupantDisplay(room.seats[whiteSeat]) : "准备后随机"}</span>
        <span>{mySeat ? `你在战斗席 ${mySeat}` : "你正在观战"}</span>
      </div>
    </div>
  );
}

function othelloThemeStyle(themeId?: RoomSettings["othelloBoardTheme"]): CSSProperties {
  const theme = othelloBoardThemes.find((item) => item.id === themeId) || othelloBoardThemes[0];
  return {
    "--othello-board": theme.board,
    "--othello-cell": theme.cell,
    "--othello-line": theme.line,
    "--othello-hover": theme.hover,
    "--othello-border": theme.border,
    "--othello-black-disc": theme.blackDisc,
    "--othello-white-disc": theme.whiteDisc,
    "--othello-black-ring": theme.blackRing,
    "--othello-white-ring": theme.whiteRing
  } as CSSProperties;
}

function tictactoeThemeStyle(themeId?: RoomSettings["tictactoeBoardTheme"]): CSSProperties {
  const theme = tictactoeBoardThemes.find((item) => item.id === themeId) || tictactoeBoardThemes[0];
  return {
    "--ttt-board": theme.board,
    "--ttt-cell": theme.cell,
    "--ttt-line": theme.line,
    "--ttt-hover": theme.hover,
    "--ttt-border": theme.border,
    "--ttt-x": theme.x,
    "--ttt-o": theme.o,
    "--ttt-win": theme.win
  } as CSSProperties;
}

function othelloDeltaText(state: NonNullable<RoomSnapshot["othello"]>, color: "black" | "white") {
  const seat = color === "black" ? state.blackSeat : state.blackSeat === "A" ? "B" : "A";
  const delta = state.rankedDelta?.[seat] || 0;
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

function OthelloSettlementCard({ room, me, pending, now, onSettle }: { room: RoomSnapshot; me: PublicPlayer; pending: NonNullable<NonNullable<RoomSnapshot["othello"]>["pendingSettlement"]>; now: number; onSettle: (mode: "normal" | "giveaway" | "tribute") => void }) {
  const isMine = room.seats[pending.seat]?.id === me.id;
  const actorName = occupantDisplay(room.seats[pending.seat]);
  const opponentName = occupantDisplay(room.seats[pending.opponentSeat]);
  const secondsLeft = Math.max(0, Math.ceil((pending.expiresAt - now) / 1000));
  const forcedText = pending.forced === "tribute" ? "强制上贡" : pending.forced === "giveaway" ? "强制白给" : "";
  const giveawayGain = formatGiveawayValue(pending.flips * 0.1);
  const tributeGain = formatGiveawayValue(pending.flips * 0.2);
  return (
    <div className={`othello-settlement-card ${pending.forced ? "forced" : ""}`}>
      <div>
        <strong>{pending.forced ? forcedText : isMine ? "选择本手结算" : "等待本手结算"}</strong>
        <p className="hint">
          {actorName} 本手翻 {pending.flips} 子，基础分 {pending.stake}。
          {pending.forced ? ` ${forcedText}将在 ${secondsLeft} 秒后自动结算。` : isMine ? ` ${secondsLeft} 秒后自动选择不白给。` : ` 等待 ${actorName} 选择，${secondsLeft} 秒后默认不白给。`}
        </p>
        <p className="othello-settlement-help">
          不白给：本手按 {pending.stake} 分正常结算；白给：本手不结算排位分，白给值 +{giveawayGain}%；上贡：对方拿本手收益，你的白给值 +{tributeGain}%。
        </p>
      </div>
      {pending.forced ? (
        <div className="othello-settlement-forced">
          <span>{pending.forced === "tribute" ? "🎁 上贡给对方" : "🫴 白给本手"}</span>
        </div>
      ) : isMine ? (
        <div className="othello-settlement-actions">
          <button className="primary" onClick={() => onSettle("normal")}>不白给</button>
          <button className="soft-button" onClick={() => onSettle("giveaway")}>白给 +{giveawayGain}%</button>
          <button className="soft-button danger-soft" onClick={() => onSettle("tribute")}>上贡给 {opponentName} +{tributeGain}%</button>
        </div>
      ) : (
        <div className="othello-settlement-forced">
          <span>⏳ 等待选择</span>
        </div>
      )}
    </div>
  );
}

function occupantDisplay(occupant: SeatOccupant) {
  if (!occupant) return "空位";
  return "isBot" in occupant ? occupant.name : displayPlayerName(occupant);
}

function RoundHistoryCard({ item, onOpenImage }: { item: RoomSnapshot["roundHistory"][number]; onOpenImage: (imageUrl: string) => void }) {
  const proofByPlayer = new Map(item.proofs.map((proof) => [proof.playerId, proof]));
  const taskPlayerIds = new Set(item.punishmentTasks.map((task) => task.playerId));
  const looseProofs = item.proofs.filter((proof) => !taskPlayerIds.has(proof.playerId));
  return (
    <article className="history-card">
      <header className="history-card-head">
        <div>
          <b>第 {item.round} 局</b>
          <small>{new Date(item.at).toLocaleTimeString()}</small>
        </div>
        <div className="history-tags">
          {item.gameId === "othello" && <em>⚫⚪ 黑白棋</em>}
          {item.gameId === "tictactoe" && <em>❌⭕ 井字棋</em>}
          {item.ranked && <em>🏆 {item.gameId === "othello" ? `${item.stake}分/子${item.rankMultiplier && item.rankMultiplier > 1 ? ` ×${item.rankMultiplier}` : ""}` : `${item.stake}分${item.rankMultiplier && item.rankMultiplier > 1 ? ` ×${item.rankMultiplier}` : ""}`}</em>}
          {item.extremeRanked && <em>⚡ 极限</em>}
          {item.punishedNames.length > 0 && <em>🎲 惩罚</em>}
        </div>
      </header>
      <div className="history-duel">
        <div className="history-side">
          <span>{item.playerA}</span>
          <strong>{historySeatLabel(item, "A")}</strong>
        </div>
        <div className="history-result">
          <small>{item.gameId === "othello" && item.othelloScore ? `${item.othelloScore.black} : ${item.othelloScore.white}` : item.gameId === "tictactoe" ? "3 × 3" : "VS"}</small>
          <b>{item.resultLabel || historyResultText(item.result)}</b>
        </div>
        <div className="history-side">
          <span>{item.playerB}</span>
          <strong>{historySeatLabel(item, "B")}</strong>
        </div>
      </div>
      {item.punishedNames.length > 0 && (
        <section className="history-section">
          <div className="history-punishment-summary">
            <b>{item.punishmentName || "惩罚"}</b>
            <small>{item.punishedNames.join("、")}</small>
          </div>
          {item.punishmentTasks.map((task) => (
            <div
              className={`history-task ${task.backgroundImage ? "has-task-background" : ""}`}
              key={`${item.id}-${task.playerId}-task`}
              style={task.backgroundImage ? { "--task-bg": `url(${task.backgroundImage})`, "--task-bg-opacity": String(task.backgroundOpacity ?? 0.22) } as CSSProperties : undefined}
            >
              <small>{task.playerName} 的任务{task.assignedByName ? ` · ${task.assignedByName} 发布` : ""}</small>
              <p>{task.taskText ? taskTextOnly(task.taskText, task.factionLabel) : "等待玩家发布任务"}</p>
              {proofByPlayer.has(task.playerId) && (
                <div className="history-proof inline">
                  <span>任务反馈</span>
                  <p>{proofByPlayer.get(task.playerId)!.text}</p>
                  {proofByPlayer.get(task.playerId)!.rejectReason && <small>审核：{proofByPlayer.get(task.playerId)!.rejectReason}</small>}
                  {proofByPlayer.get(task.playerId)!.imageUrl && <button className="history-proof-image-button" onClick={() => onOpenImage(proofByPlayer.get(task.playerId)!.imageUrl!)}><img src={proofByPlayer.get(task.playerId)!.imageUrl} alt="惩罚证明" loading="lazy" decoding="async" /></button>}
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      {looseProofs.length > 0 && (
        <section className="history-section">
          <b>完成证明</b>
          {looseProofs.map((proof) => (
            <div className="history-proof" key={`${item.id}-${proof.playerId}`}>
              <span>{proof.playerName}</span>
              <p>{proof.text}</p>
              {proof.rejectReason && <small>审核：{proof.rejectReason}</small>}
              {proof.imageUrl && <button className="history-proof-image-button" onClick={() => onOpenImage(proof.imageUrl!)}><img src={proof.imageUrl} alt="惩罚证明" loading="lazy" decoding="async" /></button>}
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

function historySeatLabel(item: RoomSnapshot["roundHistory"][number], seat: SeatKey) {
  if (item.gameId === "othello") {
    return item.othelloBlackSeat === seat ? "⚫ 黑棋" : "⚪ 白棋";
  }
  if (item.gameId === "tictactoe") {
    return item.tictactoeXSeat === seat ? "❌ X" : "⭕ O";
  }
  return choiceText(seat === "A" ? item.moveA : item.moveB);
}

function canAssignPunishmentTask(room: RoomSnapshot, currentPlayerId: string, punishedPlayerId: string, assignedBy?: string) {
  if (assignedBy) return assignedBy === currentPlayerId;
  const punishedSeat = room.seats.A?.id === punishedPlayerId ? "A" : room.seats.B?.id === punishedPlayerId ? "B" : null;
  if (!punishedSeat) return false;
  const opponent = punishedSeat === "A" ? room.seats.B : room.seats.A;
  return Boolean(opponent && !("isBot" in opponent) && opponent.id === currentPlayerId);
}

function RoomPlayerRow({ player, role, now }: { player: PublicPlayer; role: string; now: number }) {
  return (
    <div className="room-player-row">
      <div className="room-player-main">
        <PlayerBadge player={player} />
        <div className="room-player-tags">
          <em>{role}</em>
          <OfflineBadge player={player} now={now} />
        </div>
      </div>
      <small className="room-player-stats">
        全局：{player.stats.wins}胜 {player.stats.losses}负 {player.stats.draws}平 · {player.stats.punishments}惩罚 · 胜率 {winRateText(player)} · {player.stats.rankedPoints}分
      </small>
    </div>
  );
}

function OfflineBadge({ player, now }: { player: PublicPlayer; now: number }) {
  if (player.connected) return null;
  const seconds = player.disconnectExpiresAt ? Math.max(0, Math.ceil((player.disconnectExpiresAt - now) / 1000)) : 0;
  return <em className="offline-badge">离线 {seconds}s</em>;
}

function PunishmentStatus({ proof, isMine, requireConfirm }: { proof: RoomSnapshot["proofs"][number]; isMine: boolean; requireConfirm: boolean }) {
  if (proof.status === "rejected") {
    return <p className="task-card danger"><b>{isMine ? "对方要求你重做" : "已要求对方重做"}</b>{proof.redoTaskText || "请重新完成任务。"}</p>;
  }
  if (proof.status === "approved" || proof.confirmedBy) {
    if (proof.rejectReason === "双方互相放过，下一局正常开始。") {
      return <p className="task-card success"><b>双方互相放过</b>下一局正常开始。</p>;
    }
    return <p className="task-card success"><b>{proof.rejectReason === "对方选择放过你" ? "对方选择放过你" : isMine ? "对方已确认完成" : "你已确认完成"}</b>{requireConfirm ? "等待系统进入下一局。" : "准备进入下一局。"}</p>;
  }
  return <p className="task-card"><b>证明已提交</b>{requireConfirm ? (isMine ? "等待对方验证。" : "请验证对方证明。") : "准备进入下一局。"}</p>;
}

function punishedPlayerNames(room: RoomSnapshot) {
  const players = roomPlayerList(room).map((item) => item.player);
  return room.punishedPlayerIds.map((id) => {
    const player = players.find((item) => item.id === id);
    return player ? displayPlayerName(player) : id;
  });
}

function roomPlayerById(room: RoomSnapshot, playerId: string) {
  return roomPlayerList(room).map((item) => item.player).find((player) => player.id === playerId);
}

function punishedPlayerName(room: RoomSnapshot, playerId: string) {
  const player = roomPlayerById(room, playerId);
  return player ? displayPlayerName(player) : playerId;
}

function taskTextOnly(taskText: string, factionLabel?: string) {
  const labels = [factionLabel, "男性阵营", "女性阵营", "男娘阵营", "其他阵营"].filter(Boolean) as string[];
  let result = taskText;
  for (const label of labels) {
    result = result.replace(new RegExp(`^${escapeRegExp(label)}[：:]\\s*`), "");
  }
  return result.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ChatBubble({ message, me }: { message: ChatMessage; me: PublicPlayer }) {
  if (message.system) return <p className="chat-system">{message.text}</p>;
  const mine = message.playerId === me.id;
  return (
    <div className={`chat-bubble-row ${mine ? "mine" : ""}`}>
      {!mine && <ChatAvatar player={message.authorPlayer} />}
      <div className="chat-bubble">
        <div className="chat-meta">
          {message.authorPlayer ? <ChatName player={message.authorPlayer} /> : <b>{message.author}</b>}
          {message.authorRole && <em>{message.authorRole}</em>}
        </div>
        <p>{message.text}</p>
      </div>
      {mine && <ChatAvatar player={message.authorPlayer} />}
    </div>
  );
}

function ChatAvatar({ player }: { player?: PublicPlayer }) {
  const label = player?.nameWarPunished && player.nameWarPenaltyName ? player.nameWarPenaltyName : player?.name;
  return <span className="chat-avatar">{label?.slice(0, 1) || "?"}</span>;
}

function ChatName({ player }: { player: PublicPlayer }) {
  if (player.nameWarPunished && player.nameWarPenaltyName) {
    return (
      <span className="chat-name name-war-chat-name">
        <b>{player.nameWarPenaltyName}</b>
        <GiveawayChip player={player} />
        {!player.connected && <span className="chat-offline">离线</span>}
      </span>
    );
  }
  return (
    <span className="chat-name">
      <span className="chat-gender" style={genderStyle(player)}>{player.genderLabel}</span>
      <span className="chat-title">{player.stats.title}</span>
      <b>{displayPlayerName(player)}</b>
      <GiveawayChip player={player} />
      {!player.connected && <span className="chat-offline">离线</span>}
    </span>
  );
}

function Settlement({ room }: { room: RoomSnapshot }) {
  const latest = room.roundHistory[0];
  if (!latest || room.phase !== "result" && room.phase !== "punishment") return <p className="settlement-placeholder">等待结算</p>;
  return (
    <div className="settlement-pop">
      <span>{choiceText(latest.moveA)} <b>vs</b> {choiceText(latest.moveB)}</span>
      <strong>{latest.resultLabel || historyResultText(latest.result)}</strong>
    </div>
  );
}

function roomPlayerList(room: RoomSnapshot) {
  const result: Array<{ player: PublicPlayer; role: string }> = [];
  for (const seat of ["A", "B"] as SeatKey[]) {
    const occupant = room.seats[seat];
    if (occupant && !("isBot" in occupant)) result.push({ player: occupant, role: "战斗席" });
  }
  for (const player of room.spectators) result.push({ player, role: "观战" });
  return result;
}

function SeatView({ seat, room, me, now, onSit }: { seat: SeatKey; room: RoomSnapshot; me: PublicPlayer; now: number; onSit: () => void }) {
  const occupant = room.seats[seat];
  const choice = room.revealedChoices?.[seat] || (occupant?.id === me.id ? room.choices[seat] : room.choices[seat] ? "hidden" : undefined);
  const stats = room.seatStats[seat];
  const battleSeatBlocked = Boolean(room.settings.enableRanked && Boolean(me.extremeModeEnabled) !== Boolean(room.settings.enableExtremeRanked));
  const othelloTurn = room.settings.gameId === "othello" && room.othello?.turn === seat && room.phase === "choosing" && !room.othello.ended;
  const othelloColorLabel = room.settings.gameId === "othello" && room.othello
    ? room.othello.blackSeat === seat ? "⚫ 黑棋" : "⚪ 白棋"
    : seat === "A" ? "随机后显示黑/白" : "随机后显示黑/白";
  const tictactoeTurn = room.settings.gameId === "tictactoe" && room.tictactoe?.turn === seat && room.phase === "choosing" && !room.tictactoe.ended;
  const tictactoeMarkLabel = room.settings.gameId === "tictactoe" && room.tictactoe
    ? room.tictactoe.xSeat === seat ? "❌ X" : "⭕ O"
    : "随机后显示 X/O";
  return (
    <div className={`seat-card seat-${seat.toLowerCase()}`}>
      <div className="seat-identity">
        <span className="seat-label">玩家 {seat}</span>
        {occupant ? <strong>{"isBot" in occupant ? `🤖 ${occupant.name}` : <PlayerBadge player={occupant} compact />}</strong> : <button disabled={battleSeatBlocked} title={battleSeatBlocked ? "当前排位类型不匹配，只能观战" : "坐到战斗席"} onClick={onSit}>{battleSeatBlocked ? "👀 只能观战" : "🪑 坐下"}</button>}
      </div>
      {occupant && !("isBot" in occupant) && <OfflineBadge player={occupant} now={now} />}
      <p className="choice-badge">
        {room.settings.gameId === "othello"
          ? othelloTurn ? `${othelloColorLabel}落子中` : othelloColorLabel
          : room.settings.gameId === "tictactoe"
            ? tictactoeTurn ? `${tictactoeMarkLabel}落子中` : tictactoeMarkLabel
          : choice ? choiceText(choice) : room.seats.A && room.seats.B ? "🤔 等待出拳" : "⏳ 等人"}
      </p>
      {occupant && !("isBot" in occupant) && <SeatStatsView stats={stats} />}
    </div>
  );
}

function SeatStatsView({ stats }: { stats: RoomSnapshot["seatStats"]["A"] }) {
  const decisive = stats.wins + stats.losses;
  const rate = decisive === 0 ? 0 : Math.round((stats.wins / decisive) * 100);
  return <small className="seat-stats">本席：{stats.wins}胜 {stats.losses}负 {stats.draws}平 {stats.punishments}惩罚 · 胜率 {rate}%</small>;
}

function choiceText(choice: Move | "hidden") {
  if (choice === "hidden") return "🔒 已出拳";
  if (choice === "noMove") return "⏳ 未出拳";
  if (choice === "forfeit") return "📴 断线判负";
  if (choice === "giveaway") return "🫴 白给";
  return choice === "rock" ? "✊ 锤子" : choice === "scissors" ? "✌️ 剪刀" : "🖐️ 布";
}

function historyResultText(result: RoundResult) {
  if (result === "doubleLoss") return "双输";
  if (result === "draw") return "平局";
  return `${result} 胜`;
}

type RoomInfoTagView = { key: string; text: string; style: RoomInfoTagStyle };

function roomInfoTag(config: AppConfig, key: string, extra = "", prefix = ""): RoomInfoTagView {
  const fallback: RoomInfoTagStyle = { label: key, textColor: "#4d5c6f", backgroundColor: "#eef3f8", borderColor: "#c9d6e4" };
  const style = config.roomInfoTags?.[key] || fallback;
  return { key: `${key}-${extra}`, text: `${prefix}${style.label}${extra}`, style };
}

function punishmentInfoTag(config: AppConfig, room: RoomSnapshot) {
  if (!room.settings.enablePunishment) return roomInfoTag(config, "noPunishment");
  if (room.settings.punishmentSource === "player") return roomInfoTag(config, "punishment", "：玩家发布任务");
  return roomInfoTag(config, "punishment", punishmentSelectionText(config, room.settings));
}

function rankedInfoExtra(stake: number, multiplier = 1, gameId: RoomSettings["gameId"] = "rps") {
  if (gameId === "othello") return multiplier > 1 ? ` ${stake} 分/子 ×${multiplier}` : ` ${stake} 分/子`;
  return multiplier > 1 ? ` ${stake} 分 ×${multiplier}` : ` ${stake} 分`;
}

function roomInfoTags(config: AppConfig, room: RoomSnapshot) {
  const phaseKey = room.phase === "ready" ? "phaseReady" : room.phase === "choosing" ? "phaseChoosing" : room.phase === "result" ? "phaseResult" : room.phase === "punishment" ? "phasePunishment" : "phaseReady";
  const multiplier = rankMultiplierForSettings(room.settings);
  const tags: RoomInfoTagView[] = [
    gameInfoTag(config, room.settings.gameId),
    roomInfoTag(config, phaseKey),
    room.settings.enableRanked ? roomInfoTag(config, "ranked", rankedInfoExtra(room.settings.stake, multiplier, room.settings.gameId)) : roomInfoTag(config, "normal"),
    punishmentInfoTag(config, room)
  ];
  if (room.settings.enableExtremeRanked) tags.push(roomInfoTag(config, "extremeRanked"));
  if (room.settings.enablePunishment) {
    if (room.settings.tieDoublePunish) tags.push(roomInfoTag(config, "tieDoublePunish"));
    if (room.settings.requireOpponentConfirm) tags.push(roomInfoTag(config, "requireOpponentConfirm"));
    tags.push(roomInfoTag(config, room.settings.allowProofImage === false ? "textProofOnly" : "allowProofImage"));
  }
  return tags;
}

function lobbyRoomInfoTags(config: AppConfig, room: LobbySnapshot["rooms"][number]) {
  const multiplier = room.rankMultiplier || 1;
  const tags: RoomInfoTagView[] = [
    gameInfoTag(config, room.gameId),
    room.enableRanked ? roomInfoTag(config, "ranked", rankedInfoExtra(room.stake, multiplier, room.gameId)) : roomInfoTag(config, "normal"),
    room.enablePunishment ? roomInfoTag(config, "punishment", punishmentSelectionText(config, room)) : roomInfoTag(config, "noPunishment")
  ];
  if (room.enableExtremeRanked) tags.push(roomInfoTag(config, "extremeRanked"));
  if (room.enablePunishment) {
    if (room.tieDoublePunish) tags.push(roomInfoTag(config, "tieDoublePunish"));
    if (room.requireOpponentConfirm) tags.push(roomInfoTag(config, "requireOpponentConfirm"));
  }
  tags.push({
    key: `opponent-${room.id}`,
    text: room.enableBot ? `Bot ${room.botDifficulty}` : "真人房",
    style: { label: "", textColor: "#4d5c6f", backgroundColor: "#eef3f8", borderColor: "#c9d6e4" }
  });
  return tags;
}

function gameInfoTag(config: AppConfig, gameId: RoomSettings["gameId"]) {
  return gameId === "othello"
    ? roomInfoTag(config, "gameOthello", "", "⚫⚪ ")
    : gameId === "tictactoe"
      ? roomInfoTag(config, "gameTicTacToe", "", "❌⭕ ")
    : roomInfoTag(config, "gameRps");
}

function punishmentSelectionText(config: AppConfig, settings: Pick<RoomSettings, "punishmentId" | "punishmentIds">) {
  const punishments = selectedPunishmentIdsForConfig(config, settings as RoomSettings)
    .map((id) => config.punishments.find((punishment) => punishment.id === id))
    .filter((punishment): punishment is AppConfig["punishments"][number] => Boolean(punishment));
  if (!punishments.length) return "";
  const names = punishments.map((punishment) => punishment.name).join(" / ");
  return punishments.length > 1 ? `：${punishments.length}选1 ${names}` : `：${names}`;
}

function RoomInfoTagList({ tags }: { tags: RoomInfoTagView[] }) {
  return (
    <div className="room-info-tags">
      {tags.map((tag) => (
        <span className="room-info-tag" style={roomInfoTagStyle(tag.style)} key={tag.key}>{tag.text}</span>
      ))}
    </div>
  );
}

function roomInfoTagStyle(style: RoomInfoTagStyle): CSSProperties {
  return {
    "--room-info-text": style.textColor,
    "--room-info-bg": style.backgroundColor,
    "--room-info-border": style.borderColor
  } as CSSProperties;
}

function phaseText(phase: RoomSnapshot["phase"]) {
  if (phase === "ready") return "🪑 等待坐满";
  if (phase === "choosing") return "🤜 出拳中";
  if (phase === "result") return "✨ 结果展示";
  if (phase === "punishment") return "🎲 惩罚阶段";
  return "⏳ 等待中";
}

function connectionStateText(state: "connected" | "connecting" | "disconnected") {
  if (state === "connected") return "已连接";
  if (state === "connecting") return "连接中";
  return "重连中";
}

function Leaderboard({ title, players }: { title: string; players: PublicPlayer[] }) {
  return (
    <div className="panel leaderboard-panel">
      <h2><Crown size={18} /> {title}</h2>
      <div className="leaderboard-list">
        {players.map((player, index) => (
          <p className="rank-row rich" key={player.id}>
            <span>{index + 1}. <PlayerBadge player={player} compact /></span>
            <small>{player.stats.wins}胜 {player.stats.losses}负 {player.stats.draws}平 · {player.stats.punishments}惩罚</small>
            <b>{winRateText(player)} · {player.stats.rankedPoints}分</b>
          </p>
        ))}
        {players.length === 0 && <p className="empty">暂无在线玩家</p>}
      </div>
    </div>
  );
}

type GlobalLeaderboardTab = "positive" | "negative" | "extremePositive" | "extremeNegative" | "nameWar" | "giveaway" | "othelloWins" | "othelloCaptured" | "othelloLost";

function SponsorPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop sponsor-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="sponsor-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title sponsor-title">
          <div>
            <h2><HeartHandshake size={20} /> 赞助支持</h2>
            <p className="hint">喜欢这个小站的话，可以在这里关注、进群或请作者喝杯咖啡。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </div>
        <div className="sponsor-hero">
          <div className="sponsor-hero-icon"><Coffee size={30} /></div>
          <div>
            <strong>谢谢你愿意支持抖喵游戏屋</strong>
            <p>赞助会优先用在服务器、域名和继续加新玩法上。也欢迎只进群提建议。</p>
          </div>
        </div>
        <div className="sponsor-grid">
          {sponsorLinks.map((item) => (
            <a
              className="sponsor-card"
              href={item.href}
              target="_blank"
              rel="noreferrer"
              key={item.id}
              style={{ "--sponsor-tone": item.tone } as CSSProperties}
            >
              <span className="sponsor-icon" aria-hidden="true">{item.id === "telegram" ? <Send size={22} /> : item.icon}</span>
              <span className="sponsor-copy">
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
              <ExternalLink size={16} />
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function GlobalLeaderboardPanel({ players, onClose }: { players: PublicPlayer[]; onClose: () => void }) {
  const [tab, setTab] = useState<GlobalLeaderboardTab>("positive");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const hasTimer = players.some((player) =>
      (player.nameWarRenameProtectedUntil && player.nameWarRenameProtectedUntil > Date.now()) ||
      (player.giveawayBoardExpiresAt && player.giveawayBoardExpiresAt > Date.now())
    );
    if (!hasTimer) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [players]);

  const ranked = leaderboardPlayers(players, tab).slice(0, 50);
  const title = tab === "positive"
    ? "正分榜"
    : tab === "negative"
      ? "负分榜"
      : tab === "extremePositive"
        ? "极限正分榜"
        : tab === "extremeNegative"
          ? "极限负分榜"
          : tab === "nameWar"
            ? "名字争夺战榜"
            : tab === "giveaway"
              ? "白给榜"
              : tab === "othelloWins"
                ? "黑白棋胜场榜"
                : tab === "othelloCaptured"
                  ? "黑白棋吃子榜"
                  : "黑白棋被吃榜";
  return (
    <div className="modal-backdrop leaderboard-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="leaderboard-modal">
        <div className="modal-title">
          <div>
            <h2><Crown size={20} /> 排行榜</h2>
            <p className="hint">排行榜每 10 分钟刷新一次，每类最多显示 50 名。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </div>
        <div className="segmented leaderboard-tabs">
          <button className={tab === "positive" ? "active" : ""} onClick={() => setTab("positive")}>正分</button>
          <button className={tab === "negative" ? "active" : ""} onClick={() => setTab("negative")}>负分</button>
          <button className={tab === "extremePositive" ? "active" : ""} onClick={() => setTab("extremePositive")}>极限正</button>
          <button className={tab === "extremeNegative" ? "active" : ""} onClick={() => setTab("extremeNegative")}>极限负</button>
          <button className={tab === "nameWar" ? "active" : ""} onClick={() => setTab("nameWar")}>名争</button>
          <button className={tab === "giveaway" ? "active" : ""} onClick={() => setTab("giveaway")}>白给</button>
          <button className={tab === "othelloWins" ? "active" : ""} onClick={() => setTab("othelloWins")}>黑白胜</button>
          <button className={tab === "othelloCaptured" ? "active" : ""} onClick={() => setTab("othelloCaptured")}>吃子</button>
          <button className={tab === "othelloLost" ? "active" : ""} onClick={() => setTab("othelloLost")}>被吃</button>
        </div>
        <div className="global-leaderboard-list">
          <h3>{title}</h3>
          {ranked.map((player, index) => (
            <article className="global-rank-card" key={`${tab}-${player.id}`}>
              <div className="global-rank-main">
                <span className="rank-index">#{index + 1}</span>
                <PlayerBadge player={player} compact />
                <span className={`online-dot ${player.connected ? "online" : "offline"}`}>{player.connected ? "在线" : "离线"}</span>
              </div>
              <div className="global-rank-stats">
                {isOthelloLeaderboardTab(tab) ? (
                  <>
                    <span>{player.othelloStats.wins}胜 {player.othelloStats.losses}负 {player.othelloStats.draws}平</span>
                    <span>吃 {player.othelloStats.captured}</span>
                    <span>被吃 {player.othelloStats.lost}</span>
                    <span>净值 {player.othelloStats.captured - player.othelloStats.lost}</span>
                  </>
                ) : (
                  <>
                    <span>{player.stats.rankedPoints} 分</span>
                    <span>{player.stats.wins}胜 {player.stats.losses}负 {player.stats.draws}平</span>
                    <span>{player.stats.punishments} 惩罚</span>
                    <span>胜率 {winRateText(player)}</span>
                  </>
                )}
              </div>
              <LeaderboardExtra player={player} tab={tab} now={now} />
            </article>
          ))}
          {ranked.length === 0 && <p className="empty">暂无玩家上榜</p>}
        </div>
      </section>
    </div>
  );
}

function leaderboardPlayers(players: PublicPlayer[], tab: GlobalLeaderboardTab) {
  const copy = [...players];
  if (tab === "positive") return copy.filter((player) => player.stats.rankedPoints > 0).sort((a, b) => b.stats.rankedPoints - a.stats.rankedPoints || b.stats.wins - a.stats.wins);
  if (tab === "negative") return copy.filter((player) => player.stats.rankedPoints < 0).sort((a, b) => a.stats.rankedPoints - b.stats.rankedPoints || b.stats.losses - a.stats.losses);
  if (tab === "extremePositive") return copy.filter((player) => player.extremeModeEnabled && player.stats.rankedPoints > 0).sort((a, b) => b.stats.rankedPoints - a.stats.rankedPoints || (b.extremeWinStreak || 0) - (a.extremeWinStreak || 0));
  if (tab === "extremeNegative") return copy.filter((player) => player.extremeModeEnabled && player.stats.rankedPoints < 0).sort((a, b) => a.stats.rankedPoints - b.stats.rankedPoints || (b.extremeWinStreak || 0) - (a.extremeWinStreak || 0));
  if (tab === "nameWar") {
    return copy
      .filter((player) => player.nameWarEnabled || player.nameWarPunished)
      .sort((a, b) => Number(Boolean(b.nameWarPunished)) - Number(Boolean(a.nameWarPunished)) || a.stats.rankedPoints - b.stats.rankedPoints);
  }
  if (tab === "othelloWins") {
    return copy
      .filter((player) => player.othelloStats.games > 0)
      .sort((a, b) => b.othelloStats.wins - a.othelloStats.wins || b.othelloStats.captured - a.othelloStats.captured);
  }
  if (tab === "othelloCaptured") {
    return copy
      .filter((player) => player.othelloStats.captured > 0 || player.othelloStats.games > 0)
      .sort((a, b) => b.othelloStats.captured - a.othelloStats.captured || b.othelloStats.wins - a.othelloStats.wins);
  }
  if (tab === "othelloLost") {
    return copy
      .filter((player) => player.othelloStats.lost > 0 || player.othelloStats.games > 0)
      .sort((a, b) => b.othelloStats.lost - a.othelloStats.lost || b.othelloStats.losses - a.othelloStats.losses);
  }
  return copy
    .filter((player) => player.giveawayEnabled || (player.giveawayValue || 0) > 0)
    .sort((a, b) => (b.giveawayValue || 0) - (a.giveawayValue || 0) || b.stats.rankedPoints - a.stats.rankedPoints);
}

function isOthelloLeaderboardTab(tab: GlobalLeaderboardTab) {
  return tab === "othelloWins" || tab === "othelloCaptured" || tab === "othelloLost";
}

function LeaderboardExtra({ player, tab, now }: { player: PublicPlayer; tab: GlobalLeaderboardTab; now: number }) {
  if (isOthelloLeaderboardTab(tab)) {
    return (
      <p className="global-rank-extra">
        ⚫⚪ 黑白棋 {player.othelloStats.games} 局 · 净吃子 {player.othelloStats.captured - player.othelloStats.lost}
      </p>
    );
  }
  if (tab === "nameWar") {
    const protectedMs = player.nameWarRenameProtectedUntil ? Math.max(0, player.nameWarRenameProtectedUntil - now) : 0;
    return (
      <p className="global-rank-extra">
        {player.nameWarPunished ? `失名中：${player.nameWarPenaltyName || "惩罚名生效"}` : "名字争夺战开启"}
        {player.nameWarAllowRename ? " · 允许他人改名" : ""}
        {protectedMs > 0 ? ` · 保护 ${formatDuration(protectedMs)}` : ""}
      </p>
    );
  }
  if (tab === "giveaway") {
    const boardMs = player.giveawayBoardExpiresAt ? Math.max(0, player.giveawayBoardExpiresAt - now) : 0;
    return (
      <p className="global-rank-extra">
        白给 {formatGiveawayValue(player.giveawayValue || 0)}%
        {player.giveawayBoardText && boardMs > 0 ? ` · 已上板 ${formatDuration(boardMs)}` : ""}
        {player.giveawayBoardText ? ` · 👍 ${player.giveawayBoardLikes || 0} / 👎 ${player.giveawayBoardDislikes || 0}` : ""}
      </p>
    );
  }
  if (tab === "extremePositive" || tab === "extremeNegative") {
    return (
      <p className="global-rank-extra">
        ⚡ 极限模式 · 连胜 {player.extremeWinStreak || 0}
      </p>
    );
  }
  return null;
}

function winRateText(player: PublicPlayer) {
  const decisive = player.stats.wins + player.stats.losses;
  return `${decisive === 0 ? 0 : Math.round((player.stats.wins / decisive) * 100)}%`;
}

function isNameWarLoser(player: PublicPlayer) {
  return Boolean(player.nameWarEnabled && player.nameWarAllowRename && player.nameWarPunished && player.stats.rankedPoints <= -1000);
}

function isNameWarLoserVisible(player: PublicPlayer, now = Date.now()) {
  if (!isNameWarLoser(player)) return false;
  if (player.connected) return true;
  return Boolean(player.disconnectedAt && now - player.disconnectedAt <= 1_800_000);
}

function isExtremeRenameTarget(player: PublicPlayer) {
  return Boolean(player.extremeForceClosed);
}

function isRenameTarget(player: PublicPlayer) {
  return isNameWarLoser(player) || isExtremeRenameTarget(player);
}

function isRenameTargetVisible(player: PublicPlayer, now = Date.now()) {
  if (!isRenameTarget(player)) return false;
  if (player.connected) return true;
  return Boolean(player.disconnectedAt && now - player.disconnectedAt <= 1_800_000);
}

function nameWarRenameQuotaLeft(player: PublicPlayer, now = Date.now()) {
  if (!player.nameWarRenameWindowStartedAt || now - player.nameWarRenameWindowStartedAt >= 10_800_000) return 3;
  return Math.max(0, 3 - (player.nameWarRenameCount || 0));
}

function UniversalRenamePanel({ config, targets, me, onError }: { config: AppConfig; targets: PublicPlayer[]; me: PublicPlayer; onError: (message: string) => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const nameWarQuota = nameWarRenameQuotaLeft(me, now);
  const canNameWarRename = me.stats.rankedPoints >= 500 && nameWarQuota > 0;
  const extremeMinPoints = Math.max(1, Math.round(config.extremeMode.forceRenameMinPoints || 1));
  const canExtremeRename = Boolean(me.extremeModeEnabled && me.stats.rankedPoints >= extremeMinPoints);

  useEffect(() => {
    if (!targets.some((player) => (player.nameWarRenameProtectedUntil && player.nameWarRenameProtectedUntil > now) || (player.extremeRenameProtectedUntil && player.extremeRenameProtectedUntil > now))) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [targets, now]);

  async function renameTarget(targetId: string, kind: "nameWar" | "extreme") {
    const name = (inputs[targetId] || "").trim();
    if (!name) return;
    try {
      await ask("nameWar:renameTarget", { targetId, name, kind });
      setInputs((old) => ({ ...old, [targetId]: "" }));
      onError("名字修改成功");
    } catch (error) {
      onError(error instanceof Error ? error.message : "修改失败");
    }
  }

  return (
    <div className="panel name-war-loser-panel">
      <h2>🏷️ {config.nameWar.renamePanelTitle || config.nameWar.loserPanelTitle || "通用改名处"}</h2>
      <p className="hint">名争改名需要 500 分以上，你剩余 {nameWarQuota} / 3 次；极限强关改名需要开启极限模式且至少 {extremeMinPoints} 分。</p>
      <div className="name-war-loser-list">
        {targets.map((player) => {
          const nameWarTarget = isNameWarLoser(player);
          const extremeTarget = isExtremeRenameTarget(player);
          const nameWarProtectedMs = player.nameWarRenameProtectedUntil ? Math.max(0, player.nameWarRenameProtectedUntil - now) : 0;
          const extremeProtectedMs = player.extremeRenameProtectedUntil ? Math.max(0, player.extremeRenameProtectedUntil - now) : 0;
          const offlineKeepMs = !player.connected && player.disconnectedAt ? Math.max(0, 1_800_000 - (now - player.disconnectedAt)) : 0;
          const nameWarProtectedText = nameWarProtectedMs > 0 ? `名争保护 ${Math.ceil(nameWarProtectedMs / 3_600_000)} 小时` : "名争可改";
          const extremeProtectedText = extremeProtectedMs > 0 ? `极限保护 ${Math.ceil(extremeProtectedMs / 3_600_000)} 小时` : "极限可改";
          const inputValue = inputs[player.id] || "";
          const selfTarget = player.id === me.id;
          const nameWarDisabled = !nameWarTarget || !canNameWarRename || selfTarget || nameWarProtectedMs > 0;
          const extremeDisabled = !extremeTarget || !canExtremeRename || selfTarget || extremeProtectedMs > 0;
          return (
            <div className="name-war-loser-card" key={player.id}>
              <div className="admin-card-title">
                <strong>{player.nameWarPenaltyName || player.name}</strong>
                <small>
                  <span className={`online-dot ${player.connected ? "online" : "offline"}`}>{player.connected ? "在线" : "离线"}</span>
                  {player.stats.rankedPoints} 分
                </small>
              </div>
              <div className="room-info-tags">
                {nameWarTarget && <span className="room-info-tag">⚔️ {config.nameWar.nameWarLoserLabel || "名争失格"}</span>}
                {extremeTarget && <span className="room-info-tag">⚡ {config.nameWar.extremeForceClosedLabel || "极限强关"}</span>}
              </div>
              <p className="hint">
                {nameWarTarget ? nameWarProtectedText : ""}
                {nameWarTarget && extremeTarget ? " · " : ""}
                {extremeTarget ? extremeProtectedText : ""}
              </p>
              {offlineKeepMs > 0 && <p className="hint">离线保留：约 {Math.ceil(offlineKeepMs / 60_000)} 分钟后从名单隐藏。</p>}
              {player.nameWarRenamedByName && <p className="hint">名争最后改名者：{player.nameWarRenamedByName}</p>}
              {player.extremeRenamedByName && <p className="hint">极限最后改名者：{player.extremeRenamedByName}</p>}
              <div className="send-row">
                <input value={inputValue} maxLength={12} disabled={selfTarget || (!nameWarTarget && !extremeTarget)} onChange={(event) => setInputs((old) => ({ ...old, [player.id]: event.target.value }))} placeholder={selfTarget ? "不能改自己的名字" : "输入新名字"} />
                {nameWarTarget && <button disabled={nameWarDisabled || !inputValue.trim()} onClick={() => renameTarget(player.id, "nameWar")}>名争改名</button>}
                {extremeTarget && <button disabled={extremeDisabled || !inputValue.trim()} onClick={() => renameTarget(player.id, "extreme")}>极限改名</button>}
              </div>
            </div>
          );
        })}
        {targets.length === 0 && <p className="empty">暂无可改名目标</p>}
      </div>
    </div>
  );
}

function GiveawayPanel({ config, players, me, onError }: { config: AppConfig; players: PublicPlayer[]; me: PublicPlayer; onError: (message: string) => void }) {
  const [text, setText] = useState("");
  const [now, setNow] = useState(Date.now());
  const activeBoards = players
    .filter((player) => player.giveawayBoardText && player.giveawayBoardExpiresAt && player.giveawayBoardExpiresAt > now)
    .sort((a, b) => (b.giveawayBoardSubmittedAt || 0) - (a.giveawayBoardSubmittedAt || 0));
  const myActiveBoard = activeBoards.find((player) => player.id === me.id);
  const canSubmit = Boolean(me.giveawayEnabled && (me.giveawayValue || 0) > 0 && !myActiveBoard);
  const voteQuota = giveawayVoteQuota(me, now);

  useEffect(() => {
    const hasExpiry = players.some((player) => player.giveawayBoardExpiresAt && player.giveawayBoardExpiresAt > Date.now());
    if (!hasExpiry) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [players]);

  async function submitBoard() {
    const cleanText = text.trim();
    if (!cleanText) return;
    try {
      const result = await ask<{ player: PublicPlayer }>("giveaway:submitBoard", { text: cleanText });
      if (result.player.id === me.id) setText("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "上板失败");
    }
  }

  async function vote(targetId: string, voteType: "like" | "dislike") {
    try {
      await ask("giveaway:vote", { targetId, vote: voteType });
    } catch (error) {
      onError(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <div className="panel giveaway-panel">
      <div className="panel-title compact-title">
        <h2>🫴 {config.giveaway.panelTitle}</h2>
        <span>{activeBoards.length} 条</span>
      </div>
      <p className="hint">{config.giveaway.panelDescription}</p>
      {canSubmit && (
        <div className="giveaway-submit">
          <textarea value={text} maxLength={300} onChange={(event) => setText(event.target.value)} placeholder={config.giveaway.submitPlaceholder} />
          <button className="primary small" onClick={submitBoard}>上板 12 小时</button>
        </div>
      )}
      {myActiveBoard && <p className="hint">你已经上板，过期后才能重新提交。当前剩余 {formatDuration((myActiveBoard.giveawayBoardExpiresAt || now) - now)}。</p>}
      {!canSubmit && me.giveawayEnabled && <p className="hint">你的白给值已经是 {formatGiveawayValue(me.giveawayValue || 0)}%，归零后可以在个人设置关闭模式。</p>}
      <div className="giveaway-board-list">
        {activeBoards.map((player) => {
          const isSelf = player.id === me.id;
          const expiresText = player.giveawayBoardExpiresAt ? formatDuration(player.giveawayBoardExpiresAt - now) : "";
          return (
            <article className="giveaway-card" key={player.id}>
              <div className="giveaway-card-head">
                <PlayerBadge player={player} />
              </div>
              <p className="giveaway-board-text">{player.giveawayBoardText}</p>
              <div className="giveaway-card-meta">
                <span>剩余 {expiresText}</span>
                <span>👍 {player.giveawayBoardLikes || 0} · 👎 {player.giveawayBoardDislikes || 0}</span>
              </div>
              <div className="giveaway-quota-line">
                <span>我的额度：👍 还可 {voteQuota.likesLeft}/3 · 👎 还可 {voteQuota.dislikesLeft}/10</span>
                <span>{voteQuota.refreshText}</span>
              </div>
              <div className="giveaway-actions">
                <button disabled={isSelf || voteQuota.likesLeft <= 0} onClick={() => vote(player.id, "like")}>👍 -1%</button>
                <button disabled={isSelf || voteQuota.dislikesLeft <= 0} onClick={() => vote(player.id, "dislike")}>👎 +0.1%</button>
              </div>
            </article>
          );
        })}
        {activeBoards.length === 0 && <p className="empty">{config.giveaway.emptyText}</p>}
      </div>
    </div>
  );
}

function giveawayVoteQuota(player: PublicPlayer, now: number) {
  const startedAt = player.giveawayVoteWindowStartedAt || 0;
  const windowMs = 3_600_000;
  const expired = !startedAt || now - startedAt >= windowMs;
  const likesUsed = expired ? 0 : player.giveawayVoteLikesThisHour || 0;
  const dislikesUsed = expired ? 0 : player.giveawayVoteDislikesThisHour || 0;
  return {
    likesLeft: Math.max(0, 3 - likesUsed),
    dislikesLeft: Math.max(0, 10 - dislikesUsed),
    refreshText: expired ? "额度可用" : `额度 ${formatDuration(startedAt + windowMs - now)}后刷新`
  };
}

function formatGiveawayValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

function ProfilePanel({ config, me, onClose, onUpdated, onError }: { config: AppConfig; me: PublicPlayer; onClose: () => void; onUpdated: (player: PublicPlayer) => void; onError: (message: string) => void }) {
  const [name, setName] = useState(me.name);
  const [genderId, setGenderId] = useState(me.genderId);
  const [nameWarEnabled, setNameWarEnabled] = useState(Boolean(me.nameWarEnabled));
  const [nameWarAllowRename, setNameWarAllowRename] = useState(Boolean(me.nameWarAllowRename));
  const [giveawayEnabled, setGiveawayEnabled] = useState(Boolean(me.giveawayEnabled));
  const [extremeModeEnabled, setExtremeModeEnabled] = useState(Boolean(me.extremeModeEnabled));
  const [now, setNow] = useState(Date.now());
  const decisive = me.stats.wins + me.stats.losses;
  const winRate = decisive === 0 ? 0 : Math.round((me.stats.wins / decisive) * 100);
  const total = me.stats.wins + me.stats.losses + me.stats.draws;
  const nameChanged = name.trim() !== me.name;
  const cooldownMs = me.profileUpdatedAt ? Math.max(0, 60_000 - (now - me.profileUpdatedAt)) : 0;
  const nameCooldownSeconds = Math.ceil(cooldownMs / 1000);
  const nameWarChanged = nameWarEnabled !== Boolean(me.nameWarEnabled);
  const nameWarAllowRenameChanged = nameWarAllowRename !== Boolean(me.nameWarAllowRename);
  const nameWarCooldownMs = me.nameWarToggledAt ? Math.max(0, 43_200_000 - (now - me.nameWarToggledAt)) : 0;
  const nameWarCooldownHours = Math.ceil(nameWarCooldownMs / 3_600_000);
  const nameLockedByWar = Boolean(me.nameWarEnabled || nameWarEnabled);
  const giveawayValue = me.giveawayValue || 0;
  const giveawayCannotClose = Boolean(me.giveawayEnabled && !giveawayEnabled && giveawayValue > 0);
  const extremeModeChanged = extremeModeEnabled !== Boolean(me.extremeModeEnabled);
  const extremeCooldownMs = me.extremeModeCooldownUntil ? Math.max(0, me.extremeModeCooldownUntil - now) : 0;
  const extremeCooldownHours = Math.ceil(extremeCooldownMs / 3_600_000);
  const extremeCannotEnable = Boolean(!me.extremeModeEnabled && extremeModeEnabled && (me.stats.rankedPoints < 0 || extremeCooldownMs > 0));
  const extremeCannotClose = Boolean(me.extremeModeEnabled && !extremeModeEnabled && me.stats.rankedPoints <= 0);

  useEffect(() => {
    if (!cooldownMs && !nameWarCooldownMs && !extremeCooldownMs) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownMs, nameWarCooldownMs, extremeCooldownMs]);

  useEffect(() => {
    if (!nameWarEnabled) setNameWarAllowRename(false);
  }, [nameWarEnabled]);

  async function saveProfile() {
    if (nameChanged && nameLockedByWar) {
      onError("名字争夺战开启后不能修改名字");
      return;
    }
    if (nameChanged && cooldownMs > 0) {
      onError(`改名冷却中，请 ${nameCooldownSeconds} 秒后再试`);
      return;
    }
    if ((nameWarChanged || nameWarAllowRenameChanged) && nameWarCooldownMs > 0) {
      onError(`名字争夺战冷却中，请 ${nameWarCooldownHours} 小时后再试`);
      return;
    }
    if (giveawayCannotClose) {
      onError("白给值归零前不能关闭白给模式");
      return;
    }
    if (extremeCannotEnable) {
      onError(extremeCooldownMs > 0 ? `极限模式冷却中，请 ${extremeCooldownHours} 小时后再开启` : "负分玩家不能开启极限模式");
      return;
    }
    if (extremeCannotClose) {
      onError("排位分必须大于 0 才能关闭极限模式，0 分不能关闭");
      return;
    }
    if (!me.extremeModeEnabled && extremeModeEnabled) {
      const ok = window.confirm("开启极限模式会把当前排位分归零，并禁止进入倍率房。胜负平和惩罚次数会保留。确认开启？");
      if (!ok) return;
    }
    try {
      const result = await ask<{ player: PublicPlayer }>("player:updateProfile", { name, genderId, nameWarEnabled, nameWarAllowRename, giveawayEnabled, extremeModeEnabled });
      onUpdated(result.player);
      onError("个人资料已更新");
    } catch (error) {
      onError(error instanceof Error ? error.message : "保存失败");
    }
  }

  async function forceCloseExtremeMode() {
    const ok = window.confirm(config.extremeMode.forceCloseWarning || "强行关闭极限模式后，你会进入通用改名处，可被符合条件的极限玩家改名。确认继续？");
    if (!ok) return;
    try {
      const result = await ask<{ player: PublicPlayer }>("extreme:forceClose", {});
      setExtremeModeEnabled(false);
      onUpdated(result.player);
      onError("已强行关闭极限模式");
    } catch (error) {
      onError(error instanceof Error ? error.message : "强行关闭失败");
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="profile-panel" onClick={(event) => event.stopPropagation()}>
        <div className="profile-hero">
          <div className="avatar-ring"><UserRound size={34} /></div>
          <div>
            <h2><PlayerBadge player={me} /></h2>
            <p>{me.nameWarPunished ? "名字争夺战惩罚名生效中" : `${me.stats.title} · ${me.stats.rankedPoints} 排位积分`}</p>
          </div>
          <button className="profile-close-button" type="button" aria-label="关闭个人设置" onClick={onClose}>×</button>
        </div>

        <div className="profile-stats">
          <Stat label="总局数" value={`${total}`} />
          <Stat label="胜 / 负 / 平" value={`${me.stats.wins}/${me.stats.losses}/${me.stats.draws}`} />
          <Stat label="胜率" value={`${winRate}%`} />
          <Stat label="惩罚次数" value={`${me.stats.punishments}`} />
          <Stat label="排位积分" value={`${me.stats.rankedPoints}`} />
          <Stat label="当前称号" value={me.nameWarPunished ? "已隐藏" : me.stats.title} />
          <Stat label="白给值" value={`${formatGiveawayValue(giveawayValue)}%`} />
          <Stat label="极限模式" value={me.extremeModeEnabled ? `连胜 ${me.extremeWinStreak || 0}` : "未开启"} />
        </div>

        <div className="profile-edit">
          <h3><Pencil size={18} /> 修改资料</h3>
          <div className="profile-edit-grid">
            <label className="field-label profile-name-field">
              <span>名字</span>
              <input value={name} maxLength={12} disabled={nameLockedByWar} onChange={(event) => setName(event.target.value)} placeholder="新的名字" />
              <small>{nameLockedByWar ? "名字争夺战开启后不能修改名字" : nameChanged && cooldownMs > 0 ? `改名冷却：${nameCooldownSeconds} 秒` : "名字会显示在大厅、房间和聊天里"}</small>
            </label>
            <div className="profile-gender-field">
              <span>性别</span>
              <GenderPicker config={config} value={genderId} onChange={setGenderId} compact />
              <small>性别和阵营都可以随时修改</small>
            </div>
          </div>
          <p className="hint">性别和阵营现在都可以随时调整，不再限制切换时间。</p>
          <p className="hint">上次改名：{me.profileUpdatedAt ? new Date(me.profileUpdatedAt).toLocaleString() : "还没有修改过"}</p>
          <div className="name-war-card">
            <div className="admin-card-title">
              <strong>名字争夺战</strong>
              <small>{me.nameWarEnabled ? "已开启" : "未开启"}</small>
            </div>
            <Toggle label="开启名字争夺战" value={nameWarEnabled} disabled={nameWarCooldownMs > 0} onChange={setNameWarEnabled} />
            <Toggle label="允许其他玩家改名" value={nameWarAllowRename} disabled={!nameWarEnabled || nameWarCooldownMs > 0} onChange={setNameWarAllowRename} />
            <p className="hint">开启后排位负分下限变成 -1999；跌到 -1000 后，只显示系统惩罚名，不显示性别和称号。</p>
            <p className="hint">允许其他玩家改名后，跌到 -1000 以下会出现在大厅失格者名单，500 分以上玩家可以抢先给你改名。</p>
            <p className="hint">被其他玩家改名后，保护期内即使回到 -999 以上也不会提前恢复；保护期结束且积分达到 -999 以上才恢复。</p>
            {me.nameWarRenameProtectedUntil && me.nameWarRenameProtectedUntil > now && <p className="hint">改名保护中：约 {Math.ceil((me.nameWarRenameProtectedUntil - now) / 3_600_000)} 小时。</p>}
            {me.nameWarPunished && me.nameWarPenaltyName && <p className="hint">当前惩罚名：{me.nameWarPenaltyName}。</p>}
            {nameWarCooldownMs > 0 && <p className="hint">开关冷却：{nameWarCooldownHours} 小时</p>}
            {!nameWarEnabled && me.stats.rankedPoints < -999 && <p className="hint">保存关闭后，积分会拉回 -999。</p>}
          </div>
          <div className="name-war-card giveaway-profile-card">
            <div className="admin-card-title">
              <strong>白给模式</strong>
              <small>{me.giveawayEnabled ? `${formatGiveawayValue(giveawayValue)}%` : "未开启"}</small>
            </div>
            <Toggle label="开启白给模式" value={giveawayEnabled} disabled={giveawayCannotClose} onChange={setGiveawayEnabled} />
            <p className="hint">开启后，锤子剪刀布真人对战会按白给值概率触发强制白给；黑白棋排位落子后可选择不白给、白给或上贡。</p>
            <p className="hint">出拳区点击“白给”会让白给值 +2%，触发强制白给后也会 +2%，最高 100%。</p>
            <p className="hint">黑白棋白给会让本手翻子不结算排位分并按 0.1%/子增加白给值；上贡会把本手分数给对面并按 0.2%/子增加白给值。</p>
            <p className="hint">白给值归零后，才可以关闭这个模式。可以在大厅的白给自救板提交宣言，等待其他玩家点赞帮你降低。</p>
            {giveawayCannotClose && <p className="hint danger-hint">当前还有 {formatGiveawayValue(giveawayValue)}% 白给值，暂时不能关闭。</p>}
          </div>
          <div className="name-war-card extreme-profile-card">
            <div className="admin-card-title">
              <strong>{config.extremeMode.emoji} {config.extremeMode.label}</strong>
              <small>{me.extremeModeEnabled ? `连胜 ${me.extremeWinStreak || 0}` : extremeCooldownMs > 0 ? `冷却 ${extremeCooldownHours} 小时` : "未开启"}</small>
            </div>
            <Toggle label="开启极限模式" value={extremeModeEnabled} disabled={(!me.extremeModeEnabled && (me.stats.rankedPoints < 0 || extremeCooldownMs > 0)) || extremeCannotClose} onChange={setExtremeModeEnabled} />
            <p className="hint">开启要求当前排位分不为负；开启后排位分归零，但胜负平和惩罚次数保留。</p>
            <p className="hint">极限模式不能创建倍率房；进入普通排位或倍率房时只能观战，不能上桌。非极限玩家进入极限排位房也只能观战。</p>
            <p className="hint">正分输分和负分加分会按段位折扣；整点会自动扣分，离线也会扣。</p>
            <p className="hint">极限排位连胜达到 {config.extremeMode.winStreakThreshold} 局后，每次继续获胜都有 {Math.round(config.extremeMode.winStreakCrashChance * 100)}% 几率额外扣 {config.extremeMode.crashTargetPoints} 分。</p>
            {me.stats.rankedPoints < 0 && !me.extremeModeEnabled && <p className="hint danger-hint">你当前是负分，不能开启极限模式。</p>}
            {extremeCannotClose && <p className="hint danger-hint">排位分必须大于 0 才能关闭极限模式，0 分不能关闭。</p>}
            {me.extremeForceClosed && <p className="hint danger-hint">你曾强行关闭极限模式，已进入通用改名处。</p>}
            {me.extremeRenameProtectedUntil && me.extremeRenameProtectedUntil > now && <p className="hint">极限改名保护中：约 {Math.ceil((me.extremeRenameProtectedUntil - now) / 3_600_000)} 小时。</p>}
            {extremeCooldownMs > 0 && <p className="hint">关闭后冷却：约 {extremeCooldownHours} 小时后可重新开启。</p>}
            {me.extremeModeEnabled && (
              <button type="button" className="danger-button" onClick={forceCloseExtremeMode}>强行关闭极限模式</button>
            )}
          </div>
          <div className="profile-action-row">
            <button className="primary" disabled={(nameChanged && (cooldownMs > 0 || nameLockedByWar)) || ((nameWarChanged || nameWarAllowRenameChanged) && nameWarCooldownMs > 0) || giveawayCannotClose || extremeCannotEnable || extremeCannotClose} onClick={saveProfile}><Save size={16} /> 保存个人资料</button>
            <button onClick={onClose}>关闭个人设置</button>
          </div>
        </div>
      </section>
    </div>
  );
}

type AdminSection = "site" | "factions" | "titles" | "punishments" | "roomTags" | "roomInfoTags" | "nameWar" | "giveaway" | "extremeMode" | "accessControl" | "bots" | "messages" | "actions" | "advanced";
type AdminActionTab = "online" | "offline" | "rooms" | "announcement";

const roomInfoTagOrder = [
  { key: "gameRps", label: "锤子剪刀布" },
  { key: "gameOthello", label: "黑白棋" },
  { key: "gameTicTacToe", label: "井字棋" },
  { key: "phaseReady", label: "等待坐满" },
  { key: "phaseChoosing", label: "出拳中" },
  { key: "phaseResult", label: "结算中" },
  { key: "phasePunishment", label: "惩罚阶段" },
  { key: "normal", label: "普通局" },
  { key: "ranked", label: "排位" },
  { key: "extremeRanked", label: "极限排位" },
  { key: "punishment", label: "惩罚开启" },
  { key: "noPunishment", label: "无惩罚" },
  { key: "tieDoublePunish", label: "平局双罚" },
  { key: "requireOpponentConfirm", label: "需要对手确认" },
  { key: "allowProofImage", label: "允许图片证明" },
  { key: "textProofOnly", label: "仅文字证明" }
];

function defaultRoomInfoTagStyle(label: string): RoomInfoTagStyle {
  return { label, textColor: "#4d5c6f", backgroundColor: "#eef3f8", borderColor: "#c9d6e4" };
}

function AdminPanel({ config, lobby, onBack, onError }: { config: AppConfig; lobby: LobbySnapshot; onBack: () => void; onError: (message: string) => void }) {
  const [password, setPassword] = useState("");
  const [logged, setLogged] = useState(false);
  const [draft, setDraft] = useState<AppConfig>(config);
  const [activeSection, setActiveSection] = useState<AdminSection>("site");
  const [activeFactionId, setActiveFactionId] = useState(config.genderFactions[0]?.id || "");
  const [factionSearch, setFactionSearch] = useState("");
  const [activeTitleId, setActiveTitleId] = useState(config.titles[0]?.id || "");
  const [titleSearch, setTitleSearch] = useState("");
  const [activePunishmentId, setActivePunishmentId] = useState(config.punishments[0]?.id || "");
  const [punishmentSearch, setPunishmentSearch] = useState("");
  const [announcementMessage, setAnnouncementMessage] = useState("");
  const [announcementSeconds, setAnnouncementSeconds] = useState("8");
  const [activeActionTab, setActiveActionTab] = useState<AdminActionTab>("online");
  const [configText, setConfigText] = useState(JSON.stringify(config, null, 2));
  const [dirty, setDirty] = useState(false);
  const [serverConfigChanged, setServerConfigChanged] = useState(false);
  const lastServerConfigText = useRef(JSON.stringify(config));

  useEffect(() => {
    const nextText = JSON.stringify(config);
    if (nextText === lastServerConfigText.current) return;
    lastServerConfigText.current = nextText;
    if (dirty) {
      setServerConfigChanged(true);
      return;
    }
    applyServerConfig(config);
  }, [config, dirty]);

  function applyServerConfig(nextConfig: AppConfig) {
    lastServerConfigText.current = JSON.stringify(nextConfig);
    setDraft(nextConfig);
    setConfigText(JSON.stringify(nextConfig, null, 2));
    setActiveFactionId((old) => nextConfig.genderFactions.some((item) => item.id === old) ? old : nextConfig.genderFactions[0]?.id || "");
    setActiveTitleId((old) => nextConfig.titles.some((item) => item.id === old) ? old : nextConfig.titles[0]?.id || "");
    setActivePunishmentId((old) => nextConfig.punishments.some((item) => item.id === old) ? old : nextConfig.punishments[0]?.id || "");
    setDirty(false);
    setServerConfigChanged(false);
  }

  async function login() {
    try {
      await ask("admin:login", { password });
      setLogged(true);
    } catch (error) {
      onError(error instanceof Error ? error.message : "登录失败");
    }
  }

  async function save() {
    try {
      const nextConfig = activeSection === "advanced" ? JSON.parse(configText) as AppConfig : draft;
      const response = await ask<{ config: AppConfig }>("config:save", { password, nextConfig });
      applyServerConfig(response.config);
      onError("配置保存成功");
    } catch (error) {
      onError(error instanceof Error ? error.message : "配置保存失败");
    }
  }

  async function resetDefault() {
    try {
      const response = await ask<{ config: AppConfig }>("config:reset", { password });
      applyServerConfig(response.config);
      onError("已恢复默认配置");
    } catch (error) {
      onError(error instanceof Error ? error.message : "恢复默认失败");
    }
  }

  async function exportConfig() {
    try {
      const response = await fetch(`/api/config/export?password=${encodeURIComponent(password)}`, {
        method: "GET",
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message || "配置导出失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "rps-config.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      onError("配置已导出");
    } catch (error) {
      onError(error instanceof Error ? error.message : "配置导出失败");
    }
  }

  function patch(next: Partial<AppConfig>) {
    setDirty(true);
    setDraft((old) => ({ ...old, ...next }));
  }

  function patchFactions(nextFactions: GenderFaction[]) {
    const normalized = nextFactions.map((faction) => ({
      ...faction,
      genders: faction.genders.map((gender) => ({ ...gender, factionId: faction.id }))
    }));
    patch({ genderFactions: normalized, genders: flattenDraftGenders(normalized) });
  }

  async function action(actionName: string, payload: Record<string, unknown> = {}) {
    try {
      await ask("admin:action", { action: actionName, ...payload });
    } catch (error) {
      onError(error instanceof Error ? error.message : "管理操作失败");
    }
  }

  async function sendAnnouncement() {
    try {
      await ask("admin:action", {
        action: "broadcastAnnouncement",
        message: announcementMessage,
        durationSeconds: Number(announcementSeconds)
      });
      setAnnouncementMessage("");
      onError("公告已发送");
    } catch (error) {
      onError(error instanceof Error ? error.message : "公告发送失败");
    }
  }

  async function uploadAdminImage(file: File) {
    const uploadFile = await compressImageForUpload(file);
    if (uploadFile.size > maxImageUploadBytes) throw new Error("图片压缩后仍超过 8MB，请换一张或先用相册压缩。");
    const form = new FormData();
    form.append("password", password);
    form.append("image", uploadFile);
    const response = await fetch("/api/admin-image", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "上传失败");
    return data.imageUrl as string;
  }

  const navItems: Array<{ id: AdminSection; label: string; detail: string }> = [
    { id: "site", label: "网站信息", detail: draft.site.name },
    { id: "factions", label: "阵营与性别", detail: `${draft.genderFactions.length} 个阵营` },
    { id: "titles", label: "称号池", detail: `${draft.titles.length} 个段位` },
    { id: "punishments", label: "惩罚池", detail: `${draft.punishments.length} 项` },
    { id: "roomTags", label: "房间标签", detail: `${draft.roomTags.length} 个标签` },
    { id: "roomInfoTags", label: "房间信息标签", detail: "房间头部彩色标签" },
    { id: "nameWar", label: "名字争夺战", detail: draft.nameWar.penaltyPrefix },
    { id: "giveaway", label: "白给模式", detail: draft.giveaway.panelTitle },
    { id: "extremeMode", label: "极限模式", detail: `${draft.extremeMode.emoji} ${draft.extremeMode.label}` },
    { id: "accessControl", label: "防多开", detail: `${draft.accessControl.maxOnlinePerIp} 在线 / ${draft.accessControl.maxCreatesPer10Min} 新建` },
    { id: "bots", label: "Bot 设置", detail: `${draft.bots.difficulties.length} 个难度` },
    { id: "messages", label: "系统提示", detail: `${Object.keys(draft.messages).length} 条文案` },
    { id: "actions", label: "管理操作", detail: `${lobby.rooms.length} 房间 / ${lobby.players.length} 玩家` },
    { id: "advanced", label: "高级 JSON", detail: "谨慎编辑" }
  ];

  const currentNav = navItems.find((item) => item.id === activeSection) || navItems[0];

  function switchSection(section: AdminSection) {
    if (section === "advanced") setConfigText(JSON.stringify(draft, null, 2));
    setActiveSection(section);
  }

  function renderSection() {
    if (activeSection === "site") {
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="网站信息" subtitle="修改网站名称、说明和管理员口令。" />
          <div className="admin-preview-card">
            <span>预览</span>
            <strong>{draft.site.name}</strong>
            <p>{draft.site.description || "暂无网站说明"}</p>
          </div>
          <label className="field-label"><span>网站名称</span><input value={draft.site.name} onChange={(event) => patch({ site: { ...draft.site, name: event.target.value } })} placeholder="网站名称" /></label>
          <label className="field-label"><span>网站说明</span><textarea value={draft.site.description} onChange={(event) => patch({ site: { ...draft.site, description: event.target.value } })} placeholder="网站说明" /></label>
          <label className="field-label"><span>管理员口令</span><input type="password" value={draft.site.adminPassword} onChange={(event) => patch({ site: { ...draft.site, adminPassword: event.target.value } })} placeholder="管理员口令" /></label>
        </div>
      );
    }

    if (activeSection === "factions") {
      const filteredFactions = draft.genderFactions.filter((faction) => {
        const keyword = factionSearch.trim().toLowerCase();
        if (!keyword) return true;
        return `${faction.id} ${faction.label} ${faction.genders.map((gender) => `${gender.id} ${gender.label}`).join(" ")}`.toLowerCase().includes(keyword);
      });
      const factionIndex = Math.max(0, draft.genderFactions.findIndex((faction) => faction.id === activeFactionId));
      const faction = draft.genderFactions[factionIndex];
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="阵营与性别" subtitle="玩家选择性别后，会自动归入对应阵营并使用这里的标签颜色。" />
          <div className="punishment-manager faction-manager">
            <aside className="punishment-index-panel">
              <input value={factionSearch} onChange={(event) => setFactionSearch(event.target.value)} placeholder="搜索阵营 / 性别 / ID" />
              <div className="punishment-index-list">
                {filteredFactions.map((item) => (
                  <button className={item.id === faction?.id ? "active" : ""} key={item.id} onClick={() => setActiveFactionId(item.id)}>
                    <span>{item.label}</span>
                    <small>{item.id} · {item.genders.length} 个性别</small>
                  </button>
                ))}
                {filteredFactions.length === 0 && <p className="empty">没有匹配的阵营</p>}
              </div>
              <button onClick={() => {
                const factionId = nextAdminId("faction", draft.genderFactions.map((item) => item.id));
                const genderId = nextAdminId(`${factionId}_gender`, draft.genders.map((gender) => gender.id));
                setActiveFactionId(factionId);
                patchFactions([...draft.genderFactions, { id: factionId, label: "新阵营", textColor: "#4d5c6f", backgroundColor: "#eef3f8", borderColor: "#c9d6e4", genders: [{ id: genderId, label: "新性别", factionId }] }]);
              }}>添加阵营</button>
            </aside>
            {faction && (
              <div className="mini-card punishment-detail-panel faction-editor">
                <div className="admin-card-title">
                  <strong>{faction.label}</strong>
                  <small>{factionIndex + 1} / {draft.genderFactions.length} · {faction.genders.length} 个性别</small>
                </div>
                <div className="admin-preview-strip compact-preview-strip">
                  <span className="faction-preview" style={factionStyle(faction)}>预览：{faction.label}</span>
                  {faction.genders.map((gender) => <span className="faction-preview" style={factionStyle(faction)} key={`${faction.id}-${gender.id}`}>{gender.label}</span>)}
                </div>
                <div className="config-row">
                  <label className="field-label"><span>阵营 ID（自动生成，一般不用改）</span><input value={faction.id} onChange={(event) => { setActiveFactionId(event.target.value); patchFactions(draft.genderFactions.map((item, itemIndex) => itemIndex === factionIndex ? { ...item, id: event.target.value } : item)); }} placeholder="阵营ID" /></label>
                  <label className="field-label"><span>阵营名称</span><input value={faction.label} onChange={(event) => patchFactions(draft.genderFactions.map((item, itemIndex) => itemIndex === factionIndex ? { ...item, label: event.target.value } : item))} placeholder="阵营名称" /></label>
                </div>
                <div className="color-grid">
                  <ColorInput label="文字颜色" value={faction.textColor} onChange={(value) => patchFactions(draft.genderFactions.map((item, itemIndex) => itemIndex === factionIndex ? { ...item, textColor: value } : item))} />
                  <ColorInput label="背景颜色" value={faction.backgroundColor} onChange={(value) => patchFactions(draft.genderFactions.map((item, itemIndex) => itemIndex === factionIndex ? { ...item, backgroundColor: value } : item))} />
                  <ColorInput label="边框颜色" value={faction.borderColor} onChange={(value) => patchFactions(draft.genderFactions.map((item, itemIndex) => itemIndex === factionIndex ? { ...item, borderColor: value } : item))} />
                </div>
                <div className="faction-gender-list">
                  {faction.genders.map((gender, genderIndex) => (
                    <div className="mini-card faction-gender-card" key={gender.id}>
                      <div className="admin-card-title">
                        <strong>{gender.label}</strong>
                        <small>{gender.id}</small>
                      </div>
                      <div className="config-row">
                        <label className="field-label"><span>性别 ID（自动生成，一般不用改）</span><input value={gender.id} onChange={(event) => patchFactions(draft.genderFactions.map((item, itemIndex) => itemIndex === factionIndex ? { ...item, genders: item.genders.map((genderItem, currentIndex) => currentIndex === genderIndex ? { ...genderItem, id: event.target.value } : genderItem) } : item))} placeholder="性别ID" /></label>
                        <label className="field-label"><span>显示文字</span><input value={gender.label} onChange={(event) => patchFactions(draft.genderFactions.map((item, itemIndex) => itemIndex === factionIndex ? { ...item, genders: item.genders.map((genderItem, currentIndex) => currentIndex === genderIndex ? { ...genderItem, label: event.target.value } : genderItem) } : item))} placeholder="显示文字" /></label>
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={() => patchFactions(draft.genderFactions.map((item, itemIndex) => {
                  if (itemIndex !== factionIndex) return item;
                  const genderId = nextAdminId(`${item.id}_gender`, draft.genders.map((genderItem) => genderItem.id));
                  return { ...item, genders: [...item.genders, { id: genderId, label: "新性别", factionId: item.id }] };
                }))}>给这个阵营添加性别</button>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (activeSection === "titles") {
      const filteredTitles = draft.titles.filter((segment) => {
        const keyword = titleSearch.trim().toLowerCase();
        if (!keyword) return true;
        return `${segment.id} ${segment.min} ${segment.max} ${segment.names.join(" ")}`.toLowerCase().includes(keyword);
      });
      const selectedIndex = Math.max(0, draft.titles.findIndex((segment) => segment.id === activeTitleId));
      const segment = draft.titles[selectedIndex];
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="称号池" subtitle="积分进入某个范围后，会从对应称号池随机装备一个称号。" />
          <div className="punishment-manager title-manager">
            <aside className="punishment-index-panel">
              <input value={titleSearch} onChange={(event) => setTitleSearch(event.target.value)} placeholder="搜索段位 ID / 分数 / 称号" />
              <div className="punishment-index-list">
                {filteredTitles.map((item) => (
                  <button className={item.id === segment?.id ? "active" : ""} key={item.id} onClick={() => setActiveTitleId(item.id)}>
                    <span>{item.id} · {item.min} ~ {item.max}</span>
                    <small>通用 {item.names.length} 个 · {draft.genderFactions.length} 个阵营专属池</small>
                  </button>
                ))}
                {filteredTitles.length === 0 && <p className="empty">没有匹配的段位</p>}
              </div>
              <button onClick={() => {
                const nextId = nextAdminId("title", draft.titles.map((item) => item.id));
                setActiveTitleId(nextId);
                patch({ titles: [...draft.titles, { id: nextId, min: 0, max: 0, names: ["新称号"], factionNames: Object.fromEntries(draft.genderFactions.map((faction) => [faction.id, ["新称号"]])) }] });
              }}>添加段位</button>
            </aside>
            {segment && (
              <div className="mini-card punishment-detail-panel">
                <div className="admin-card-title">
                  <strong>{segment.id} · {segment.min} ~ {segment.max}</strong>
                  <small>{selectedIndex + 1} / {draft.titles.length} · 通用 {segment.names.length} 个</small>
                </div>
                <div className="config-row compact">
                  <label className="field-label"><span>段位 ID（自动生成，一般不用改）</span><input value={segment.id} onChange={(event) => { setActiveTitleId(event.target.value); patch({ titles: draft.titles.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, id: event.target.value } : item) }); }} /></label>
                  <label className="field-label"><span>最低分</span><input type="number" value={segment.min} onChange={(event) => patch({ titles: draft.titles.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, min: Number(event.target.value) } : item) })} /></label>
                  <label className="field-label"><span>最高分</span><input type="number" value={segment.max} onChange={(event) => patch({ titles: draft.titles.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, max: Number(event.target.value) } : item) })} /></label>
                </div>
                <TagListEditor
                  label="通用称号（专属为空时兜底）"
                  placeholder="输入称号后回车"
                  values={segment.names}
                  onChange={(names) => patch({ titles: draft.titles.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, names } : item) })}
                />
                <div className="title-faction-grid">
                  {draft.genderFactions.map((faction) => (
                    <TagListEditor
                      key={`${segment.id}-${faction.id}`}
                      label={`${faction.label}专属称号`}
                      placeholder={`输入${faction.label}称号后回车`}
                      values={segment.factionNames?.[faction.id] || []}
                      onChange={(names) => patch({ titles: draft.titles.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, factionNames: { ...(item.factionNames || {}), [faction.id]: names } } : item) })}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (activeSection === "punishments") {
      const playerRoomNameItemId = "__player_room_names__";
      const filteredPunishments = draft.punishments.filter((punishment) => {
        const keyword = punishmentSearch.trim().toLowerCase();
        if (!keyword) return true;
        return `${punishment.id} ${punishment.name} ${punishment.description}`.toLowerCase().includes(keyword);
      });
      const isPlayerRoomNameSelected = activePunishmentId === playerRoomNameItemId;
      const selectedIndex = Math.max(0, draft.punishments.findIndex((punishment) => punishment.id === activePunishmentId));
      const punishment = draft.punishments[selectedIndex];
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="惩罚池" subtitle="编辑系统惩罚、阵营任务版本、随机房名，以及玩家发布任务模式的房名。" />
          <div className="punishment-manager">
            <aside className="punishment-index-panel">
              <input value={punishmentSearch} onChange={(event) => setPunishmentSearch(event.target.value)} placeholder="搜索惩罚名称 / ID / 简介" />
              <div className="punishment-index-list">
                {filteredPunishments.map((item) => (
                  <button className={!isPlayerRoomNameSelected && item.id === punishment?.id ? "active" : ""} key={item.id} onClick={() => setActivePunishmentId(item.id)}>
                    <span>{item.name}</span>
                    <small>{item.id} · {punishmentTasks(item, draft).length} 个任务</small>
                  </button>
                ))}
                {filteredPunishments.length === 0 && <p className="empty">没有匹配的惩罚</p>}
              </div>
              <button className={`special-index-item ${isPlayerRoomNameSelected ? "active" : ""}`} onClick={() => setActivePunishmentId(playerRoomNameItemId)}>
                <span>玩家发布任务房名</span>
                <small>玩家发布模式 · {draft.playerPunishmentRoomNamePool?.subjects.length || 0} 个关键词</small>
              </button>
              <button onClick={() => {
                const nextId = nextAdminId("punish", draft.punishments.map((item) => item.id));
                setActivePunishmentId(nextId);
                patch({ punishments: [...draft.punishments, { id: nextId, name: "新惩罚", description: "写下惩罚说明", cardImageUrl: "", cardImageOpacity: 0.26, roomBackgroundImages: [], variants: Object.fromEntries(draft.genderFactions.map((faction) => [faction.id, "写下这个阵营专属任务"])), tasks: [{ id: "task1", name: "默认任务", backgroundImages: [], backgroundOpacity: 0.22, variants: Object.fromEntries(draft.genderFactions.map((faction) => [faction.id, "写下这个阵营专属任务"])) }], roomNamePool: defaultAdminRoomNamePool() }] });
              }}>添加惩罚</button>
            </aside>
            {isPlayerRoomNameSelected ? (
              <div className="mini-card punishment-detail-panel player-punishment-room-name-card">
                <div className="admin-card-title">
                  <strong>玩家发布任务模式房名词库</strong>
                  <small>示例：{sampleRoomName(draft.playerPunishmentRoomNamePool)}</small>
                </div>
                <p className="hint">创建房间选择“玩家发布”时，会用这里生成随机房间名。它不属于某一个系统惩罚，所以作为惩罚池里的特殊项目管理。</p>
                <RoomNamePoolEditor title="玩家发布任务随机房名词库" pool={draft.playerPunishmentRoomNamePool || defaultAdminRoomNamePool()} onChange={(playerPunishmentRoomNamePool) => patch({ playerPunishmentRoomNamePool })} />
              </div>
            ) : punishment && (
              <div className="mini-card punishment-detail-panel">
                <div className="admin-card-title">
                  <strong>{punishment.name}</strong>
                  <small>{selectedIndex + 1} / {draft.punishments.length} · {punishmentTasks(punishment, draft).length} 个任务 · 示例：{sampleRoomName(punishment.roomNamePool)}</small>
                </div>
                <div className="admin-danger-row">
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => {
                      if (draft.punishments.length <= 1) {
                        onError("至少需要保留 1 个惩罚池");
                        return;
                      }
                      if (!window.confirm(`确定删除整个惩罚池「${punishment.name}」吗？里面的任务也会一起删除。`)) return;
                      const nextPunishments = draft.punishments.filter((_, itemIndex) => itemIndex !== selectedIndex);
                      setActivePunishmentId(nextPunishments[Math.max(0, selectedIndex - 1)]?.id || nextPunishments[0]?.id || "");
                      patch({ punishments: nextPunishments });
                    }}
                  >
                    删除这个惩罚池
                  </button>
                </div>
                <div className="punishment-admin-preview">
                  <button
                    className="punishment-choice-card active"
                    style={{
                      "--punishment-bg": punishment.cardImageUrl ? `url(${punishment.cardImageUrl})` : "none",
                      "--punishment-bg-opacity": String(punishment.cardImageOpacity ?? 0.26)
                    } as CSSProperties}
                  >
                    <span>{punishment.name}</span>
                    <small>{punishment.description}</small>
                  </button>
                </div>
                <div className="config-row">
                  <label className="field-label"><span>内部 ID（自动生成，一般不用改）</span><input value={punishment.id} onChange={(event) => { setActivePunishmentId(event.target.value); patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, id: event.target.value } : item) }); }} placeholder="内部ID" /></label>
                  <label className="field-label"><span>玩家可见名称</span><input value={punishment.name} onChange={(event) => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, name: event.target.value } : item) })} placeholder="惩罚名称" /></label>
                </div>
                <label className="field-label"><span>通用说明</span><textarea value={punishment.description} onChange={(event) => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, description: event.target.value } : item) })} placeholder="惩罚说明" /></label>
                <label className="field-label">
                  <span>卡片背景图 URL（推荐 1200 × 480）</span>
                  <input value={punishment.cardImageUrl || ""} onChange={(event) => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, cardImageUrl: event.target.value } : item) })} placeholder="例如 /uploads/example.webp 或 https://..." />
                </label>
                <AdminImageUpload label="上传为卡片背景图" upload={uploadAdminImage} onError={onError} onUploaded={(cardImageUrl) => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, cardImageUrl } : item) })} />
                <label className="field-label">
                  <span>卡片背景透明率（推荐 0.15 ~ 0.45）</span>
                  <input type="number" min={0} max={1} step={0.01} value={punishment.cardImageOpacity ?? 0.26} onChange={(event) => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, cardImageOpacity: Number(event.target.value) } : item) })} />
                </label>
                <TagListEditor label="房间信息卡图库（推荐 1920 × 1080，jpg/webp；用于大厅房间卡和房间内信息卡，手机端会居中裁切）" placeholder="输入图片 URL 后回车" values={punishment.roomBackgroundImages || []} onChange={(roomBackgroundImages) => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, roomBackgroundImages } : item) })} />
                <AdminImageUpload label="上传并加入房间信息卡图库" upload={uploadAdminImage} onError={onError} onUploaded={(imageUrl) => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, roomBackgroundImages: [...(item.roomBackgroundImages || []), imageUrl] } : item) })} />
                <div className="punishment-task-list">
                  {punishmentTasks(punishment, draft).map((task, taskIndex) => (
                    <details className="mini-card punishment-task-editor" key={task.id} open={taskIndex === 0}>
                      <summary>
                        <strong>{task.name}</strong>
                        <small>{draft.genderFactions.length} 个阵营版本</small>
                        <button
                          type="button"
                          className="danger-button tiny-danger-button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!window.confirm(`确定删除任务「${task.name}」吗？`)) return;
                            const currentTasks = punishmentTasks(punishment, draft);
                            const nextTasks = currentTasks.filter((_, itemIndex) => itemIndex !== taskIndex);
                            patch({
                              punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex
                                ? { ...item, tasks: nextTasks.length ? nextTasks : [newPunishmentTask(draft, item)] }
                                : item)
                            });
                          }}
                        >
                          删除任务
                        </button>
                      </summary>
                      <div className="config-row">
                        <label className="field-label"><span>任务 ID（自动生成，一般不用改）</span><input value={task.id} onChange={(event) => patchPunishmentTask(patch, draft, selectedIndex, taskIndex, { ...task, id: event.target.value })} placeholder="任务ID" /></label>
                        <label className="field-label"><span>任务名称</span><input value={task.name} onChange={(event) => patchPunishmentTask(patch, draft, selectedIndex, taskIndex, { ...task, name: event.target.value })} placeholder="任务名称" /></label>
                      </div>
                      <div className="config-row">
                        <label className="field-label">
                          <span>任务背景透明率（推荐 0.15 ~ 0.4）</span>
                          <input type="number" min={0} max={1} step={0.01} value={task.backgroundOpacity ?? 0.22} onChange={(event) => patchPunishmentTask(patch, draft, selectedIndex, taskIndex, { ...task, backgroundOpacity: Number(event.target.value) })} />
                        </label>
                      </div>
                      <TagListEditor label="任务背景图库（推荐 1200 × 520）" placeholder="输入图片 URL 后回车" values={task.backgroundImages || []} onChange={(backgroundImages) => patchPunishmentTask(patch, draft, selectedIndex, taskIndex, { ...task, backgroundImages })} />
                      <AdminImageUpload label="上传并加入任务背景图库" upload={uploadAdminImage} onError={onError} onUploaded={(imageUrl) => patchPunishmentTask(patch, draft, selectedIndex, taskIndex, { ...task, backgroundImages: [...(task.backgroundImages || []), imageUrl] })} />
                      <div className="variant-grid">
                        {draft.genderFactions.map((faction) => (
                          <label key={`${punishment.id}-${task.id}-${faction.id}`}>
                            <span>{faction.label}任务版本</span>
                            <textarea value={task.variants?.[faction.id] || ""} onChange={(event) => patchPunishmentTask(patch, draft, selectedIndex, taskIndex, { ...task, variants: { ...(task.variants || {}), [faction.id]: event.target.value } })} placeholder={`给${faction.label}看到的任务`} />
                          </label>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
                <button onClick={() => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, tasks: [...punishmentTasks(item, draft), newPunishmentTask(draft, item)] } : item) })}>给这个惩罚添加任务</button>
                <RoomNamePoolEditor title="随机房名词库" pool={punishment.roomNamePool || emptyRoomNamePool()} onChange={(roomNamePool) => patch({ punishments: draft.punishments.map((item, itemIndex) => itemIndex === selectedIndex ? { ...item, roomNamePool } : item) })} />
              </div>
            )}
          </div>
        </div>
      );
    }

    if (activeSection === "bots") {
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="Bot 设置" subtitle="修改机器人名字池和难度卡片。难度策略会影响 Bot 出拳逻辑。" />
          <TagListEditor label="Bot 名字池" placeholder="输入 Bot 名字后回车" values={draft.bots.names} onChange={(names) => patch({ bots: { ...draft.bots, names } })} />
          {draft.bots.difficulties.map((difficulty, index) => (
            <div className="mini-card bot-admin-card" key={difficulty.id}>
              <div className="bot-difficulty-card active" style={{ "--bot-card-color": difficulty.cardColor || "#9ed7ff" } as CSSProperties}>
                <span className="bot-card-emoji">{difficulty.emoji || "🤖"}</span>
                <strong>{difficulty.name}</strong>
                <em>{botStars(difficulty.level || 1)}</em>
                <small>{difficulty.description}</small>
                <b>{botStrategyText(difficulty.strategy)}</b>
              </div>
              <div className="config-row">
                <label className="field-label"><span>难度名称</span><input value={difficulty.name} onChange={(event) => patch({ bots: { ...draft.bots, difficulties: draft.bots.difficulties.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) } })} /></label>
                <label className="field-label"><span>难度说明</span><input value={difficulty.description} onChange={(event) => patch({ bots: { ...draft.bots, difficulties: draft.bots.difficulties.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item) } })} /></label>
                <label className="field-label"><span>图标 Emoji</span><input value={difficulty.emoji || ""} onChange={(event) => patch({ bots: { ...draft.bots, difficulties: draft.bots.difficulties.map((item, itemIndex) => itemIndex === index ? { ...item, emoji: event.target.value } : item) } })} /></label>
                <label className="field-label"><span>星级 1-5</span><input type="number" min={1} max={5} value={difficulty.level || 1} onChange={(event) => patch({ bots: { ...draft.bots, difficulties: draft.bots.difficulties.map((item, itemIndex) => itemIndex === index ? { ...item, level: Number(event.target.value) } : item) } })} /></label>
                <label className="field-label"><span>策略类型</span><Select value={difficulty.strategy || "random"} onChange={(value) => patch({ bots: { ...draft.bots, difficulties: draft.bots.difficulties.map((item, itemIndex) => itemIndex === index ? { ...item, strategy: value as AppConfig["bots"]["difficulties"][number]["strategy"] } : item) } })} options={[
                  { value: "random", label: "随机" },
                  { value: "counter", label: "反制" },
                  { value: "chaos", label: "混乱连招" },
                  { value: "throw", label: "白给" },
                  { value: "win", label: "必胜" }
                ]} /></label>
                <ColorInput label="卡片颜色" value={difficulty.cardColor || "#9ed7ff"} onChange={(value) => patch({ bots: { ...draft.bots, difficulties: draft.bots.difficulties.map((item, itemIndex) => itemIndex === index ? { ...item, cardColor: value } : item) } })} />
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (activeSection === "nameWar") {
      const preview = `${draft.nameWar.penaltyPrefix || "失名者"}-A7K2`;
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="名字争夺战" subtitle="设置惩罚名前缀、通用改名处标题和退出高难度后的称号。" />
          <div className="admin-preview-card">
            <span>预览</span>
            <strong>{preview}</strong>
            <p>{draft.nameWar.renamePanelTitle || draft.nameWar.loserPanelTitle || "通用改名处"} · {draft.nameWar.nameWarLoserLabel || "名争失格"} / {draft.nameWar.extremeForceClosedLabel || "极限强关"} · 退出高难度称号：{draft.nameWar.escapeTitle || "逃跑的人"}</p>
          </div>
          <div className="config-row">
            <label className="field-label">
              <span>惩罚名前缀 XXXX</span>
              <input value={draft.nameWar.penaltyPrefix} maxLength={16} onChange={(event) => patch({ nameWar: { ...draft.nameWar, penaltyPrefix: event.target.value } })} placeholder="例如：失名者" />
            </label>
            <label className="field-label">
              <span>旧失格者面板标题</span>
              <input value={draft.nameWar.loserPanelTitle} maxLength={24} onChange={(event) => patch({ nameWar: { ...draft.nameWar, loserPanelTitle: event.target.value } })} placeholder="名字争夺战失格者" />
            </label>
            <label className="field-label">
              <span>通用改名处标题</span>
              <input value={draft.nameWar.renamePanelTitle || ""} maxLength={24} onChange={(event) => patch({ nameWar: { ...draft.nameWar, renamePanelTitle: event.target.value } })} placeholder="通用改名处" />
            </label>
            <label className="field-label">
              <span>名争来源标签</span>
              <input value={draft.nameWar.nameWarLoserLabel || ""} maxLength={16} onChange={(event) => patch({ nameWar: { ...draft.nameWar, nameWarLoserLabel: event.target.value } })} placeholder="名争失格" />
            </label>
            <label className="field-label">
              <span>极限强关标签</span>
              <input value={draft.nameWar.extremeForceClosedLabel || ""} maxLength={16} onChange={(event) => patch({ nameWar: { ...draft.nameWar, extremeForceClosedLabel: event.target.value } })} placeholder="极限强关" />
            </label>
            <label className="field-label">
              <span>退出高难度称号</span>
              <input value={draft.nameWar.escapeTitle} maxLength={18} onChange={(event) => patch({ nameWar: { ...draft.nameWar, escapeTitle: event.target.value } })} placeholder="逃跑的人" />
            </label>
          </div>
          <p className="hint">随机码固定为 4 位大写字母/数字；已有惩罚名不会因为你改前缀立刻变化，新触发的玩家会使用新前缀。</p>
        </div>
      );
    }

    if (activeSection === "giveaway") {
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="白给模式" subtitle="修改大厅白给自救板的标题、说明和输入提示。" />
          <div className="admin-preview-card">
            <span>预览</span>
            <strong>{draft.giveaway.panelTitle}</strong>
            <p>{draft.giveaway.panelDescription}</p>
          </div>
          <div className="config-row">
            <label className="field-label">
              <span>大厅面板标题</span>
              <input value={draft.giveaway.panelTitle} maxLength={24} onChange={(event) => patch({ giveaway: { ...draft.giveaway, panelTitle: event.target.value } })} placeholder="白给自救板" />
            </label>
            <label className="field-label">
              <span>提交框提示</span>
              <input value={draft.giveaway.submitPlaceholder} maxLength={60} onChange={(event) => patch({ giveaway: { ...draft.giveaway, submitPlaceholder: event.target.value } })} placeholder="写下你的自我惩罚宣言..." />
            </label>
          </div>
          <label className="field-label">
            <span>面板说明</span>
            <textarea value={draft.giveaway.panelDescription} maxLength={160} onChange={(event) => patch({ giveaway: { ...draft.giveaway, panelDescription: event.target.value } })} placeholder="提交一点自我惩罚宣言..." />
          </label>
          <label className="field-label">
            <span>空状态文案</span>
            <input value={draft.giveaway.emptyText} maxLength={60} onChange={(event) => patch({ giveaway: { ...draft.giveaway, emptyText: event.target.value } })} placeholder="还没有人在白给自救板上。" />
          </label>
          <p className="hint">规则固定：白给按钮 +2%，强制白给后 +2%；点赞 -1%，倒赞 +0.1%；真人对战生效，Bot 对战不生效。</p>
        </div>
      );
    }

    if (activeSection === "extremeMode") {
      const extreme = draft.extremeMode;
      const patchExtreme = (nextExtreme: AppConfig["extremeMode"]) => patch({ extremeMode: nextExtreme });
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="极限模式" subtitle="修改极限模式名称、标志、折扣、整点扣分和连胜风险。" />
          <div className="admin-preview-card">
            <span>预览</span>
            <strong>{extreme.emoji} {extreme.label}</strong>
            <p>关闭后冷却 {extreme.cooldownHours} 小时；{extreme.winStreakThreshold} 连胜后 {Math.round(extreme.winStreakCrashChance * 100)}% 额外扣 {extreme.crashTargetPoints} 分。</p>
          </div>
          <div className="config-row">
            <label className="field-label"><span>显示名称</span><input value={extreme.label} maxLength={16} onChange={(event) => patchExtreme({ ...extreme, label: event.target.value })} /></label>
            <label className="field-label"><span>标志 Emoji</span><input value={extreme.emoji} maxLength={4} onChange={(event) => patchExtreme({ ...extreme, emoji: event.target.value })} /></label>
            <label className="field-label"><span>关闭后冷却小时</span><input type="number" min={1} max={168} value={extreme.cooldownHours} onChange={(event) => patchExtreme({ ...extreme, cooldownHours: Number(event.target.value) })} /></label>
            <label className="field-label"><span>连胜阈值</span><input type="number" min={1} max={100} value={extreme.winStreakThreshold} onChange={(event) => patchExtreme({ ...extreme, winStreakThreshold: Number(event.target.value) })} /></label>
            <label className="field-label"><span>连胜风险概率 0-1</span><input type="number" min={0} max={1} step={0.01} value={extreme.winStreakCrashChance} onChange={(event) => patchExtreme({ ...extreme, winStreakCrashChance: Number(event.target.value) })} /></label>
            <label className="field-label"><span>连胜风险扣分</span><input type="number" min={1} max={1999} value={extreme.crashTargetPoints} onChange={(event) => patchExtreme({ ...extreme, crashTargetPoints: Number(event.target.value) })} /></label>
            <label className="field-label"><span>强关改名最低分</span><input type="number" min={1} max={999} value={extreme.forceRenameMinPoints || 1} onChange={(event) => patchExtreme({ ...extreme, forceRenameMinPoints: Number(event.target.value) })} /></label>
            <label className="field-label"><span>强关保护小时</span><input type="number" min={1} max={168} value={extreme.forceRenameProtectHours || 4} onChange={(event) => patchExtreme({ ...extreme, forceRenameProtectHours: Number(event.target.value) })} /></label>
          </div>
          <label className="field-label">
            <span>强行关闭提示</span>
            <textarea value={extreme.forceCloseWarning || ""} maxLength={180} onChange={(event) => patchExtreme({ ...extreme, forceCloseWarning: event.target.value })} placeholder="强行关闭极限模式后..." />
          </label>
          <div className="admin-card">
            <div className="admin-card-title">
              <strong>正分输分比例</strong>
              <small>0.9 表示只扣 90%</small>
            </div>
            <div className="config-row">
              {(["pos1", "pos2", "pos3", "pos4"] as const).map((key) => (
                <label className="field-label" key={key}><span>{key}</span><input type="number" min={0} max={1} step={0.01} value={extreme.positiveLossRates[key]} onChange={(event) => patchExtreme({ ...extreme, positiveLossRates: { ...extreme.positiveLossRates, [key]: Number(event.target.value) } })} /></label>
              ))}
            </div>
          </div>
          <div className="admin-card">
            <div className="admin-card-title">
              <strong>负分赢分比例</strong>
              <small>-1000 以下按 neg4</small>
            </div>
            <div className="config-row">
              {(["neg1", "neg2", "neg3", "neg4"] as const).map((key) => (
                <label className="field-label" key={key}><span>{key}</span><input type="number" min={0} max={1} step={0.01} value={extreme.negativeWinRates[key]} onChange={(event) => patchExtreme({ ...extreme, negativeWinRates: { ...extreme.negativeWinRates, [key]: Number(event.target.value) } })} /></label>
              ))}
            </div>
          </div>
          <div className="admin-card">
            <div className="admin-card-title">
              <strong>整点扣分</strong>
              <small>default 用于 0 分及负分</small>
            </div>
            <div className="config-row">
              {(["pos4", "pos3", "pos2", "pos1", "default"] as const).map((key) => (
                <label className="field-label" key={key}><span>{key}</span><input type="number" min={0} max={999} value={extreme.hourlyDecay[key]} onChange={(event) => patchExtreme({ ...extreme, hourlyDecay: { ...extreme.hourlyDecay, [key]: Number(event.target.value) } })} /></label>
              ))}
            </div>
          </div>
        </div>
      );
    }

    if (activeSection === "accessControl") {
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="防多开" subtitle="用 IP 做基础限制，降低重复注册和多开；同一浏览器 token 恢复不算新建。" />
          <div className="admin-preview-card">
            <span>当前规则</span>
            <strong>同 IP 最多 {draft.accessControl.maxOnlinePerIp} 个在线玩家</strong>
            <p>10 分钟内最多新建 {draft.accessControl.maxCreatesPer10Min} 个玩家。</p>
          </div>
          <div className="config-row">
            <label className="field-label">
              <span>同 IP 同时在线人数上限</span>
              <input
                type="number"
                min={1}
                max={100}
                value={draft.accessControl.maxOnlinePerIp}
                onChange={(event) => patch({ accessControl: { ...draft.accessControl, maxOnlinePerIp: Number(event.target.value) } })}
              />
            </label>
            <label className="field-label">
              <span>同 IP 10 分钟内新建玩家上限</span>
              <input
                type="number"
                min={1}
                max={200}
                value={draft.accessControl.maxCreatesPer10Min}
                onChange={(event) => patch({ accessControl: { ...draft.accessControl, maxCreatesPer10Min: Number(event.target.value) } })}
              />
            </label>
          </div>
          <p className="hint">IP 限制只能降低多开，不能完全防作弊；同一个 Wi-Fi 下的正常玩家也会共享这个限制。</p>
        </div>
      );
    }

    if (activeSection === "roomTags") {
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="房间标签" subtitle="玩家创建房间时，可以开启并选择这里配置好的标签。最多显示 5 个。" />
          <div className="admin-preview-card">
            <span>预览</span>
            <RoomTagList tags={draft.roomTags.slice(0, 5)} />
            <p>点下面标签可以删除；在输入框里输入文字后回车可以添加。</p>
          </div>
          <TagListEditor label="房间 Tag 池" placeholder="输入房间 Tag 后回车" values={draft.roomTags} onChange={(roomTags) => patch({ roomTags })} />
        </div>
      );
    }

    if (activeSection === "roomInfoTags") {
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="房间信息标签" subtitle="修改房间顶部规则标签的名字和颜色。" />
          <div className="admin-preview-card">
            <span>预览</span>
            <RoomInfoTagList tags={roomInfoTagOrder.slice(0, 6).map((item) => {
              const style = draft.roomInfoTags?.[item.key] || defaultRoomInfoTagStyle(item.label);
              return { key: item.key, text: style.label, style };
            })} />
            <p>这些标签会显示在房间信息卡里，部分也会显示在大厅房间卡上。</p>
          </div>
          <div className="room-info-tag-admin-grid">
            {roomInfoTagOrder.map((item) => {
              const style = draft.roomInfoTags?.[item.key] || defaultRoomInfoTagStyle(item.label);
              const nextTags = draft.roomInfoTags || {};
              const update = (nextStyle: RoomInfoTagStyle) => patch({ roomInfoTags: { ...nextTags, [item.key]: nextStyle } });
              return (
                <div className="mini-card room-info-tag-admin-card" key={item.key}>
                  <div className="admin-card-title">
                    <strong>{item.label}</strong>
                    <small>{item.key}</small>
                  </div>
                  <span className="room-info-tag preview" style={roomInfoTagStyle(style)}>{style.label}</span>
                  <label className="field-label"><span>显示名字</span><input value={style.label} onChange={(event) => update({ ...style, label: event.target.value })} /></label>
                  <div className="color-grid">
                    <ColorInput label="文字颜色" value={style.textColor} onChange={(textColor) => update({ ...style, textColor })} />
                    <ColorInput label="背景颜色" value={style.backgroundColor} onChange={(backgroundColor) => update({ ...style, backgroundColor })} />
                    <ColorInput label="边框颜色" value={style.borderColor} onChange={(borderColor) => update({ ...style, borderColor })} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (activeSection === "messages") {
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="系统提示" subtitle="修改每日公告、密码错误、名字校验、保存提示等系统文案。" />
          <div className="admin-announcement-card">
            <div className="admin-card-title">
              <strong>每日公告弹窗</strong>
              <small>每天每个浏览器显示一次，建角色前也会显示</small>
            </div>
            <Toggle
              label="开启每日公告"
              value={draft.dailyAnnouncement.enabled}
              onChange={(enabled) => patch({ dailyAnnouncement: { ...draft.dailyAnnouncement, enabled } })}
            />
            <div className="config-row">
              <label className="field-label">
                <span>公告标题</span>
                <input value={draft.dailyAnnouncement.title} maxLength={32} onChange={(event) => patch({ dailyAnnouncement: { ...draft.dailyAnnouncement, title: event.target.value } })} placeholder="今日公告" />
              </label>
              <label className="field-label">
                <span>按钮文字</span>
                <input value={draft.dailyAnnouncement.buttonText} maxLength={16} onChange={(event) => patch({ dailyAnnouncement: { ...draft.dailyAnnouncement, buttonText: event.target.value } })} placeholder="知道了" />
              </label>
              <label className="field-label">
                <span>版本标识</span>
                <input value={draft.dailyAnnouncement.version} maxLength={32} onChange={(event) => patch({ dailyAnnouncement: { ...draft.dailyAnnouncement, version: event.target.value } })} placeholder="default" />
              </label>
            </div>
            <label className="field-label">
              <span>公告内容</span>
              <textarea value={draft.dailyAnnouncement.content} maxLength={800} onChange={(event) => patch({ dailyAnnouncement: { ...draft.dailyAnnouncement, content: event.target.value } })} placeholder="写下今天想提醒玩家的内容" />
            </label>
            <p className="hint">如果希望玩家今天再次看到公告，可以修改“版本标识”，例如改成 2026-06-14-a。</p>
          </div>
          <div className="config-row">
            {Object.entries(draft.messages).map(([key, value]) => (
              <label className="field-label" key={key}>
                <span>{key}</span>
                <input value={value} onChange={(event) => patch({ messages: { ...draft.messages, [key]: event.target.value } })} />
              </label>
            ))}
          </div>
        </div>
      );
    }

    if (activeSection === "actions") {
      const stats = lobby.serverStats;
      const onlinePlayers = lobby.players.filter((player) => player.connected);
      const offlinePlayers = lobby.players.filter((player) => !player.connected);
      return (
        <div className="config-section admin-section-card">
          <AdminSectionHeader title="管理操作" subtitle="管理当前服务器运行期间的房间、玩家和聊天内容。" />
          <div className="admin-preview-card">
            <span>运行状态</span>
            <p>在线 {lobby.onlineCount} 人 · 房间 {lobby.rooms.length} 个 · 运行 {formatDuration(Date.now() - stats.startedAt)}</p>
            <p>房间广播 {stats.roomBroadcasts} 次 · 大厅广播 {stats.lobbyBroadcasts} 次</p>
            <p>最近 1 分钟：房间 {stats.recentRoomBroadcasts} 次 · 大厅 {stats.recentLobbyBroadcasts} 次</p>
            <p>断线 {stats.disconnects} 次 · 重连 {stats.reconnects} 次</p>
            <p>最近房间快照 {formatBytes(stats.lastRoomSnapshotBytes)} · 最近大厅快照 {formatBytes(stats.lastLobbySnapshotBytes)}</p>
            <p>平均快照：房间 {formatBytes(stats.averageRoomSnapshotBytes)} · 大厅 {formatBytes(stats.averageLobbySnapshotBytes)}</p>
          </div>
          <div className="admin-action-tabs">
            {[
              { id: "online", label: "在线", count: onlinePlayers.length },
              { id: "offline", label: "离线", count: offlinePlayers.length },
              { id: "rooms", label: "房间", count: lobby.rooms.length },
              { id: "announcement", label: "公告", count: 0 }
            ].map((tab) => (
              <button
                type="button"
                className={activeActionTab === tab.id ? "active" : ""}
                key={tab.id}
                onClick={() => setActiveActionTab(tab.id as AdminActionTab)}
              >
                <span>{tab.label}</span>
                {tab.count > 0 && <em>{tab.count}</em>}
              </button>
            ))}
          </div>
          {activeActionTab === "announcement" && (
            <>
              <div className="admin-action-row">
                <button className="danger-button" onClick={() => action("clearSuggestions")}>清空留言板</button>
                <button className="danger-button" onClick={() => action("clearLobbyChat")}>清空大厅聊天</button>
              </div>
              <div className="admin-announcement-card">
                <div className="admin-card-title">
                  <strong>发送全服公告</strong>
                  <small>当前在线玩家和后台页面会立即弹出</small>
                </div>
                <textarea
                  value={announcementMessage}
                  maxLength={200}
                  onChange={(event) => setAnnouncementMessage(event.target.value)}
                  placeholder="输入公告内容，最多 200 字"
                />
                <div className="admin-announcement-actions">
                  <label className="field-label">
                    <span>显示秒数</span>
                    <input type="number" min={3} max={60} value={announcementSeconds} onChange={(event) => setAnnouncementSeconds(event.target.value)} />
                  </label>
                  <button className="primary" onClick={sendAnnouncement}>发送公告</button>
                </div>
              </div>
            </>
          )}
          {activeActionTab === "online" && (
            <div className="admin-list-section">
              <div className="admin-list-heading">
                <h3>在线玩家</h3>
                <span>{onlinePlayers.length} 人</span>
              </div>
              {onlinePlayers.map((player) => (
                <AdminPlayerEditor key={player.id} player={player} onSave={(payload) => action("editPlayer", payload)} onKick={() => action("kick", { playerId: player.id })} />
              ))}
              {onlinePlayers.length === 0 && <p className="empty">当前没有在线玩家</p>}
            </div>
          )}
          {activeActionTab === "offline" && (
            <div className="admin-list-section">
              <div className="admin-list-heading">
                <h3>离线玩家</h3>
                <span>{offlinePlayers.length} 人</span>
              </div>
              {offlinePlayers.map((player) => (
                <AdminPlayerEditor key={player.id} player={player} onSave={(payload) => action("editPlayer", payload)} onKick={() => action("kick", { playerId: player.id })} />
              ))}
              {offlinePlayers.length === 0 && <p className="empty">当前没有离线保留玩家</p>}
            </div>
          )}
          {activeActionTab === "rooms" && (
            <div className="admin-list-section">
              <div className="admin-list-heading">
                <h3>房间管理</h3>
                <span>{lobby.rooms.length} 间</span>
              </div>
              {lobby.rooms.map((room) => (
                <div className="admin-room" key={room.id}>
                  <div className="admin-card-title">
                    <strong>{room.name}</strong>
                    <small>{room.code} · {room.status} · {room.players}/2 战斗席 · {room.spectators} 观战</small>
                  </div>
                  <div className="admin-action-row">
                    <button className="danger-button" onClick={() => action("closeRoom", { roomId: room.id })}>关闭房间</button>
                    <button onClick={() => action("clearRoomChat", { roomId: room.id })}>清空房间聊天</button>
                    <button onClick={() => action("forceNext", { roomId: room.id })}>强制下一局</button>
                  </div>
                  {room.gameId === "othello" && (
                    <div className="admin-action-row othello-admin-actions">
                      <button onClick={() => action("forceOthelloRestart", { roomId: room.id })}>黑白棋重开</button>
                      <button onClick={() => action("forceOthelloEnd", { roomId: room.id, othelloResult: "A" })}>判黑方胜</button>
                      <button onClick={() => action("forceOthelloEnd", { roomId: room.id, othelloResult: "B" })}>判白方胜</button>
                      <button onClick={() => action("forceOthelloEnd", { roomId: room.id, othelloResult: "draw" })}>判平局</button>
                    </div>
                  )}
                </div>
              ))}
              {lobby.rooms.length === 0 && <p className="empty">暂无房间</p>}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="config-section admin-section-card">
        <AdminSectionHeader title="高级 JSON" subtitle="适合批量复制和细调。保存前会走服务器校验。" />
        <textarea className="advanced-json" value={configText} onChange={(event) => { setDirty(true); setConfigText(event.target.value); }} />
      </div>
    );
  }

  return (
    <section className="admin-page">
      <div className="panel admin-login-card">
        <h2><Shield size={18} /> 管理员与文本工具</h2>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="管理员口令" />
        <button className="primary" onClick={login}>进入管理</button>
        <button onClick={onBack}>返回</button>
      </div>
      {logged && (
        <div className="admin-tool-shell">
          <nav className="admin-sidebar" aria-label="后台配置分类">
            {navItems.map((item) => (
              <button className={activeSection === item.id ? "active" : ""} key={item.id} onClick={() => switchSection(item.id)}>
                <span>{item.label}</span>
                <small>{item.detail}</small>
              </button>
            ))}
          </nav>
          <div className="panel visual-config admin-editor-panel">
            <div className="admin-editor-head">
              <div>
                <h2><Settings size={18} /> {currentNav.label}</h2>
                <p className="hint">{currentNav.detail}</p>
              </div>
              <div className="admin-edit-status">
                {dirty && <span>有未保存修改</span>}
                {serverConfigChanged && <small>服务器配置已更新，保存会覆盖当前服务器配置。</small>}
              </div>
            </div>
            {renderSection()}
            <div className="admin-sticky-actions">
              <button className="primary" onClick={save}><Save size={16} /> 保存配置</button>
              <button onClick={resetDefault}><RefreshCcw size={16} /> 恢复默认</button>
              <button onClick={exportConfig}><Download size={16} /> 导出配置</button>
              <button onClick={onBack}>返回</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function lines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function flattenDraftGenders(factions: GenderFaction[]) {
  return factions.flatMap((faction) => faction.genders.map((gender) => ({ ...gender, factionId: faction.id })));
}

function nextAdminId(prefix: string, existingIds: string[]) {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, "_") || "item";
  const used = new Set(existingIds);
  let index = 1;
  while (used.has(`${safePrefix}${index}`)) index += 1;
  return `${safePrefix}${index}`;
}

function punishmentTasks(punishment: AppConfig["punishments"][number], draft: AppConfig): PunishmentTaskConfig[] {
  if (punishment.tasks?.length) return punishment.tasks;
  return [{
    id: "task1",
    name: "默认任务",
    backgroundImages: [],
    backgroundOpacity: 0.22,
    variants: Object.fromEntries(draft.genderFactions.map((faction) => [
      faction.id,
      punishment.variants?.[faction.id] || punishment.description || "请完成本局惩罚。"
    ]))
  }];
}

function newPunishmentTask(draft: AppConfig, punishment: AppConfig["punishments"][number]): PunishmentTaskConfig {
  const tasks = punishmentTasks(punishment, draft);
  const nextIndex = tasks.length + 1;
  return {
    id: nextAdminId("task", tasks.map((task) => task.id)),
    name: `任务 ${nextIndex}`,
    backgroundImages: [],
    backgroundOpacity: 0.22,
    variants: Object.fromEntries(draft.genderFactions.map((faction) => [faction.id, "写下这个阵营专属任务"]))
  };
}

function patchPunishmentTask(patch: (next: Partial<AppConfig>) => void, draft: AppConfig, punishmentIndex: number, taskIndex: number, nextTask: PunishmentTaskConfig) {
  patch({
    punishments: draft.punishments.map((punishment, currentPunishmentIndex) => {
      if (currentPunishmentIndex !== punishmentIndex) return punishment;
      return {
        ...punishment,
        tasks: punishmentTasks(punishment, draft).map((task, currentTaskIndex) => currentTaskIndex === taskIndex ? nextTask : task)
      };
    })
  });
}

function AdminSectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="admin-section-header">
      <h3>{title}</h3>
      <p className="hint">{subtitle}</p>
    </div>
  );
}

function AdminPlayerEditor({ player, onSave, onKick }: { player: PublicPlayer; onSave: (payload: Record<string, unknown>) => void; onKick: () => void }) {
  const [name, setName] = useState(player.name);
  const [rankedPoints, setRankedPoints] = useState(String(player.stats.rankedPoints));
  const [title, setTitle] = useState(player.stats.title);

  useEffect(() => {
    setName(player.name);
    setRankedPoints(String(player.stats.rankedPoints));
    setTitle(player.stats.title);
  }, [player.id, player.name, player.stats.rankedPoints, player.stats.title]);

  const statusText = player.nameWarEnabled
    ? player.nameWarPunished
      ? `名字争夺战中：${player.nameWarPenaltyName || "惩罚名生效"}`
      : "名字争夺战已开启"
    : "未开启名字争夺战";

  return (
    <div className="admin-player-editor">
      <div className="admin-player-head">
        <PlayerBadge player={player} compact />
        <span className={`admin-name-war-status ${player.nameWarEnabled ? "active" : ""}`}>{statusText}</span>
      </div>
      <div className="config-row compact">
        <label className="field-label">
          <span>名字</span>
          <input value={name} maxLength={12} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field-label">
          <span>积分</span>
          <input type="number" min={player.nameWarEnabled ? -1999 : -999} max={999} value={rankedPoints} onChange={(event) => setRankedPoints(event.target.value)} />
        </label>
        <label className="field-label">
          <span>称号</span>
          <input value={title} maxLength={18} onChange={(event) => setTitle(event.target.value)} />
        </label>
      </div>
      <p className="hint">当前：{player.stats.rankedPoints} 分 · {player.nameWarPunished ? "性别/称号显示已隐藏" : `显示称号：${player.stats.title}`}</p>
      <div className="admin-action-row">
        <button className="primary" onClick={() => onSave({ playerId: player.id, name, rankedPoints: Number(rankedPoints), title })}>保存玩家资料</button>
        <button className="danger-button" onClick={onKick}>踢出</button>
      </div>
    </div>
  );
}

function sampleRoomName(pool?: RoomNamePool) {
  const target = pool || defaultAdminRoomNamePool();
  const adjective = target.adjectives[0] || "";
  const subject = target.subjects[0] || "任务";
  const roomWord = target.roomWords[0] || "房间";
  return `${adjective}${subject}${roomWord}`;
}

function RoomNamePoolEditor({ title, pool, onChange }: { title: string; pool: RoomNamePool; onChange: (pool: RoomNamePool) => void }) {
  return (
    <div className="room-name-pool-editor">
      <b>{title}</b>
      <TagListEditor label="形容词（可为空）" placeholder="输入形容词后回车" values={pool.adjectives} onChange={(adjectives) => onChange({ ...pool, adjectives })} />
      <TagListEditor label="名词/动词" placeholder="输入名词或动词后回车" values={pool.subjects} onChange={(subjects) => onChange({ ...pool, subjects })} />
      <TagListEditor label="房间词" placeholder="输入房间词后回车" values={pool.roomWords} onChange={(roomWords) => onChange({ ...pool, roomWords })} />
    </div>
  );
}

function AdminImageUpload({ label, upload, onUploaded, onError }: { label: string; upload: (file: File) => Promise<string>; onUploaded: (imageUrl: string) => void; onError: (message: string) => void }) {
  return (
    <label className="admin-image-upload">
      <Upload size={15} /> {label}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          upload(file).then(onUploaded).catch((error) => onError(error instanceof Error ? error.message : "上传失败"));
        }}
      />
    </label>
  );
}

function TagListEditor({ label, placeholder, values, onChange }: { label: string; placeholder: string; values: string[]; onChange: (values: string[]) => void }) {
  const [draftTag, setDraftTag] = useState("");

  function addTag() {
    const next = draftTag.trim();
    if (!next) return;
    if (!values.includes(next)) onChange([...values, next]);
    setDraftTag("");
  }

  return (
    <div className="tag-list-editor">
      <span>{label}</span>
      <div className="tag-list">
        {values.map((value) => (
          <button type="button" className="tag-chip" key={value} onClick={() => onChange(values.filter((item) => item !== value))}>
            {value}<small>×</small>
          </button>
        ))}
        {values.length === 0 && <em>暂无词条</em>}
      </div>
      <div className="tag-input-row">
        <input value={draftTag} onChange={(event) => setDraftTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} placeholder={placeholder} />
        <button type="button" onClick={addTag}>添加</button>
      </div>
    </div>
  );
}

function emptyRoomNamePool(): RoomNamePool {
  return { adjectives: [], subjects: [], roomWords: [] };
}

function defaultAdminRoomNamePool(): RoomNamePool {
  return { adjectives: ["粉蓝", "闪亮", "神秘"], subjects: ["任务", "挑战", "惩罚"], roomWords: ["小屋", "房间", "擂台"] };
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="color-input">
      <span>{label}</span>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="#RRGGBB" />
    </label>
  );
}

function Toggle({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="toggle"><input type="checkbox" checked={value} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> {label}</label>;
}

function Select({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><span>{label}</span><b>{value}</b></div>;
}

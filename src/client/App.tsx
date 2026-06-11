import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { Crown, DoorOpen, Download, Eye, MessageCircle, Moon, Pencil, RefreshCcw, Save, Settings, Shield, Sun, Swords, Upload, UserRound, Users } from "lucide-react";
import { socket } from "./main";
import type { AppConfig, BotDifficulty, ChatMessage, GenderFaction, LobbySnapshot, Move, PublicPlayer, PunishmentTaskConfig, RoomInfoTagStyle, RoomNamePool, RoomSettings, RoomSnapshot, SeatKey } from "../shared/types";

const tokenKey = "rps-online-token";
const defaultRoomName = "新的锤子剪刀布房间";
const maxImageUploadBytes = 8 * 1024 * 1024;

type MeState = { player: PublicPlayer; token: string; roomId?: string; room?: RoomSnapshot };
type AnnouncementPayload = { id: string; message: string; durationMs: number; createdAt: number };

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
    player.nameWarRenameCount || 0
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

export function App() {
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [view, setView] = useState<"login" | "lobby" | "room" | "admin">(() => isAdminRoute() ? "admin" : "login");
  const [profileOpen, setProfileOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [announcement, setAnnouncement] = useState<AnnouncementPayload | null>(null);
  const [connectionState, setConnectionState] = useState<"connected" | "connecting" | "disconnected">(() => socket.connected ? "connected" : "connecting");
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("rps-online-theme") === "dark" ? "dark" : "light"));

  useEffect(() => {
    socket.on("lobby:update", setLobby);
    socket.on("room:update", (nextRoom: RoomSnapshot) => {
      setRoom((old) => {
        if (old?.id === nextRoom.id && nextRoom.updatedAt < old.updatedAt) return old;
        return nextRoom;
      });
      if (!isAdminRoute()) setView("room");
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
      setLobby((old) => (old ? { ...old, config } : old));
    });
    socket.on("chat:append", (message: ChatMessage) => {
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
      setNotice("连接已恢复。");
    });
    socket.on("disconnect", () => {
      setConnectionState("disconnected");
      setNotice("连接已断开，正在重连。");
    });
    socket.io.on("reconnect_attempt", () => setConnectionState("connecting"));
    return () => {
      socket.off("lobby:update");
      socket.off("room:update");
      socket.off("player:kicked");
      socket.off("room:closed");
      socket.off("config:update");
      socket.off("chat:append");
      socket.off("suggestion:append");
      socket.off("announcement:show");
      socket.off("connect");
      socket.off("disconnect");
      socket.io.off("reconnect_attempt");
    };
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
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(null), announcement.durationMs);
    return () => window.clearTimeout(timer);
  }, [announcement]);

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
    const token = localStorage.getItem(tokenKey);
    if (!token) return;
    const cachedName = localStorage.getItem("rps-online-name") || "";
    const cachedGender = localStorage.getItem("rps-online-gender") || "male";
    if (cachedName) {
      ask<MeState>("player:join", { name: cachedName, genderId: cachedGender, token })
        .then((next) => {
          setMe(next);
          if (next.room) setRoom(next.room);
          if (!isAdminRoute()) {
            setView(next.room ? "room" : "lobby");
            if (next.room?.phase === "punishment") setNotice("已恢复到未完成的惩罚房间。");
          }
        })
        .catch(() => localStorage.removeItem(tokenKey));
    }
  }, []);

  useEffect(() => {
    if (!me || !lobby) return;
    const latest = lobby.players.find((player) => player.id === me.player.id);
    if (latest && playerSyncKey(latest) !== playerSyncKey(me.player)) {
      setMe((old) => old ? { ...old, player: latest } : old);
    }
  }, [lobby, me]);

  const config = lobby?.config;

  if (!config) return <div className="loading">正在连接服务器...</div>;

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
          {me && (
            <button className="soft-button top-profile-button" title="个人设置" onClick={() => setProfileOpen(true)}>
              <UserRound size={18} /> <span>个人设置</span>
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
      {view === "login" && <Login config={config} onDone={(next) => {
        setMe(next);
        if (next.room) setRoom(next.room);
        setView(isAdminRoute() ? "admin" : next.room ? "room" : "lobby");
        if (next.room?.phase === "punishment") setNotice("已恢复到未完成的惩罚房间。");
      }} onError={setNotice} />}
      {view === "lobby" && me && lobby && <Lobby lobby={lobby} me={me.player} onError={setNotice} onGoRoom={() => setView("room")} />}
      {view === "room" && me && room && <Room config={config} room={room} me={me.player} onBack={() => setView("lobby")} onError={setNotice} />}
      {view === "admin" && lobby && <AdminPanel lobby={lobby} onBack={() => { if (window.location.hash === "#admin") window.location.hash = ""; setView(me ? "lobby" : "login"); }} onError={setNotice} />}
      {view === "room" && !room && <section className="panel">你暂时不在房间里。</section>}
      {profileOpen && me && <ProfilePanel config={config} me={me.player} onClose={() => setProfileOpen(false)} onUpdated={(player) => { setMe({ ...me, player }); localStorage.setItem("rps-online-name", player.name); localStorage.setItem("rps-online-gender", player.genderId); }} onError={setNotice} />}
    </main>
  );
}

function Login({ config, onDone, onError }: { config: AppConfig; onDone: (me: MeState) => void; onError: (message: string) => void }) {
  const [name, setName] = useState("");
  const [genderId, setGenderId] = useState(firstGenderId(config));

  async function submit() {
    try {
      const result = await ask<MeState>("player:join", { name, genderId, token: localStorage.getItem(tokenKey) });
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
        <strong>{player.nameWarPenaltyName}</strong>
      </span>
    );
  }
  return (
    <span className={`player-badge ${compact ? "compact" : ""}`}>
      <span className="gender-chip" style={genderStyle(player)} title={player.factionLabel}>{player.genderLabel}</span>
      <span className={`title-chip ${titleClass(player.stats.rankedPoints)}`}>{player.stats.title}</span>
      <strong>{displayPlayerName(player)}</strong>
    </span>
  );
}

function displayPlayerName(player: PublicPlayer) {
  if (player.nameWarPunished && player.nameWarPenaltyName) return player.nameWarPenaltyName;
  return `${player.nameWarEnabled ? "⚔️ " : ""}${player.name}`;
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

function Lobby({ lobby, me, onError, onGoRoom }: { lobby: LobbySnapshot; me: PublicPlayer; onError: (message: string) => void; onGoRoom: () => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [suggestion, setSuggestion] = useState("");
  const suggestionListRef = useRef<HTMLDivElement | null>(null);
  const suggestionStickToBottomRef = useRef(true);
  const visibleSuggestions = lobby.suggestions.slice(0, 50).reverse();
  const nameWarLosers = lobby.players.filter((player) => player.connected && isNameWarLoser(player));

  useEffect(() => {
    const list = suggestionListRef.current;
    if (list && suggestionStickToBottomRef.current) scrollToBottomSoon(list);
  }, [visibleSuggestions.length]);

  async function joinRoom(roomId: string) {
    try {
      await ask("room:join", { roomId, password: passwords[roomId] });
      onGoRoom();
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
                <h3>{room.name}</h3>
                {room.tags?.length ? <RoomTagList tags={room.tags} /> : null}
                <RoomVersusLine room={room} />
                <p>{room.status} · {room.players}/2 战斗席 · {room.spectators} 观战</p>
                <RoomInfoTagList tags={lobbyRoomInfoTags(lobby.config, room)} />
              </div>
              <div className="join-box">
                {room.hasPassword && <input placeholder="房间密码" value={passwords[room.id] || ""} onChange={(event) => setPasswords({ ...passwords, [room.id]: event.target.value })} />}
                <button onClick={() => joinRoom(room.id)}>加入</button>
              </div>
            </div>
          ))}
          {lobby.rooms.length === 0 && <p className="empty">还没有房间，先创建一个吧。</p>}
        </div>
      </div>
      <aside className="side-column">
        <NameWarLoserPanel title={lobby.config.nameWar.loserPanelTitle} losers={nameWarLosers} me={me} onError={onError} />
        <Leaderboard title="在线积分榜" players={lobby.rankedLeaderboard} />
        <div className="panel lobby-message-board">
          <h2><MessageCircle size={18} /> 留言板</h2>
          <div className="messages lobby-suggestion-messages" ref={suggestionListRef} onScroll={(event) => { suggestionStickToBottomRef.current = isNearScrollBottom(event.currentTarget); }}>
            {visibleSuggestions.map((item) => <ChatBubble key={item.id} message={suggestionToMessage(item)} me={me} />)}
            {lobby.suggestions.length === 0 && <p className="empty">还没有留言</p>}
          </div>
          <div className="send-row">
            <input value={suggestion} onChange={(event) => setSuggestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendSuggestion(); }} placeholder="写下建议、bug 或新惩罚..." />
            <button onClick={sendSuggestion}>发送</button>
          </div>
        </div>
      </aside>
      {showCreate && <CreateRoom config={lobby.config} onCreated={onGoRoom} onCancel={() => setShowCreate(false)} onError={onError} />}
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

function CreateRoom({ config, onCreated, onCancel, onError }: { config: AppConfig; onCreated: () => void; onCancel: () => void; onError: (message: string) => void }) {
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
    stake: 5
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
      if (next.punishmentSource === "player") {
        merged.enablePunishment = true;
        merged.enableBot = false;
      }
      if (next.enableBot) {
        merged.enableRanked = false;
      }
      if (next.enableRanked) {
        merged.enableBot = false;
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
      await ask("room:create", { settings });
      onCreated();
    } catch (error) {
      onError(error instanceof Error ? error.message : "创建失败");
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
            <Toggle label="开启 Bot" value={settings.enableBot} disabled={(settings.enablePunishment && settings.punishmentSource === "player") || settings.enableRanked} onChange={(value) => patch({ enableBot: value })} />
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
              <button type="button" className={`ranked-choice-card ${!settings.enableRanked ? "active" : ""}`} onClick={() => patch({ enableRanked: false })}>
                <span>🎮 普通局</span>
                <small>不增加/减少排位积分，可以和 Bot 对战。</small>
              </button>
              {([5, 10, 20] as const).map((stake) => (
                <button type="button" className={`ranked-choice-card ${settings.enableRanked && settings.stake === stake ? "active" : ""}`} key={stake} onClick={() => patch({ enableRanked: true, stake })}>
                  <span>🏆 排位 {stake} 分</span>
                  <small>胜利 +{stake}，失败 -{stake}；普通平局不扣分，平局双罚时双方 -{stake}。</small>
                </button>
              ))}
            </div>
            {settings.enableBot && <p className="hint">开启 Bot 时不能选择排位战。</p>}
          </div>
          <div className="create-section">
            <h3>惩罚</h3>
            <Toggle label="惩罚模式" value={settings.enablePunishment} onChange={(value) => patch({ enablePunishment: value })} />
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

function Room({ config, room, me, onBack, onError }: { config: AppConfig; room: RoomSnapshot; me: PublicPlayer; onBack: () => void; onError: (message: string) => void }) {
  const [chat, setChat] = useState("");
  const [proofText, setProofText] = useState("");
  const [proofImage, setProofImage] = useState("");
  const [localChoice, setLocalChoice] = useState<Move | null>(null);
  const [redoInputs, setRedoInputs] = useState<Record<string, string>>({});
  const [taskInputs, setTaskInputs] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [extraHistory, setExtraHistory] = useState<RoomSnapshot["roundHistory"]>([]);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatStickToBottomRef = useRef(true);
  const mySeat = room.seats.A?.id === me.id ? "A" : room.seats.B?.id === me.id ? "B" : null;
  const myChoice = mySeat ? room.phase === "result" ? undefined : localChoice || room.choices[mySeat] : undefined;
  const resultChoice = mySeat ? room.revealedChoices?.[mySeat] : undefined;
  const canChoose = Boolean(mySeat && room.phase !== "punishment" && (room.phase === "choosing" || room.phase === "result") && room.seats.A && room.seats.B);
  const canGoSpectate = Boolean(mySeat && room.phase !== "punishment" && !room.choices[mySeat]);
  const roomPlayers = roomPlayerList(room);
  const punishedNames = punishedPlayerNames(room);
  const iAmPunished = room.punishedPlayerIds.includes(me.id);
  const visibleChatMessages = room.chat.filter((item) => !item.expiresAt || item.expiresAt > now).slice(-80);
  const visibleRoundHistory = [...room.roundHistory, ...extraHistory.filter((item) => !room.roundHistory.some((fresh) => fresh.id === item.id))];
  const leaveTitle = room.phase === "punishment"
    ? iAmPunished
      ? "惩罚完成前不能离开房间"
      : "离开后，服务器会自动处理你负责的审核或任务"
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
    const list = chatListRef.current;
    if (list && chatStickToBottomRef.current) scrollToBottomSoon(list);
  }, [visibleChatMessages.length]);

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
          <h2><Swords size={20} /> {room.settings.name}</h2>
          {room.settings.enableTags && room.settings.tags?.length ? <RoomTagList tags={room.settings.tags} /> : null}
          <RoomInfoTagList tags={roomInfoTags(config, room)} />
        </div>
        <button className="soft-button" title={leaveTitle} onClick={leaveCurrentRoom}><DoorOpen size={16} /> 离开</button>
      </div>
      <div className="battle-panel">
        <SeatView seat="A" room={room} me={me} now={now} onSit={() => act("room:sit", { seat: "A" })} />
        <div className="versus">
          <span className="versus-label">⚔️ 对战比分</span>
          <strong>{room.score.A} : {room.score.B}</strong>
          <Settlement room={room} />
        </div>
        <SeatView seat="B" room={room} me={me} now={now} onSit={() => act("room:sit", { seat: "B" })} />
      </div>
      <div className="room-content-grid">
        <div className="actions-panel panel">
          {mySeat && (
            <div className="move-panel">
              <div>
                <h3>请选择出拳</h3>
                <p className="hint">{room.phase === "punishment" ? "惩罚完成前不能出拳。" : myChoice ? `你已锁定：${choiceText(myChoice)}` : resultChoice ? `上一局：${choiceText(resultChoice)}，可直接开始下一局。` : canChoose ? "坐下不算出拳，点一个 emoji 才会锁定。" : "等待另一位玩家坐下。"}</p>
              </div>
              <div className="move-row emoji-row">
                <button disabled={!canChoose || Boolean(myChoice)} onClick={() => choose("rock")}>✊<span>锤子</span></button>
                <button disabled={!canChoose || Boolean(myChoice)} onClick={() => choose("scissors")}>✌️<span>剪刀</span></button>
                <button disabled={!canChoose || Boolean(myChoice)} onClick={() => choose("paper")}>🖐️<span>布</span></button>
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
                  const proof = room.proofs.find((item) => item.playerId === playerId);
                  const task = room.roundHistory[0]?.punishmentTasks.find((item) => item.playerId === playerId);
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
                        <h4>{punishedPlayerName(room, playerId)} {isMine ? "（你）" : ""}</h4>
                        <em>{proof?.status === "approved" ? "已完成" : proof?.status === "pending" ? "待审核" : proof?.status === "rejected" ? "重做中" : taskAssigned ? "待提交" : "等任务"}</em>
                      </div>
                      {taskAssigned && task && (
                        <div className={`task-card designed-task-card ${task.backgroundImage ? "has-task-background" : ""}`} style={taskCardStyle}>
                          <b>{isMine ? "你的任务" : "对方任务"}</b>
                          <p>{taskTextOnly(taskText, task.factionLabel)}</p>
                          {task.assignedByName && <small>发布者：{task.assignedByName}</small>}
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
                          {proof.imageUrl && <img src={proof.imageUrl} alt="惩罚证明" />}
                        </div>
                      )}
                      {canSubmit && (
                        <div className="proof-submit-card">
                          <b>{proof?.status === "rejected" ? "重新提交证明" : "提交完成证明"}</b>
                          <textarea value={proofText} onChange={(event) => setProofText(event.target.value)} placeholder={proof?.status === "rejected" ? "重新提交你的惩罚完成证明" : "写下你的惩罚完成证明"} />
                          {room.settings.allowProofImage !== false ? (
                            <>
                              <label className="upload">
                                <Upload size={16} /> 上传图片证明
                                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => event.target.files?.[0] && uploadImage(event.target.files[0]).catch((error) => onError(error.message))} />
                              </label>
                              {proofImage && <img className="proof-preview" src={proofImage} alt="惩罚证明" />}
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
            {roomPlayers.map((item) => <RoomPlayerRow key={`${item.role}-${item.player.id}`} player={item.player} role={item.role} now={now} />)}
            {roomPlayers.length === 0 && <p className="empty">暂无真人玩家</p>}
          </div>
          <div className="panel chat-panel">
            <h3>房间聊天</h3>
            <div className="messages room-chat-messages" ref={chatListRef} onScroll={(event) => { chatStickToBottomRef.current = isNearScrollBottom(event.currentTarget); }}>
              {visibleChatMessages.map((item) => <ChatBubble key={item.id} message={item} me={me} />)}
            </div>
            <div className="send-row">
              <input value={chat} onChange={(event) => setChat(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendChat(); }} placeholder="发一句话..." />
              <button onClick={sendChat}>发送</button>
            </div>
          </div>
        </div>
        <div className="panel round-history">
          <h3 className="sticky-panel-title">
            📜 对局记录
            <span>{visibleRoundHistory.length} / {room.roundHistoryTotal}</span>
          </h3>
          {visibleRoundHistory.map((item) => <RoundHistoryCard key={item.id} item={item} onOpenImage={setPreviewImage} />)}
          {visibleRoundHistory.length < room.roundHistoryTotal && <button className="soft-button" onClick={loadMoreHistory}>加载更多记录</button>}
          {visibleRoundHistory.length === 0 && <p className="empty">还没有对局记录</p>}
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
          {item.ranked && <em>🏆 {item.stake}分</em>}
          {item.punishedNames.length > 0 && <em>🎲 惩罚</em>}
        </div>
      </header>
      <div className="history-duel">
        <div className="history-side">
          <span>{item.playerA}</span>
          <strong>{choiceText(item.moveA)}</strong>
        </div>
        <div className="history-result">
          <small>VS</small>
          <b>{item.resultLabel || historyResultText(item.result)}</b>
        </div>
        <div className="history-side">
          <span>{item.playerB}</span>
          <strong>{choiceText(item.moveB)}</strong>
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
                  {proofByPlayer.get(task.playerId)!.imageUrl && <button className="history-proof-image-button" onClick={() => onOpenImage(proofByPlayer.get(task.playerId)!.imageUrl!)}><img src={proofByPlayer.get(task.playerId)!.imageUrl} alt="惩罚证明" /></button>}
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
              {proof.imageUrl && <button className="history-proof-image-button" onClick={() => onOpenImage(proof.imageUrl!)}><img src={proof.imageUrl} alt="惩罚证明" /></button>}
            </div>
          ))}
        </section>
      )}
    </article>
  );
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
  return room.punishedPlayerIds.map((id) => players.find((player) => player.id === id)?.name || id);
}

function punishedPlayerName(room: RoomSnapshot, playerId: string) {
  return roomPlayerList(room).map((item) => item.player).find((player) => player.id === playerId)?.name || playerId;
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
        {!player.connected && <span className="chat-offline">离线</span>}
      </span>
    );
  }
  return (
    <span className="chat-name">
      <span className="chat-gender" style={genderStyle(player)}>{player.genderLabel}</span>
      <span className="chat-title">{player.stats.title}</span>
      <b>{displayPlayerName(player)}</b>
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
  return (
    <div className={`seat-card seat-${seat.toLowerCase()}`}>
      <div className="seat-identity">
        <span className="seat-label">玩家 {seat}</span>
        {occupant ? <strong>{"isBot" in occupant ? `🤖 ${occupant.name}` : <PlayerBadge player={occupant} compact />}</strong> : <button onClick={onSit}>🪑 坐下</button>}
      </div>
      {occupant && !("isBot" in occupant) && <OfflineBadge player={occupant} now={now} />}
      <p className="choice-badge">{choice ? choiceText(choice) : room.seats.A && room.seats.B ? "🤔 等待出拳" : "⏳ 等人"}</p>
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
  return choice === "rock" ? "✊ 锤子" : choice === "scissors" ? "✌️ 剪刀" : "🖐️ 布";
}

function historyResultText(result: "A" | "B" | "draw") {
  if (result === "draw") return "平局";
  return `${result} 胜`;
}

type RoomInfoTagView = { key: string; text: string; style: RoomInfoTagStyle };

function roomInfoTag(config: AppConfig, key: string, extra = ""): RoomInfoTagView {
  const fallback: RoomInfoTagStyle = { label: key, textColor: "#4d5c6f", backgroundColor: "#eef3f8", borderColor: "#c9d6e4" };
  const style = config.roomInfoTags?.[key] || fallback;
  return { key: `${key}-${extra}`, text: `${style.label}${extra}`, style };
}

function punishmentInfoTag(config: AppConfig, room: RoomSnapshot) {
  if (!room.settings.enablePunishment) return roomInfoTag(config, "noPunishment");
  if (room.settings.punishmentSource === "player") return roomInfoTag(config, "punishment", "：玩家发布任务");
  return roomInfoTag(config, "punishment", punishmentSelectionText(config, room.settings));
}

function roomInfoTags(config: AppConfig, room: RoomSnapshot) {
  const phaseKey = room.phase === "ready" ? "phaseReady" : room.phase === "choosing" ? "phaseChoosing" : room.phase === "result" ? "phaseResult" : room.phase === "punishment" ? "phasePunishment" : "phaseReady";
  const tags: RoomInfoTagView[] = [
    roomInfoTag(config, phaseKey),
    room.settings.enableRanked ? roomInfoTag(config, "ranked", ` ${room.settings.stake} 分`) : roomInfoTag(config, "normal"),
    punishmentInfoTag(config, room)
  ];
  if (room.settings.enablePunishment) {
    if (room.settings.tieDoublePunish) tags.push(roomInfoTag(config, "tieDoublePunish"));
    if (room.settings.requireOpponentConfirm) tags.push(roomInfoTag(config, "requireOpponentConfirm"));
    tags.push(roomInfoTag(config, room.settings.allowProofImage === false ? "textProofOnly" : "allowProofImage"));
  }
  return tags;
}

function lobbyRoomInfoTags(config: AppConfig, room: LobbySnapshot["rooms"][number]) {
  const tags: RoomInfoTagView[] = [
    room.enableRanked ? roomInfoTag(config, "ranked") : roomInfoTag(config, "normal"),
    room.enablePunishment ? roomInfoTag(config, "punishment", punishmentSelectionText(config, room)) : roomInfoTag(config, "noPunishment")
  ];
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

function winRateText(player: PublicPlayer) {
  const decisive = player.stats.wins + player.stats.losses;
  return `${decisive === 0 ? 0 : Math.round((player.stats.wins / decisive) * 100)}%`;
}

function isNameWarLoser(player: PublicPlayer) {
  return Boolean(player.nameWarEnabled && player.nameWarAllowRename && player.nameWarPunished && player.stats.rankedPoints <= -1000);
}

function nameWarRenameQuotaLeft(player: PublicPlayer, now = Date.now()) {
  if (!player.nameWarRenameWindowStartedAt || now - player.nameWarRenameWindowStartedAt >= 10_800_000) return 3;
  return Math.max(0, 3 - (player.nameWarRenameCount || 0));
}

function NameWarLoserPanel({ title, losers, me, onError }: { title: string; losers: PublicPlayer[]; me: PublicPlayer; onError: (message: string) => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const canRename = me.stats.rankedPoints >= 500 && nameWarRenameQuotaLeft(me, now) > 0;

  useEffect(() => {
    if (!losers.some((player) => player.nameWarRenameProtectedUntil && player.nameWarRenameProtectedUntil > now)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [losers, now]);

  async function renameTarget(targetId: string) {
    const name = (inputs[targetId] || "").trim();
    if (!name) return;
    try {
      await ask("nameWar:renameTarget", { targetId, name });
      setInputs((old) => ({ ...old, [targetId]: "" }));
      onError("名字修改成功");
    } catch (error) {
      onError(error instanceof Error ? error.message : "修改失败");
    }
  }

  return (
    <div className="panel name-war-loser-panel">
      <h2>🏷️ {title || "名字争夺战失格者"}</h2>
      <p className="hint">500 分以上玩家可抢先改名；你剩余 {nameWarRenameQuotaLeft(me, now)} / 3 次。</p>
      <div className="name-war-loser-list">
        {losers.map((player) => {
          const protectedMs = player.nameWarRenameProtectedUntil ? Math.max(0, player.nameWarRenameProtectedUntil - now) : 0;
          const protectedText = protectedMs > 0 ? `保护中 ${Math.ceil(protectedMs / 3_600_000)} 小时` : "可被改名";
          const disabled = !canRename || player.id === me.id || protectedMs > 0;
          return (
            <div className="name-war-loser-card" key={player.id}>
              <div className="admin-card-title">
                <strong>{player.nameWarPenaltyName || player.name}</strong>
                <small>{player.stats.rankedPoints} 分 · {protectedText}</small>
              </div>
              {player.nameWarRenamedByName && <p className="hint">最后改名者：{player.nameWarRenamedByName}</p>}
              <div className="send-row">
                <input value={inputs[player.id] || ""} maxLength={12} disabled={disabled} onChange={(event) => setInputs((old) => ({ ...old, [player.id]: event.target.value }))} placeholder={disabled ? "暂时不能改名" : "输入新名字"} />
                <button disabled={disabled} onClick={() => renameTarget(player.id)}>提交</button>
              </div>
            </div>
          );
        })}
        {losers.length === 0 && <p className="empty">暂无失格者</p>}
      </div>
    </div>
  );
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

  useEffect(() => {
    if (!cooldownMs && !nameWarCooldownMs) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownMs, nameWarCooldownMs]);

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
    try {
      const result = await ask<{ player: PublicPlayer }>("player:updateProfile", { name, genderId, nameWarEnabled, nameWarAllowRename });
      onUpdated(result.player);
      onError("个人资料已更新");
    } catch (error) {
      onError(error instanceof Error ? error.message : "保存失败");
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
          <div className="profile-action-row">
            <button className="primary" disabled={(nameChanged && (cooldownMs > 0 || nameLockedByWar)) || ((nameWarChanged || nameWarAllowRenameChanged) && nameWarCooldownMs > 0)} onClick={saveProfile}><Save size={16} /> 保存个人资料</button>
            <button onClick={onClose}>关闭个人设置</button>
          </div>
        </div>
      </section>
    </div>
  );
}

type AdminSection = "site" | "factions" | "titles" | "punishments" | "roomTags" | "roomInfoTags" | "nameWar" | "accessControl" | "bots" | "messages" | "actions" | "advanced";

const roomInfoTagOrder = [
  { key: "phaseReady", label: "等待坐满" },
  { key: "phaseChoosing", label: "出拳中" },
  { key: "phaseResult", label: "结算中" },
  { key: "phasePunishment", label: "惩罚阶段" },
  { key: "normal", label: "普通局" },
  { key: "ranked", label: "排位" },
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

function AdminPanel({ lobby, onBack, onError }: { lobby: LobbySnapshot; onBack: () => void; onError: (message: string) => void }) {
  const [password, setPassword] = useState("");
  const [logged, setLogged] = useState(false);
  const [draft, setDraft] = useState<AppConfig>(lobby.config);
  const [activeSection, setActiveSection] = useState<AdminSection>("site");
  const [activeFactionId, setActiveFactionId] = useState(lobby.config.genderFactions[0]?.id || "");
  const [factionSearch, setFactionSearch] = useState("");
  const [activeTitleId, setActiveTitleId] = useState(lobby.config.titles[0]?.id || "");
  const [titleSearch, setTitleSearch] = useState("");
  const [activePunishmentId, setActivePunishmentId] = useState(lobby.config.punishments[0]?.id || "");
  const [punishmentSearch, setPunishmentSearch] = useState("");
  const [announcementMessage, setAnnouncementMessage] = useState("");
  const [announcementSeconds, setAnnouncementSeconds] = useState("8");
  const [configText, setConfigText] = useState(JSON.stringify(lobby.config, null, 2));
  const [dirty, setDirty] = useState(false);
  const [serverConfigChanged, setServerConfigChanged] = useState(false);
  const lastServerConfigText = useRef(JSON.stringify(lobby.config));

  useEffect(() => {
    const nextText = JSON.stringify(lobby.config);
    if (nextText === lastServerConfigText.current) return;
    lastServerConfigText.current = nextText;
    if (dirty) {
      setServerConfigChanged(true);
      return;
    }
    applyServerConfig(lobby.config);
  }, [lobby.config, dirty]);

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
          <AdminSectionHeader title="名字争夺战" subtitle="设置惩罚名前缀、失格者面板标题和退出高难度后的称号。" />
          <div className="admin-preview-card">
            <span>预览</span>
            <strong>{preview}</strong>
            <p>{draft.nameWar.loserPanelTitle || "名字争夺战失格者"} · 退出高难度称号：{draft.nameWar.escapeTitle || "逃跑的人"}</p>
          </div>
          <div className="config-row">
            <label className="field-label">
              <span>惩罚名前缀 XXXX</span>
              <input value={draft.nameWar.penaltyPrefix} maxLength={16} onChange={(event) => patch({ nameWar: { ...draft.nameWar, penaltyPrefix: event.target.value } })} placeholder="例如：失名者" />
            </label>
            <label className="field-label">
              <span>大厅失格者面板标题</span>
              <input value={draft.nameWar.loserPanelTitle} maxLength={24} onChange={(event) => patch({ nameWar: { ...draft.nameWar, loserPanelTitle: event.target.value } })} placeholder="名字争夺战失格者" />
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
          <AdminSectionHeader title="系统提示" subtitle="修改密码错误、名字校验、保存提示等系统文案。" />
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
            <p>断线 {stats.disconnects} 次 · 重连 {stats.reconnects} 次</p>
            <p>最近房间快照 {formatBytes(stats.lastRoomSnapshotBytes)} · 最近大厅快照 {formatBytes(stats.lastLobbySnapshotBytes)}</p>
          </div>
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
          <div className="admin-list-section">
            <h3>房间管理</h3>
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
              </div>
            ))}
            {lobby.rooms.length === 0 && <p className="empty">暂无房间</p>}
          </div>
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
              <a className="button-link" href="/api/config/export" download="rps-config.json"><Download size={16} /> 导出配置</a>
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

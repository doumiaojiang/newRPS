import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, GenderFaction, GenderOption, RoomInfoTagStyle, RoomNamePool } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const configDir = path.join(rootDir, "config");
const defaultPath = path.join(configDir, "default.json");
const activePath = path.join(configDir, "active.json");

export function getRootDir() {
  return rootDir;
}

const defaultFactions: GenderFaction[] = [
  {
    id: "male_faction",
    label: "男性阵营",
    textColor: "#225c8d",
    backgroundColor: "#dff2ff",
    borderColor: "#92cdf2",
    genders: [
      { id: "boy", label: "男生", factionId: "male_faction" },
      { id: "male", label: "男性", factionId: "male_faction" }
    ]
  },
  {
    id: "female_faction",
    label: "女性阵营",
    textColor: "#8a3158",
    backgroundColor: "#ffe2ef",
    borderColor: "#f3a9ca",
    genders: [
      { id: "girl", label: "女生", factionId: "female_faction" },
      { id: "female", label: "女性", factionId: "female_faction" }
    ]
  },
  {
    id: "femboy_faction",
    label: "男娘阵营",
    textColor: "#6650a4",
    backgroundColor: "#eee9ff",
    borderColor: "#c7b5ff",
    genders: [
      { id: "femboy", label: "男娘", factionId: "femboy_faction" },
      { id: "transgirl", label: "药娘", factionId: "femboy_faction" }
    ]
  },
  {
    id: "other_faction",
    label: "其他阵营",
    textColor: "#4d5c6f",
    backgroundColor: "#eef3f8",
    borderColor: "#c9d6e4",
    genders: [
      { id: "attack_helicopter", label: "武装直升机", factionId: "other_faction" },
      { id: "walmart_bag", label: "沃尔玛购物袋", factionId: "other_faction" }
    ]
  }
];

const defaultRoomNamePool: RoomNamePool = {
  adjectives: ["粉蓝", "闪亮", "轻松", "神秘"],
  subjects: ["拳手", "挑战", "真心话", "冒险"],
  roomWords: ["小屋", "房间", "擂台", "茶会"]
};

const defaultPlayerPunishmentRoomNamePool: RoomNamePool = {
  adjectives: ["临时", "即兴", "神秘", "互写"],
  subjects: ["任务", "挑战", "惩罚", "考验"],
  roomWords: ["小屋", "房间", "剧场", "擂台"]
};

const defaultRoomTags = ["轻松", "认真", "排位", "惩罚", "聊天"];
const defaultGames: AppConfig["games"] = [
  { id: "rps", name: "锤子剪刀布", description: "双方同时选择石头、剪刀、布，服务器公开结算。" },
  { id: "othello", name: "黑白棋", description: "8x8 棋盘轮流落子，服务器判断翻棋和胜负。" }
];
const defaultNameWar = {
  penaltyPrefix: "失名者",
  loserPanelTitle: "名字争夺战失格者",
  escapeTitle: "逃跑的人",
  renamePanelTitle: "通用改名处",
  nameWarLoserLabel: "名争失格",
  extremeForceClosedLabel: "极限强关"
};
const defaultGiveaway = {
  panelTitle: "白给自救板",
  panelDescription: "提交一点自我惩罚宣言，等待其他玩家点赞帮你降低白给值。",
  submitPlaceholder: "写下你的自我惩罚宣言...",
  emptyText: "还没有人在白给自救板上。"
};
const defaultExtremeMode: AppConfig["extremeMode"] = {
  label: "极限模式",
  emoji: "⚡",
  cooldownHours: 12,
  positiveLossRates: { pos1: 0.9, pos2: 0.75, pos3: 0.6, pos4: 0.5 },
  negativeWinRates: { neg1: 0.9, neg2: 0.75, neg3: 0.6, neg4: 0.5 },
  hourlyDecay: { pos4: 10, pos3: 6, pos2: 4, pos1: 2, default: 2 },
  winStreakThreshold: 10,
  winStreakCrashChance: 0.5,
  crashTargetPoints: 333,
  forceCloseWarning: "强行关闭极限模式后，你会永久进入通用改名处，可被符合条件的极限玩家改名。",
  forceRenameMinPoints: 1,
  forceRenameProtectHours: 4
};

const defaultDailyAnnouncement: AppConfig["dailyAnnouncement"] = {
  enabled: true,
  title: "今日公告",
  content: "欢迎来到抖喵游戏屋。游玩时请尊重其他玩家，遇到卡房或异常可以联系管理员处理。",
  buttonText: "知道了",
  version: "default"
};
const defaultAccessControl = { maxOnlinePerIp: 3, maxCreatesPer10Min: 5 };
const defaultRoomInfoTags: Record<string, RoomInfoTagStyle> = {
  gameRps: { label: "锤子剪刀布", textColor: "#4d5c6f", backgroundColor: "#eef3f8", borderColor: "#c9d6e4" },
  gameOthello: { label: "黑白棋", textColor: "#163c32", backgroundColor: "#dff7ec", borderColor: "#93d8b8" },
  phaseReady: { label: "等待坐满", textColor: "#225c8d", backgroundColor: "#e5f5ff", borderColor: "#9ed7ff" },
  phaseChoosing: { label: "出拳中", textColor: "#6b4b00", backgroundColor: "#fff3c4", borderColor: "#ffd875" },
  phaseResult: { label: "结算中", textColor: "#6b3f8d", backgroundColor: "#f1e7ff", borderColor: "#c9a9ff" },
  phasePunishment: { label: "惩罚阶段", textColor: "#8a3158", backgroundColor: "#ffe2ef", borderColor: "#f3a9ca" },
  normal: { label: "普通局", textColor: "#3c6074", backgroundColor: "#edf8fb", borderColor: "#b7dfe9" },
  ranked: { label: "排位", textColor: "#765100", backgroundColor: "#fff0bd", borderColor: "#ffd66e" },
  punishment: { label: "惩罚开启", textColor: "#8a3158", backgroundColor: "#ffe5f1", borderColor: "#f3a9ca" },
  noPunishment: { label: "无惩罚", textColor: "#4d5c6f", backgroundColor: "#eef3f8", borderColor: "#c9d6e4" },
  tieDoublePunish: { label: "平局双罚", textColor: "#7b3a22", backgroundColor: "#ffe8dc", borderColor: "#ffb894" },
  requireOpponentConfirm: { label: "需要对手确认", textColor: "#225c8d", backgroundColor: "#e1f2ff", borderColor: "#8fcaf0" },
  allowProofImage: { label: "允许图片证明", textColor: "#326749", backgroundColor: "#e3f8ec", borderColor: "#9ed9b8" },
  textProofOnly: { label: "仅文字证明", textColor: "#5c5570", backgroundColor: "#f0edf8", borderColor: "#c8bedf" },
  extremeRanked: { label: "极限排位", textColor: "#7c3d00", backgroundColor: "#fff1d8", borderColor: "#ffbf75" }
};

function readJson(filePath: string): AppConfig {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AppConfig;
}

function cloneDefaultFactions() {
  return defaultFactions.map((faction) => ({
    ...faction,
    genders: faction.genders.map((gender) => ({ ...gender }))
  }));
}

function flattenGenders(factions: GenderFaction[]): GenderOption[] {
  return factions.flatMap((faction) => faction.genders.map((gender) => ({ ...gender, factionId: faction.id })));
}

function normalizeConfig(input: AppConfig): AppConfig {
  const existingFactions = Array.isArray(input.genderFactions) && input.genderFactions.length > 0
    ? input.genderFactions
    : cloneDefaultFactions();
  const genderFactions = existingFactions.map((faction) => ({
    ...faction,
    genders: faction.genders.map((gender) => ({ ...gender, factionId: faction.id }))
  }));
  const genders = flattenGenders(genderFactions);
  const titles = (input.titles || []).map((segment) => ({
    ...segment,
    names: cleanLines(segment.names, ["初心拳手"]),
    factionNames: Object.fromEntries(genderFactions.map((faction) => [
      faction.id,
      cleanLines(segment.factionNames?.[faction.id], segment.names || ["初心拳手"])
    ]))
  }));
  const punishments = (input.punishments || []).map((punishment) => ({
    ...punishment,
    cardImageUrl: punishment.cardImageUrl || "",
    cardImageOpacity: clampOpacity(punishment.cardImageOpacity),
    roomBackgroundImages: cleanLines(punishment.roomBackgroundImages, []),
    tasks: normalizePunishmentTasks(punishment, genderFactions),
    roomNamePool: normalizeRoomNamePool(punishment.roomNamePool)
  }));
  return {
    ...input,
    site: {
      ...input.site,
      name: String(input.site?.name || "").trim(),
      description: String(input.site?.description || ""),
      adminPassword: String(process.env.ADMIN_PASSWORD || input.site?.adminPassword || "").trim()
    },
    dailyAnnouncement: {
      enabled: input.dailyAnnouncement?.enabled !== false,
      title: String(input.dailyAnnouncement?.title || defaultDailyAnnouncement.title).trim().slice(0, 32) || defaultDailyAnnouncement.title,
      content: String(input.dailyAnnouncement?.content || defaultDailyAnnouncement.content).trim().slice(0, 800) || defaultDailyAnnouncement.content,
      buttonText: String(input.dailyAnnouncement?.buttonText || defaultDailyAnnouncement.buttonText).trim().slice(0, 16) || defaultDailyAnnouncement.buttonText,
      version: String(input.dailyAnnouncement?.version || defaultDailyAnnouncement.version).trim().slice(0, 32) || defaultDailyAnnouncement.version
    },
    genderFactions,
    genders,
    titles,
    punishments,
    bots: {
      names: cleanLines(input.bots?.names, ["Bot 小蓝", "Bot 小粉"]),
      difficulties: normalizeBotDifficulties(input.bots?.difficulties || [])
    },
    roomTags: cleanLines(input.roomTags, defaultRoomTags),
    games: normalizeGames(input.games),
    roomInfoTags: normalizeRoomInfoTags(input.roomInfoTags),
    accessControl: {
      maxOnlinePerIp: clampNumber(input.accessControl?.maxOnlinePerIp, 1, 100, defaultAccessControl.maxOnlinePerIp),
      maxCreatesPer10Min: clampNumber(input.accessControl?.maxCreatesPer10Min, 1, 200, defaultAccessControl.maxCreatesPer10Min)
    },
    nameWar: {
      penaltyPrefix: String(input.nameWar?.penaltyPrefix || defaultNameWar.penaltyPrefix).trim().slice(0, 16) || defaultNameWar.penaltyPrefix,
      loserPanelTitle: String(input.nameWar?.loserPanelTitle || defaultNameWar.loserPanelTitle).trim().slice(0, 24) || defaultNameWar.loserPanelTitle,
      escapeTitle: String(input.nameWar?.escapeTitle || defaultNameWar.escapeTitle).trim().slice(0, 18) || defaultNameWar.escapeTitle,
      renamePanelTitle: String(input.nameWar?.renamePanelTitle || input.nameWar?.loserPanelTitle || defaultNameWar.renamePanelTitle).trim().slice(0, 24) || defaultNameWar.renamePanelTitle,
      nameWarLoserLabel: String(input.nameWar?.nameWarLoserLabel || defaultNameWar.nameWarLoserLabel).trim().slice(0, 16) || defaultNameWar.nameWarLoserLabel,
      extremeForceClosedLabel: String(input.nameWar?.extremeForceClosedLabel || defaultNameWar.extremeForceClosedLabel).trim().slice(0, 16) || defaultNameWar.extremeForceClosedLabel
    },
    giveaway: {
      panelTitle: String(input.giveaway?.panelTitle || defaultGiveaway.panelTitle).trim().slice(0, 24) || defaultGiveaway.panelTitle,
      panelDescription: String(input.giveaway?.panelDescription || defaultGiveaway.panelDescription).trim().slice(0, 160) || defaultGiveaway.panelDescription,
      submitPlaceholder: String(input.giveaway?.submitPlaceholder || defaultGiveaway.submitPlaceholder).trim().slice(0, 60) || defaultGiveaway.submitPlaceholder,
      emptyText: String(input.giveaway?.emptyText || defaultGiveaway.emptyText).trim().slice(0, 60) || defaultGiveaway.emptyText
    },
    extremeMode: normalizeExtremeMode(input.extremeMode),
    playerPunishmentRoomNamePool: normalizeRoomNamePool(input.playerPunishmentRoomNamePool, defaultPlayerPunishmentRoomNamePool)
  };
}

function normalizeGames(input?: AppConfig["games"]) {
  const games = new Map(defaultGames.map((game) => [game.id, game]));
  for (const game of input || []) {
    if (game.id !== "rps" && game.id !== "othello") continue;
    games.set(game.id, {
      id: game.id,
      name: String(game.name || defaultGames.find((item) => item.id === game.id)?.name || game.id).trim().slice(0, 18),
      description: String(game.description || defaultGames.find((item) => item.id === game.id)?.description || "").trim().slice(0, 120)
    });
  }
  return ["rps", "othello"].map((id) => games.get(id as AppConfig["games"][number]["id"])!) as AppConfig["games"];
}

function normalizeRoomInfoTags(input?: Record<string, Partial<RoomInfoTagStyle>>) {
  return Object.fromEntries(Object.entries(defaultRoomInfoTags).map(([key, fallback]) => {
    const current = input?.[key];
    return [
      key,
      {
        label: String(current?.label || fallback.label).trim().slice(0, 16) || fallback.label,
        textColor: current?.textColor || fallback.textColor,
        backgroundColor: current?.backgroundColor || fallback.backgroundColor,
        borderColor: current?.borderColor || fallback.borderColor
      }
    ];
  })) as Record<string, RoomInfoTagStyle>;
}

function normalizeBotDifficulties(difficulties: AppConfig["bots"]["difficulties"]) {
  const defaults: Record<string, AppConfig["bots"]["difficulties"][number]> = {
    easy: { id: "easy", name: "简单", description: "完全随机出拳。", emoji: "🌱", level: 1, strategy: "random", cardColor: "#9ed7ff" },
    normal: { id: "normal", name: "普通", description: "观察玩家最近选择，稍微尝试反制。", emoji: "🎯", level: 3, strategy: "counter", cardColor: "#b8a7ff" },
    chaos: { id: "chaos", name: "混乱", description: "大多随机，偶尔连续使用同一招。", emoji: "🌀", level: 2, strategy: "chaos", cardColor: "#ffaad1" }
  };
  return (["easy", "normal", "chaos"] as const).map((id) => {
    const current = difficulties.find((item) => item.id === id);
    const fallback = defaults[id];
    return {
      ...fallback,
      ...current,
      emoji: current?.emoji || fallback.emoji,
      level: clampNumber(current?.level, 1, 5, fallback.level || 1),
      strategy: isBotStrategy(current?.strategy) ? current.strategy : fallback.strategy,
      cardColor: current?.cardColor || fallback.cardColor
    };
  });
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numberValue)));
}

function clampOpacity(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0.26;
  return Math.max(0, Math.min(1, numberValue));
}

function clampRatio(value: unknown, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(1, numberValue));
}

function normalizeNumberRecord(input: Record<string, unknown> | undefined, fallback: Record<string, number>, min: number, max: number) {
  return Object.fromEntries(Object.entries(fallback).map(([key, fallbackValue]) => {
    const numberValue = Number(input?.[key]);
    return [key, Number.isFinite(numberValue) ? Math.max(min, Math.min(max, numberValue)) : fallbackValue];
  }));
}

function normalizeExtremeMode(input?: Partial<AppConfig["extremeMode"]>): AppConfig["extremeMode"] {
  return {
    label: String(input?.label || defaultExtremeMode.label).trim().slice(0, 16) || defaultExtremeMode.label,
    emoji: String(input?.emoji || defaultExtremeMode.emoji).trim().slice(0, 4) || defaultExtremeMode.emoji,
    cooldownHours: clampNumber(input?.cooldownHours, 1, 168, defaultExtremeMode.cooldownHours),
    positiveLossRates: normalizeNumberRecord(input?.positiveLossRates, defaultExtremeMode.positiveLossRates, 0, 1),
    negativeWinRates: normalizeNumberRecord(input?.negativeWinRates, defaultExtremeMode.negativeWinRates, 0, 1),
    hourlyDecay: normalizeNumberRecord(input?.hourlyDecay, defaultExtremeMode.hourlyDecay, 0, 999),
    winStreakThreshold: clampNumber(input?.winStreakThreshold, 1, 100, defaultExtremeMode.winStreakThreshold),
    winStreakCrashChance: clampRatio(input?.winStreakCrashChance, defaultExtremeMode.winStreakCrashChance),
    crashTargetPoints: clampNumber(input?.crashTargetPoints, 1, 1999, defaultExtremeMode.crashTargetPoints),
    forceCloseWarning: String(input?.forceCloseWarning || defaultExtremeMode.forceCloseWarning).trim().slice(0, 180) || defaultExtremeMode.forceCloseWarning,
    forceRenameMinPoints: clampNumber(input?.forceRenameMinPoints, 1, 999, defaultExtremeMode.forceRenameMinPoints || 1),
    forceRenameProtectHours: clampNumber(input?.forceRenameProtectHours, 1, 168, defaultExtremeMode.forceRenameProtectHours || 4)
  };
}

function isBotStrategy(value: unknown): value is NonNullable<AppConfig["bots"]["difficulties"][number]["strategy"]> {
  return value === "random" || value === "counter" || value === "chaos" || value === "throw" || value === "win";
}

function normalizePunishmentTasks(punishment: AppConfig["punishments"][number], factions: GenderFaction[]) {
  const fallbackVariants = Object.fromEntries(factions.map((faction) => [
    faction.id,
    punishment.variants?.[faction.id] || punishment.description || "请完成本局惩罚。"
  ]));
  const rawTasks = Array.isArray(punishment.tasks) && punishment.tasks.length
    ? punishment.tasks
    : [{ id: "task1", name: "默认任务", variants: fallbackVariants }];
  return rawTasks.map((task, index) => ({
    id: task.id || `task${index + 1}`,
    name: task.name || `任务 ${index + 1}`,
    backgroundImages: cleanLines(task.backgroundImages, []),
    backgroundOpacity: clampTaskBackgroundOpacity(task.backgroundOpacity),
    variants: Object.fromEntries(factions.map((faction) => [
      faction.id,
      task.variants?.[faction.id] || fallbackVariants[faction.id]
    ]))
  }));
}

function clampTaskBackgroundOpacity(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0.22;
  return Math.max(0, Math.min(1, numberValue));
}

function normalizeRoomNamePool(pool?: Partial<RoomNamePool>, fallback: RoomNamePool = defaultRoomNamePool): RoomNamePool {
  return {
    adjectives: cleanLines(pool?.adjectives, fallback.adjectives),
    subjects: cleanLines(pool?.subjects, fallback.subjects),
    roomWords: cleanLines(pool?.roomWords, fallback.roomWords)
  };
}

function cleanLines(values: unknown, fallback: string[]) {
  const items = Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [];
  return items.length ? items : [...fallback];
}

function assertUnique(values: string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) throw new Error(`${label} 不能为空`);
    if (seen.has(value)) throw new Error(`${label} 不能重复：${value}`);
    seen.add(value);
  }
}

function assertHexColor(value: string, label: string) {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${label} 必须是 #RRGGBB 颜色值`);
}

// 这里做的是“很基础但有用”的配置校验。它不是为了限制你创作，
// 而是为了避免管理工具把 JSON 写坏后，整个服务器启动不了。
export function validateConfig(input: AppConfig) {
  input = normalizeConfig(input);
  if (!input.site?.name) throw new Error("网站名称不能为空");
  if (input.dailyAnnouncement?.enabled) {
    if (!input.dailyAnnouncement.title?.trim()) throw new Error("每日公告标题不能为空");
    if (!input.dailyAnnouncement.content?.trim()) throw new Error("每日公告内容不能为空");
    if (!input.dailyAnnouncement.buttonText?.trim()) throw new Error("每日公告按钮文字不能为空");
  }
  if (!Array.isArray(input.genders) || input.genders.length === 0) throw new Error("至少需要一个性别选项");
  if (!Array.isArray(input.genderFactions) || input.genderFactions.length === 0) throw new Error("至少需要一个性别阵营");
  assertUnique(input.genderFactions.map((faction) => faction.id), "阵营 ID");
  assertUnique(input.genders.map((gender) => gender.id), "性别 ID");
  for (const faction of input.genderFactions) {
    if (!faction.label) throw new Error("阵营名称不能为空");
    if (!faction.genders.length) throw new Error(`${faction.label} 至少需要一个性别`);
    assertHexColor(faction.textColor, `${faction.label} 文字颜色`);
    assertHexColor(faction.backgroundColor, `${faction.label} 背景颜色`);
    assertHexColor(faction.borderColor, `${faction.label} 边框颜色`);
  }
  if (!Array.isArray(input.titles) || input.titles.length === 0) throw new Error("至少需要一个称号段位");
  for (const segment of input.titles) {
    if (!segment.names.length) throw new Error(`${segment.id} 至少需要一个通用称号`);
    for (const faction of input.genderFactions) {
      if (!segment.factionNames?.[faction.id]?.length) throw new Error(`${segment.id} 缺少 ${faction.label} 专属称号`);
    }
  }
  if (!Array.isArray(input.punishments) || input.punishments.length === 0) throw new Error("至少需要一个惩罚选项");
  for (const punishment of input.punishments) {
    if (!punishment.tasks?.length) throw new Error(`${punishment.name} 至少需要一个任务`);
    if (typeof punishment.cardImageOpacity !== "number" || punishment.cardImageOpacity < 0 || punishment.cardImageOpacity > 1) {
      throw new Error(`${punishment.name} 的卡片背景透明率必须在 0 到 1 之间`);
    }
    if (!Array.isArray(punishment.roomBackgroundImages)) throw new Error(`${punishment.name} 的房间背景图库格式不正确`);
    assertUnique(punishment.tasks.map((task) => task.id), `${punishment.name} 任务 ID`);
    for (const task of punishment.tasks) {
      if (!task.name) throw new Error(`${punishment.name} 里有任务名称为空`);
      if (!Array.isArray(task.backgroundImages)) throw new Error(`${punishment.name} / ${task.name} 的任务背景图库格式不正确`);
      if (typeof task.backgroundOpacity !== "number" || task.backgroundOpacity < 0 || task.backgroundOpacity > 1) {
        throw new Error(`${punishment.name} / ${task.name} 的任务背景透明率必须在 0 到 1 之间`);
      }
      for (const faction of input.genderFactions) {
        if (!task.variants?.[faction.id]?.trim()) throw new Error(`${punishment.name} / ${task.name} 缺少 ${faction.label} 任务版本`);
      }
    }
    if (!punishment.roomNamePool?.subjects.length || !punishment.roomNamePool.roomWords.length) {
      throw new Error(`${punishment.name} 的随机房名至少需要名词/动词和房间词`);
    }
  }
  if (!input.playerPunishmentRoomNamePool?.subjects.length || !input.playerPunishmentRoomNamePool.roomWords.length) {
    throw new Error("玩家发布任务随机房名至少需要名词/动词和房间词");
  }
  if (!Array.isArray(input.roomTags)) throw new Error("房间标签格式不正确");
  for (const [key, tag] of Object.entries(input.roomInfoTags || {})) {
    if (!tag.label?.trim()) throw new Error(`房间信息标签 ${key} 的名字不能为空`);
    assertHexColor(tag.textColor, `${tag.label} 文字颜色`);
    assertHexColor(tag.backgroundColor, `${tag.label} 背景颜色`);
    assertHexColor(tag.borderColor, `${tag.label} 边框颜色`);
  }
  if (!input.nameWar?.penaltyPrefix?.trim()) throw new Error("名字争夺战前缀不能为空");
  if (!input.nameWar?.loserPanelTitle?.trim()) throw new Error("名字争夺战失格者标题不能为空");
  if (!input.nameWar?.escapeTitle?.trim()) throw new Error("名字争夺战逃跑称号不能为空");
  if (!input.nameWar?.renamePanelTitle?.trim()) throw new Error("通用改名处标题不能为空");
  if (!input.nameWar?.nameWarLoserLabel?.trim()) throw new Error("名争失格标签不能为空");
  if (!input.nameWar?.extremeForceClosedLabel?.trim()) throw new Error("极限强关标签不能为空");
  if (!input.giveaway?.panelTitle?.trim()) throw new Error("白给模式面板标题不能为空");
  if (!input.giveaway?.panelDescription?.trim()) throw new Error("白给模式说明不能为空");
  if (!input.giveaway?.submitPlaceholder?.trim()) throw new Error("白给模式输入提示不能为空");
  if (!input.giveaway?.emptyText?.trim()) throw new Error("白给模式空状态文案不能为空");
  if (!input.extremeMode?.label?.trim()) throw new Error("极限模式名称不能为空");
  if (!input.extremeMode?.emoji?.trim()) throw new Error("极限模式标志不能为空");
  if (!Number.isFinite(input.extremeMode.cooldownHours) || input.extremeMode.cooldownHours < 1) throw new Error("极限模式冷却小时数至少为 1");
  for (const [key, value] of Object.entries(input.extremeMode.positiveLossRates)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`极限模式 ${key} 掉分比例必须在 0 到 1 之间`);
  }
  for (const [key, value] of Object.entries(input.extremeMode.negativeWinRates)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`极限模式 ${key} 加分比例必须在 0 到 1 之间`);
  }
  for (const [key, value] of Object.entries(input.extremeMode.hourlyDecay)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`极限模式 ${key} 整点扣分不能小于 0`);
  }
  if (!Number.isFinite(input.extremeMode.winStreakThreshold) || input.extremeMode.winStreakThreshold < 1) throw new Error("极限模式连胜阈值至少为 1");
  if (!Number.isFinite(input.extremeMode.winStreakCrashChance) || input.extremeMode.winStreakCrashChance < 0 || input.extremeMode.winStreakCrashChance > 1) throw new Error("极限模式连胜风险概率必须在 0 到 1 之间");
  if (!Number.isFinite(input.extremeMode.crashTargetPoints) || input.extremeMode.crashTargetPoints < 1) throw new Error("极限模式连胜风险扣分至少为 1");
  const forceRenameMinPoints = input.extremeMode.forceRenameMinPoints ?? defaultExtremeMode.forceRenameMinPoints ?? 1;
  const forceRenameProtectHours = input.extremeMode.forceRenameProtectHours ?? defaultExtremeMode.forceRenameProtectHours ?? 4;
  if (!input.extremeMode.forceCloseWarning?.trim()) throw new Error("极限模式强行关闭提示不能为空");
  if (!Number.isFinite(forceRenameMinPoints) || forceRenameMinPoints < 1) throw new Error("极限强关改名最低分至少为 1");
  if (!Number.isFinite(forceRenameProtectHours) || forceRenameProtectHours < 1) throw new Error("极限强关改名保护小时至少为 1");
  if (!Number.isFinite(input.accessControl?.maxOnlinePerIp) || input.accessControl.maxOnlinePerIp < 1) throw new Error("同 IP 在线人数限制至少为 1");
  if (!Number.isFinite(input.accessControl?.maxCreatesPer10Min) || input.accessControl.maxCreatesPer10Min < 1) throw new Error("同 IP 10 分钟新建玩家限制至少为 1");
  if (!input.bots?.names?.length || !input.bots?.difficulties?.length) throw new Error("bot 名字和难度不能为空");
  for (const difficulty of input.bots.difficulties) {
    if (!isBotStrategy(difficulty.strategy)) throw new Error(`${difficulty.name} 的 Bot 策略不正确`);
    if (!difficulty.cardColor || !/^#[0-9a-fA-F]{6}$/.test(difficulty.cardColor)) throw new Error(`${difficulty.name} 的卡片颜色必须是 #RRGGBB`);
  }
  if (!Array.isArray(input.games) || input.games.length === 0) throw new Error("至少需要一个游戏配置");
  return input;
}

export function loadConfig(): AppConfig {
  if (!fs.existsSync(activePath)) {
    fs.copyFileSync(defaultPath, activePath);
  }
  return validateConfig(readJson(activePath));
}

export function saveConfig(nextConfig: AppConfig): AppConfig {
  const valid = validateConfig(nextConfig);
  fs.writeFileSync(activePath, JSON.stringify(valid, null, 2), "utf-8");
  return loadConfig();
}

export function resetConfig(): AppConfig {
  fs.copyFileSync(defaultPath, activePath);
  return loadConfig();
}

export function exportConfigText(): string {
  return fs.readFileSync(activePath, "utf-8");
}

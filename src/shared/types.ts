export type GenderColors = {
  textColor: string;
  backgroundColor: string;
  borderColor: string;
};
export type GenderOption = { id: string; label: string; factionId: string };
export type GenderFaction = GenderColors & {
  id: string;
  label: string;
  genders: GenderOption[];
};
export type Move = "rock" | "scissors" | "paper" | "giveaway" | "forfeit" | "noMove";
export type RoundResult = "A" | "B" | "draw" | "doubleLoss";
export type GamePhase = "waiting" | "ready" | "choosing" | "result" | "punishment";
export type SeatKey = "A" | "B";
export type RankMultiplier = 1 | 2 | 5 | 10;
export type BotDifficulty = "easy" | "normal" | "chaos";
export type BotStrategy = "random" | "counter" | "chaos" | "throw" | "win";

export type RoomNamePool = {
  adjectives: string[];
  subjects: string[];
  roomWords: string[];
};

export type RoomInfoTagStyle = GenderColors & {
  label: string;
};

export type PunishmentTaskConfig = {
  id: string;
  name: string;
  variants: Record<string, string>;
  backgroundImages?: string[];
  backgroundOpacity?: number;
};

export type PublicStats = {
  wins: number;
  losses: number;
  draws: number;
  punishments: number;
  rankedPoints: number;
  title: string;
  titleSegmentId?: string;
};

export type PublicPlayer = {
  id: string;
  name: string;
  genderId: string;
  genderLabel: string;
  factionId: string;
  factionLabel: string;
  factionColors: GenderColors;
  displayName: string;
  connected: boolean;
  disconnectedAt?: number;
  disconnectExpiresAt?: number;
  profileUpdatedAt?: number;
  nameWarEnabled?: boolean;
  nameWarToggledAt?: number;
  nameWarOriginalName?: string;
  nameWarPenaltyName?: string;
  nameWarPunished?: boolean;
  nameWarAllowRename?: boolean;
  nameWarRenameProtectedUntil?: number;
  nameWarRenamedBy?: string;
  nameWarRenamedByName?: string;
  nameWarRenameWindowStartedAt?: number;
  nameWarRenameCount?: number;
  giveawayEnabled?: boolean;
  giveawayValue?: number;
  giveawayClicks?: number;
  giveawayBoardText?: string;
  giveawayBoardSubmittedAt?: number;
  giveawayBoardExpiresAt?: number;
  giveawayBoardLikes?: number;
  giveawayBoardDislikes?: number;
  giveawayBoardLikeWindowStartedAt?: number;
  giveawayBoardLikesThisHour?: number;
  giveawayVoteWindowStartedAt?: number;
  giveawayVoteCount?: number;
  giveawayVoteLikesThisHour?: number;
  giveawayVoteDislikesThisHour?: number;
  rankMultiplierUnlocked?: boolean;
  extremeModeEnabled?: boolean;
  extremeModeToggledAt?: number;
  extremeModeCooldownUntil?: number;
  extremeWinStreak?: number;
  extremeLastDecayHour?: number;
  roomId?: string;
  isAdmin?: boolean;
  stats: PublicStats;
};

export type BotPlayer = {
  id: string;
  name: string;
  difficulty: BotDifficulty;
  isBot: true;
};

export type SeatOccupant = PublicPlayer | BotPlayer | null;

export type ChatMessage = {
  id: string;
  roomId?: string;
  playerId: string;
  author: string;
  authorPlayer?: PublicPlayer;
  authorRole?: string;
  text: string;
  at: number;
  system?: boolean;
  transient?: boolean;
  expiresAt?: number;
};

export type Suggestion = {
  id: string;
  playerId: string;
  author: string;
  authorPlayer?: PublicPlayer;
  text: string;
  at: number;
};

export type RoomSettings = {
  name: string;
  password?: string;
  gameId: "rps";
  enableBot: boolean;
  botDifficulty: BotDifficulty;
  enablePunishment: boolean;
  punishmentSource?: "system" | "player";
  punishmentId?: string;
  punishmentIds?: string[];
  roomBackgroundImage?: string;
  enableTags?: boolean;
  tags?: string[];
  allowProofImage?: boolean;
  tieDoublePunish: boolean;
  requireOpponentConfirm: boolean;
  enableRanked: boolean;
  stake: 5 | 10 | 20;
  enableRankMultiplier?: boolean;
  rankMultiplier?: RankMultiplier;
  enableExtremeRanked?: boolean;
};

export type PunishmentProof = {
  playerId: string;
  text: string;
  imageUrl?: string;
  taskText?: string;
  status?: "pending" | "approved" | "rejected";
  confirmedBy?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  rejectReason?: string;
  redoTaskText?: string;
  submittedAt: number;
};

export type SeatStats = {
  wins: number;
  losses: number;
  draws: number;
  punishments: number;
};

export type RoundHistoryItem = {
  id: string;
  round: number;
  at: number;
  playerA: string;
  playerB: string;
  moveA: Move;
  moveB: Move;
  result: RoundResult;
  resultLabel: string;
  resultText: string;
  ranked: boolean;
  stake?: 5 | 10 | 20;
  rankMultiplier?: RankMultiplier;
  effectiveStake?: number;
  extremeRanked?: boolean;
  punishmentName?: string;
  punishmentDescription?: string;
  punishmentTasks: Array<{
    playerId: string;
    playerName: string;
    factionId: string;
    factionLabel: string;
    taskText: string;
    backgroundImage?: string;
    backgroundOpacity?: number;
    assignedBy?: string;
    assignedByName?: string;
  }>;
  punishedNames: string[];
  proofs: Array<{
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
  }>;
};

export type RoomSnapshot = {
  id: string;
  code: string;
  updatedAt: number;
  settings: RoomSettings;
  status: "waiting" | "playing" | "punishment";
  phase: GamePhase;
  seats: Record<SeatKey, SeatOccupant>;
  spectators: PublicPlayer[];
  ready: Record<SeatKey, boolean>;
  choices: Partial<Record<SeatKey, Move | "hidden">>;
  revealedChoices?: Partial<Record<SeatKey, Move>>;
  resultText?: string;
  punishedPlayerIds: string[];
  proofs: PunishmentProof[];
  score: Record<SeatKey, number>;
  seatedScore: Record<SeatKey, number>;
  seatStats: Record<SeatKey, SeatStats>;
  roundHistory: RoundHistoryItem[];
  roundHistoryTotal: number;
  chat: ChatMessage[];
};

export type ServerStats = {
  startedAt: number;
  roomBroadcasts: number;
  lobbyBroadcasts: number;
  disconnects: number;
  reconnects: number;
  lastRoomSnapshotBytes: number;
  lastLobbySnapshotBytes: number;
  recentRoomBroadcasts: number;
  recentLobbyBroadcasts: number;
  averageRoomSnapshotBytes: number;
  averageLobbySnapshotBytes: number;
};

export type LobbySnapshot = {
  config?: AppConfig;
  onlineCount: number;
  players: PublicPlayer[];
  rooms: Array<{
    id: string;
    code: string;
    name: string;
    hasPassword: boolean;
    players: number;
    spectators: number;
    versus: {
      A: { name: string; isBot: true } | { player: PublicPlayer } | null;
      B: { name: string; isBot: true } | { player: PublicPlayer } | null;
    };
    status: RoomSnapshot["status"];
    roomBackgroundImage?: string;
    enableBot: boolean;
    botDifficulty: BotDifficulty;
    enablePunishment: boolean;
    punishmentIds?: string[];
    punishmentId?: string;
    tieDoublePunish: boolean;
    requireOpponentConfirm: boolean;
    enableRanked: boolean;
    stake: 5 | 10 | 20;
    enableRankMultiplier?: boolean;
    rankMultiplier?: RankMultiplier;
    enableExtremeRanked?: boolean;
    tags?: string[];
  }>;
  normalLeaderboard: PublicPlayer[];
  rankedLeaderboard: PublicPlayer[];
  suggestions: Suggestion[];
  lobbyChat: ChatMessage[];
  serverStats: ServerStats;
};

export type AppConfig = {
  site: {
    name: string;
    description: string;
    adminPassword: string;
  };
  genders: GenderOption[];
  genderFactions: GenderFaction[];
  titles: Array<{
    id: string;
    min: number;
    max: number;
    names: string[];
    factionNames?: Record<string, string[]>;
  }>;
  punishments: Array<{
    id: string;
    name: string;
    description: string;
    variants?: Record<string, string>;
    tasks?: PunishmentTaskConfig[];
    cardImageUrl?: string;
    cardImageOpacity?: number;
    roomBackgroundImages?: string[];
    roomNamePool?: RoomNamePool;
  }>;
  playerPunishmentRoomNamePool?: RoomNamePool;
  roomTags: string[];
  roomInfoTags: Record<string, RoomInfoTagStyle>;
  accessControl: {
    maxOnlinePerIp: number;
    maxCreatesPer10Min: number;
  };
  nameWar: {
    penaltyPrefix: string;
    loserPanelTitle: string;
    escapeTitle: string;
  };
  giveaway: {
    panelTitle: string;
    panelDescription: string;
    submitPlaceholder: string;
    emptyText: string;
  };
  extremeMode: {
    label: string;
    emoji: string;
    cooldownHours: number;
    positiveLossRates: Record<string, number>;
    negativeWinRates: Record<string, number>;
    hourlyDecay: Record<string, number>;
    winStreakThreshold: number;
    winStreakCrashChance: number;
    crashTargetPoints: number;
  };
  bots: {
    names: string[];
    difficulties: Array<{
      id: BotDifficulty;
      name: string;
      description: string;
      emoji?: string;
      level?: number;
      strategy?: BotStrategy;
      cardColor?: string;
    }>;
  };
  games: Array<{
    id: "rps";
    name: string;
    description: string;
  }>;
  messages: Record<string, string>;
};

export type ClientError = { message: string };

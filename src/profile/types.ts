/**
 * 用户画像类型定义
 * 用户画像是从现有记忆（user/soul/fact/project）派生的视图
 * 不替代原始记忆，独立于助手人格（persona）。
 */

export type ProfileSource = 'stated' | 'observed' | 'inferred';

export type ProfileCategory = 'preference' | 'communication' | 'goal' | 'boundary' | 'relationship';

/**
 * 画像项 - 使用者的单个特征/偏好/目标
 */
export interface ProfileItem {
  /** 分类：偏好、沟通风格、目标、边界 */
  category: ProfileCategory;
  
  /** 画像内容 */
  content: string;
  
  /** 来源：明说 > 多次观察 > LLM 推断 */
  source: ProfileSource;
  
  /** 置信度 0-1（stated=1.0, observed=0.7-0.9, inferred=0.4-0.7） */
  confidence: number;
  
  /** 证据记忆的 ID 列表 */
  evidenceIds: string[];
  
  /** 最后确认时间（UTC ms） */
  lastConfirmedAt: number;
  
  /** 失效时间（仅 inferred 类型，UTC ms） */
  expiresAt?: number;

  /** 这条画像项由源记忆的哪些字段推导而来（可追溯依据） */
  trace?: ProfileItemTrace;
}

/** 画像项的单条依据快照 */
export interface ProfileItemTrace {
  /** 源记忆所在层 */
  level: string;
  /** 分类命中规则（如 boundary-keyword / soul-level / default-preference） */
  categoryRule: string;
  /** 源记忆重要度（0–5 口径由写入方决定，原样记录） */
  importance: number;
  /** 源记忆访问次数 */
  accessCount: number;
  /** 源记忆自身置信度；未设置时为 null */
  memoryConfidence: number | null;
  /** 源记忆更新时间 */
  updatedAt: number;
}

/**
 * 画像整体依据。
 * 回答「读了哪些层、多少条、过滤掉多少、每条证据是谁」
 * 每次 `generateUserProfile` 现算，不落库（画像是派生视图）。
 */
export interface ProfileBasis {
  generatedAt: number;
  /** 参与聚合的层 */
  levels: string[];
  /** 读到的记忆条数（过滤前） */
  scanned: number;
  /** 进入画像的条目数（过滤后） */
  used: number;
  /** 三类过滤原因的条数 */
  excluded: { sensitive: number; lowConfidence: number; expired: number };
  /** 所有证据记忆 id（与条目一一对应，按生成顺序） */
  evidenceIds: string[];
  byCategory: Record<ProfileCategory, number>;
  bySource: Record<ProfileSource, number>;
  /** 生成时生效的阈值快照，便于解释「为什么这条没进画像」 */
  thresholds: { minConfidence: number; inferredExpiryDays: number; sensitiveKeywords: number };
}

/**
 * 用户画像 - 从记忆聚合的用户理解
 */
export interface UserProfile {
  /** 总体摘要（200-300 字） */
  summary: string;
  
  /** 偏好列表 */
  preferences: ProfileItem[];
  
  /** 沟通风格 */
  communicationStyle: ProfileItem[];
  
  /** 目标/期望 */
  goals: ProfileItem[];
  
  /** 边界/禁区 */
  boundaries: ProfileItem[];
  
  /** 关系状态/互动模式 */
  relationship: ProfileItem[];
  
  /** 画像生成时间 */
  generatedAt: number;
  
  /** 基于的记忆数量 */
  baseMemoryCount: number;

  /** 画像依据（层、过滤计数、阈值、证据 id） */
  basis?: ProfileBasis;
  
  /** 用户自定义的画像描述（可编辑） */
  customDescription?: string;
  
  /** 最后更新时间 */
  lastUpdatedAt?: number;
}

/**
 * 画像配置
 */
export interface ProfileConfig {
  /** 是否启用画像功能 */
  enabled: boolean;
  
  /** 是否在 S2 注入画像 */
  injectToS2: boolean;
  
  /** S2 注入的字符预算（默认 300-600） */
  s2Budget: { min: number; max: number };
  
  /** inferred 类型的过期时间（天，默认 30） */
  inferredExpiryDays: number;
  
  /** 最低置信度阈值（默认 0.4） */
  minConfidence: number;
  
  /** 隐私敏感关键词（不推断这些属性） */
  sensitiveKeywords: string[];
}

/**
 * 默认画像配置
 */
export const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  enabled: true, // 默认启用画像功能
  injectToS2: true,
  s2Budget: { min: 300, max: 600 },
  inferredExpiryDays: 30,
  minConfidence: 0.4,
  sensitiveKeywords: [
    // 健康
    '健康', '疾病', '病史', '药物', '治疗',
    'health', 'disease', 'medical', 'medication',
    // 政治
    '政治', '党派', '投票', '选举',
    'political', 'party', 'vote', 'election',
    // 宗教
    '宗教', '信仰', '教派',
    'religion', 'belief', 'faith',
    // 性取向
    '性取向', '性别认同',
    'sexual orientation', 'gender identity',
    // 其他敏感
    '种族', '民族', '残疾',
    'race', 'ethnicity', 'disability',
  ],
};

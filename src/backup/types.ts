/**
 * 备份恢复完整性 - Types
 */

export interface BackupOptions {
  label?: string;           // 备份标签
  encrypt?: boolean;        // 是否加密
  encryptionKey?: string;   // 加密密钥（用户提供）
}

export interface BackupResult {
  id: number;               // 备份记录 ID
  filename: string;         // 备份文件名
  filepath: string;         // 完整路径
  size: number;             // 文件大小（字节）
  sha256: string;           // SHA256 校验和
  schemaVersion: number;    // Schema 版本
  createdAt: number;        // 创建时间戳
  encrypted: boolean;       // 是否加密
}

export interface BackupInfo {
  id: number;
  filename: string;
  filepath: string;
  size: number;
  sha256: string;
  schemaVersion: number;
  createdAt: number;
  encrypted: boolean;
}

export interface RestoreOptions {
  verifyIntegrity?: boolean; // 恢复前验证完整性（默认 true）
  createSafetyBackup?: boolean; // 恢复前创建安全备份（默认 true）
  decryptionKey?: string;    // 解密密钥
}

export interface RestoreResult {
  ok: boolean;
  restored?: string;         // 恢复的备份名
  safetyBackup?: string;     // 安全备份文件名
  schemaVersion?: number;    // 恢复的 schema 版本
  error?: string;
}

export interface VerificationResult {
  valid: boolean;
  filename: string;
  expectedSha256: string;
  actualSha256?: string;
  schemaVersion: number;
  /** 校验值来源：`sidecar` = 备份旁文件，`db` = 升级前的旧备份回退 */
  checksumSource?: "sidecar" | "db";
  error?: string;
}

export interface BackupConfig {
  enabled: boolean;          // 启用备份功能（默认 true）
  autoBackup: boolean;       // 自动备份（默认 false）
  maxBackups: number;        // 最大保留备份数（默认 10）
  encrypt: boolean;          // 默认加密（默认 false）
  encryptionKey?: string;    // 默认加密密钥
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: true,
  autoBackup: false,
  maxBackups: 10,
  encrypt: false,
};

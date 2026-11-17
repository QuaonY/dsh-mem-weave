/**
 * 备份恢复完整性 - Backup Manager
 * 支持完整性校验、可选加密、备份元数据跟踪
 * 加密格式升级（AES-256-CBC + sha256 派生 → AES-256-GCM + scrypt）。
 * 新文件带 62 字节头（magic / version / KDF 参数 / salt / IV / auth tag），旧 CBC 文件仍可解密。
 * 校验值写旁文件 `<backup>.sha256`，不再只存在与备份同目录的 SQLite 里。
 */

import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WeaveEnv } from "../store/db";
import type { BackupOptions, BackupResult, BackupInfo, VerificationResult } from "./types";

/** 旧格式（v1.x）：AES-256-CBC，仅用于读旧备份 */
const LEGACY_ALGORITHM = "aes-256-cbc";
const LEGACY_IV_LENGTH = 16;

/** 新格式：AES-256-GCM + scrypt */
const MAGIC = Buffer.from("MWBK", "ascii");
const FORMAT_VERSION = 2;
const KDF_SCRYPT = 1;
const ALGORITHM = "aes-256-gcm";
const SALT_LENGTH = 16;
const GCM_IV_LENGTH = 12;
const TAG_LENGTH = 16;
/** scrypt 参数随文件头存储，未来换代也不影响旧文件解密 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const HEADER_LENGTH = MAGIC.length + 1 + 1 + 12 + SALT_LENGTH + GCM_IV_LENGTH + TAG_LENGTH; // 62

/**
 * 计算文件 SHA256
 */
function calculateSHA256(filepath: string): string {
  const data = readFileSync(filepath);
  return createHash("sha256").update(data).digest("hex");
}

/** 校验和旁文件路径：与密文分开存，避免只改数据库就能骗过校验 */
function checksumPath(filepath: string): string {
  return filepath + ".sha256";
}

function writeChecksum(filepath: string, sha256: string): void {
  writeFileSync(checksumPath(filepath), sha256 + "\n", { encoding: "utf8" });
}

function readChecksum(filepath: string): string | null {
  try {
    const text = readFileSync(checksumPath(filepath), "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** 旧格式密钥派生（sha256 单次），只用于解密历史备份 */
function legacyKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/** 新格式密钥派生：scrypt + 每文件随机 salt */
function deriveKey(key: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(key, salt, 32, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

/** 组装新格式头 */
function buildHeader(salt: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH);
  let offset = 0;
  MAGIC.copy(header, offset);
  offset += MAGIC.length;
  header.writeUInt8(FORMAT_VERSION, offset++);
  header.writeUInt8(KDF_SCRYPT, offset++);
  header.writeUInt32BE(SCRYPT_N, offset);
  offset += 4;
  header.writeUInt32BE(SCRYPT_R, offset);
  offset += 4;
  header.writeUInt32BE(SCRYPT_P, offset);
  offset += 4;
  salt.copy(header, offset);
  offset += SALT_LENGTH;
  iv.copy(header, offset);
  offset += GCM_IV_LENGTH;
  tag.copy(header, offset);
  return header;
}

function isNewFormat(data: Buffer): boolean {
  return data.length >= HEADER_LENGTH && data.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * 加密文件
 * 新格式：MWBK | version | kdf | N | r | p | salt | iv | tag | ciphertext
 * GCM 的 tag 会在解密时校验，改一个字节就解不开。
 * @internal 导出只为让测试能对任意字节做往返验证
 */
export function encryptFile(sourcePath: string, destPath: string, key: string): void {
  const data = readFileSync(sourcePath);

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(GCM_IV_LENGTH);
  const keyBuffer = deriveKey(key, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);

  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  writeFileSync(destPath, Buffer.concat([buildHeader(salt, iv, tag), encrypted]));
}

/**
 * 解密文件
 * 自动识别两种格式：
 * - 新格式（GCM + scrypt）：校验 tag，失败说明密钥错或文件被改；
 * - 旧格式（AES-256-CBC）：只做兼容，无认证，无法区分「密钥错」与「文件坏」。
 * @internal 导出只为让测试能对任意字节做往返验证
 */
export function decryptFile(sourcePath: string, destPath: string, key: string): void {
  const data = readFileSync(sourcePath);

  if (isNewFormat(data)) {
    let offset = MAGIC.length;
    const version = data.readUInt8(offset++);
    const kdf = data.readUInt8(offset++);
    const n = data.readUInt32BE(offset);
    offset += 4;
    const r = data.readUInt32BE(offset);
    offset += 4;
    const p = data.readUInt32BE(offset);
    offset += 4;
    const salt = data.subarray(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;
    const iv = data.subarray(offset, offset + GCM_IV_LENGTH);
    offset += GCM_IV_LENGTH;
    const tag = data.subarray(offset, offset + TAG_LENGTH);
    offset += TAG_LENGTH;
    const encrypted = data.subarray(offset);

    if (version !== FORMAT_VERSION || kdf !== KDF_SCRYPT) {
      throw new Error(`Unsupported backup format (version=${version}, kdf=${kdf})`);
    }

    try {
      const keyBuffer = deriveKey(key, salt, n, r, p);
      const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv, { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      writeFileSync(destPath, decrypted);
    } catch (err) {
      throw new Error(
        "Backup authentication failed: wrong decryption key or tampered backup file",
        { cause: err },
      );
    }
    return;
  }

  // 旧格式兼容：IV + CBC 密文，sha256 单次派生
  const iv = data.subarray(0, LEGACY_IV_LENGTH);
  const encrypted = data.subarray(LEGACY_IV_LENGTH);
  const decipher = createDecipheriv(LEGACY_ALGORITHM, legacyKey(key), iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  writeFileSync(destPath, decrypted);
}

export class BackupManager {
  constructor(
    private env: WeaveEnv,
    private schemaVersion: number
  ) {}

  /**
   * 创建备份
   */
  createBackup(options: BackupOptions = {}): BackupResult {
    const { label, encrypt = false, encryptionKey } = options;

    if (encrypt && !encryptionKey) {
      throw new Error("Encryption key required when encrypt is true");
    }

    const timestamp = Date.now();
    const labelSuffix = label ? `.${label.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
    const filename = `memweave.db.backup.${timestamp}${labelSuffix}.db`;
    const backupDir = join(this.env.dataDir, "backups");
    
    // 确保备份目录存在
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
    
    const filepath = join(backupDir, filename);

    // 1. 使用 VACUUM INTO 创建备份 (需要在 WAL checkpoint 之后)
    this.env.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.env.db.exec(`VACUUM INTO '${filepath.replace(/'/g, "''")}'`);

    let finalPath = filepath;
    let finalFilename = filename;

    // 2. 如果需要加密
    if (encrypt && encryptionKey) {
      const encryptedFilename = filename + ".enc";
      const encryptedPath = join(backupDir, encryptedFilename);
      encryptFile(filepath, encryptedPath, encryptionKey);
      
      // 删除未加密的临时文件
      unlinkSync(filepath);
      
      finalPath = encryptedPath;
      finalFilename = encryptedFilename;
    }

    // 3. 计算 SHA256（密文文件），校验和写到旁文件
    const sha256 = calculateSHA256(finalPath);
    const size = statSync(finalPath).size;
    writeChecksum(finalPath, sha256);

    // 4. 记录到数据库
    const result = this.env.db.prepare(`
      INSERT INTO backups (filename, filepath, size_bytes, sha256, schema_version, created_at, is_encrypted, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(finalFilename, finalPath, size, sha256, this.schemaVersion, timestamp, encrypt ? 1 : 0, label || null);

    return {
      id: Number(result.lastInsertRowid),
      filename: finalFilename,
      filepath: finalPath,
      size,
      sha256,
      schemaVersion: this.schemaVersion,
      createdAt: timestamp,
      encrypted: encrypt,
    };
  }

  /**
   * 列出所有备份
   */
  listBackups(): BackupInfo[] {
    const rows = this.env.db.prepare(`
      SELECT id, filename, filepath, size_bytes, sha256, schema_version, created_at, is_encrypted
      FROM backups
      ORDER BY created_at DESC
    `).all() as Array<{
      id: number;
      filename: string;
      filepath: string;
      size_bytes: number;
      sha256: string;
      schema_version: number;
      created_at: number;
      is_encrypted: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      filename: row.filename,
      filepath: row.filepath,
      size: row.size_bytes,
      sha256: row.sha256,
      schemaVersion: row.schema_version,
      createdAt: row.created_at,
      encrypted: row.is_encrypted === 1,
    }));
  }

  /**
   * 验证备份完整性
   */
  verifyBackup(backupId: number): VerificationResult {
    const row = this.env.db.prepare(`
      SELECT filename, filepath, sha256, schema_version
      FROM backups
      WHERE id = ?
    `).get(backupId) as { filename: string; filepath: string; sha256: string; schema_version: number } | undefined;

    if (!row) {
      return {
        valid: false,
        filename: "",
        expectedSha256: "",
        schemaVersion: 0,
        error: "Backup not found",
      };
    }

    if (!existsSync(row.filepath)) {
      return {
        valid: false,
        filename: row.filename,
        expectedSha256: row.sha256,
        schemaVersion: row.schema_version,
        error: "Backup file does not exist",
      };
    }

    // 优先读旁文件；只有旧备份（升级前创建）才回退到数据库里的值
    const sidecar = readChecksum(row.filepath);
    const checksumSource: "sidecar" | "db" = sidecar ? "sidecar" : "db";
    const expectedSha256 = sidecar ?? row.sha256;
    const actualSha256 = calculateSHA256(row.filepath);
    const valid = hashesEqual(actualSha256, expectedSha256);

    return {
      valid,
      filename: row.filename,
      expectedSha256,
      actualSha256,
      schemaVersion: row.schema_version,
      checksumSource,
      error: valid ? undefined : "Integrity verification failed: SHA256 mismatch - backup file may be corrupted",
    };
  }

  /**
   * 删除备份
   */
  deleteBackup(backupId: number): boolean {
    const row = this.env.db.prepare(`
      SELECT filepath FROM backups WHERE id = ?
    `).get(backupId) as { filepath: string } | undefined;

    if (!row) {
      return false;
    }

    // 删除文件（连同校验和旁文件）
    if (existsSync(row.filepath)) {
      unlinkSync(row.filepath);
    }
    const sidecar = checksumPath(row.filepath);
    if (existsSync(sidecar)) {
      unlinkSync(sidecar);
    }

    // 从数据库删除记录
    this.env.db.prepare(`DELETE FROM backups WHERE id = ?`).run(backupId);

    return true;
  }

  /**
   * 准备恢复备份（解密如果需要）
   * 返回临时文件路径，调用者负责清理
   */
  prepareRestore(backupId: number, decryptionKey?: string): { tempPath: string; schemaVersion: number } {
    const row = this.env.db.prepare(`
      SELECT filepath, schema_version, is_encrypted
      FROM backups
      WHERE id = ?
    `).get(backupId) as { filepath: string; schema_version: number; is_encrypted: number } | undefined;

    if (!row) {
      throw new Error("Backup not found");
    }

    if (!existsSync(row.filepath)) {
      throw new Error("Backup file does not exist");
    }

    const isEncrypted = row.is_encrypted === 1;

    if (isEncrypted && !decryptionKey) {
      throw new Error("Decryption key required for encrypted backup");
    }

    // 如果加密，先解密到临时文件
    if (isEncrypted && decryptionKey) {
      const tempPath = row.filepath + ".tmp";
      decryptFile(row.filepath, tempPath, decryptionKey);
      return { tempPath, schemaVersion: row.schema_version };
    }

    // 未加密，直接返回路径
    return { tempPath: row.filepath, schemaVersion: row.schema_version };
  }

  /**
   * 清理临时解密文件
   */
  cleanupTempFile(tempPath: string): void {
    if (tempPath.endsWith(".tmp") && existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }

  /**
   * 清理旧备份，保留最近 N 个
   */
  cleanupOldBackups(maxBackups: number): number {
    const allBackups = this.listBackups();
    
    if (allBackups.length <= maxBackups) {
      return 0;
    }

    const toDelete = allBackups.slice(maxBackups);
    let deleted = 0;

    for (const backup of toDelete) {
      if (this.deleteBackup(backup.id)) {
        deleted++;
      }
    }

    return deleted;
  }
}

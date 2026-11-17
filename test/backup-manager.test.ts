/**
 * 备份管理器单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { openWeaveDb } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { SCHEMA_VERSION } from "../src/store/schema";
import { BackupManager, encryptFile, decryptFile } from "../src/backup/manager";
import type { WeaveEnv } from "../src/store/db";

describe("Backup Manager", () => {
  const testDir = join(process.cwd(), "test-data", "backup-test");
  let env: WeaveEnv;
  let manager: BackupManager;

  beforeEach(() => {
    // 清理并创建测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "backups"), { recursive: true });

    // 创建数据库
    env = openWeaveDb(testDir, { readonly: false });
    ensureSchema(env);

    // 创建备份管理器
    manager = new BackupManager(env, SCHEMA_VERSION);

    // 插入测试数据
    env.db.exec(`
      INSERT INTO fact (id, content, importance, status, created_at, updated_at)
      VALUES ('test_1', 'Test memory 1', 5, 'active', ${Date.now()}, ${Date.now()});
    `);
  });

  afterEach(() => {
    env.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Backup Creation", () => {
    it("应该创建基本备份", () => {
      const result = manager.createBackup({ label: "test-backup" });

      expect(result).toBeDefined();
      expect(result.id).toBeGreaterThan(0);
      expect(result.filename).toContain("test-backup");
      expect(result.sha256).toHaveLength(64); // SHA256 是 64 个十六进制字符
      expect(result.size).toBeGreaterThan(0);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result.encrypted).toBe(false);
      expect(existsSync(result.filepath)).toBe(true);
    });

    it("应该在备份表中记录元数据", () => {
      const result = manager.createBackup({ label: "metadata-test" });

      const row = env.db.prepare(`
        SELECT * FROM backups WHERE id = ?
      `).get(result.id) as any;

      expect(row).toBeDefined();
      expect(row.filename).toBe(result.filename);
      expect(row.sha256).toBe(result.sha256);
      expect(row.schema_version).toBe(SCHEMA_VERSION);
      expect(row.is_encrypted).toBe(0);
      expect(row.label).toBe("metadata-test");
    });

    it("应该创建加密备份", () => {
      const result = manager.createBackup({
        label: "encrypted",
        encrypt: true,
        encryptionKey: "test-secret-key-12345",
      });

      expect(result.encrypted).toBe(true);
      expect(result.filename).toContain(".enc");
      expect(existsSync(result.filepath)).toBe(true);
    });

    it("加密时未提供密钥应该抛出错误", () => {
      expect(() => {
        manager.createBackup({ encrypt: true });
      }).toThrow("Encryption key required");
    });
  });

  describe("Backup Listing", () => {
    it("应该列出所有备份", () => {
      manager.createBackup({ label: "backup1" });
      manager.createBackup({ label: "backup2" });
      manager.createBackup({ label: "backup3" });

      const backups = manager.listBackups();

      expect(backups).toHaveLength(3);
      expect(backups[0].createdAt).toBeGreaterThanOrEqual(backups[1].createdAt); // 按创建时间降序
    });

    it("空数据库应该返回空列表", () => {
      const backups = manager.listBackups();
      expect(backups).toHaveLength(0);
    });
  });

  describe("Backup Verification", () => {
    it("应该验证有效备份", () => {
      const backup = manager.createBackup({ label: "valid" });
      const verification = manager.verifyBackup(backup.id);

      expect(verification.valid).toBe(true);
      expect(verification.filename).toBe(backup.filename);
      expect(verification.expectedSha256).toBe(backup.sha256);
      expect(verification.actualSha256).toBe(backup.sha256);
      expect(verification.error).toBeUndefined();
    });

    it("应该检测到备份文件损坏", () => {
      const backup = manager.createBackup({ label: "corrupt" });

      // 损坏文件
      writeFileSync(backup.filepath, "corrupted data");

      const verification = manager.verifyBackup(backup.id);

      expect(verification.valid).toBe(false);
      expect(verification.error).toContain("SHA256 mismatch");
      expect(verification.actualSha256).not.toBe(verification.expectedSha256);
    });

    it("应该检测到备份文件丢失", () => {
      const backup = manager.createBackup({ label: "missing" });

      // 删除文件
      rmSync(backup.filepath);

      const verification = manager.verifyBackup(backup.id);

      expect(verification.valid).toBe(false);
      expect(verification.error).toContain("does not exist");
    });

    it("不存在的备份ID应该返回错误", () => {
      const verification = manager.verifyBackup(99999);

      expect(verification.valid).toBe(false);
      expect(verification.error).toContain("not found");
    });
  });

  describe("Backup Deletion", () => {
    it("应该删除备份文件和记录", () => {
      const backup = manager.createBackup({ label: "to-delete" });
      const filepath = backup.filepath;

      expect(existsSync(filepath)).toBe(true);

      const deleted = manager.deleteBackup(backup.id);

      expect(deleted).toBe(true);
      expect(existsSync(filepath)).toBe(false);

      const row = env.db.prepare("SELECT * FROM backups WHERE id = ?").get(backup.id);
      expect(row).toBeUndefined();
    });

    it("删除不存在的备份应该返回false", () => {
      const deleted = manager.deleteBackup(99999);
      expect(deleted).toBe(false);
    });
  });

  describe("Backup Cleanup", () => {
    it("应该清理旧备份保留最新N个", () => {
      // 创建5个备份
      for (let i = 1; i <= 5; i++) {
        manager.createBackup({ label: `backup${i}` });
      }

      const before = manager.listBackups();
      expect(before).toHaveLength(5);

      // 保留最新3个
      const deleted = manager.cleanupOldBackups(3);

      expect(deleted).toBe(2);

      const after = manager.listBackups();
      expect(after).toHaveLength(3);
    });

    it("备份数量少于限制时不应该删除", () => {
      manager.createBackup({ label: "backup1" });
      manager.createBackup({ label: "backup2" });

      const deleted = manager.cleanupOldBackups(5);

      expect(deleted).toBe(0);
      expect(manager.listBackups()).toHaveLength(2);
    });
  });

  describe("Backup Restore Preparation", () => {
    it("应该准备未加密备份恢复", () => {
      const backup = manager.createBackup({ label: "restore-test" });

      const { tempPath, schemaVersion } = manager.prepareRestore(backup.id);

      expect(tempPath).toBe(backup.filepath);
      expect(schemaVersion).toBe(SCHEMA_VERSION);
    });

    it("应该解密加密备份用于恢复", () => {
      const encryptionKey = "test-key-for-restore";
      const backup = manager.createBackup({
        label: "encrypted-restore",
        encrypt: true,
        encryptionKey,
      });

      const { tempPath, schemaVersion } = manager.prepareRestore(backup.id, encryptionKey);

      expect(tempPath).toContain(".tmp");
      expect(existsSync(tempPath)).toBe(true);
      expect(schemaVersion).toBe(SCHEMA_VERSION);

      // 清理临时文件
      manager.cleanupTempFile(tempPath);
      expect(existsSync(tempPath)).toBe(false);
    });

    it("加密备份未提供密钥应该抛出错误", () => {
      const backup = manager.createBackup({
        label: "encrypted-no-key",
        encrypt: true,
        encryptionKey: "secret",
      });

      expect(() => {
        manager.prepareRestore(backup.id);
      }).toThrow("Decryption key required");
    });

    it("不存在的备份ID应该抛出错误", () => {
      expect(() => {
        manager.prepareRestore(99999);
      }).toThrow("Backup not found");
    });
  });

  describe("Integrity Verification", () => {
    it("SHA256校验应该检测到任何文件修改", () => {
      const backup = manager.createBackup({ label: "integrity-test" });

      // 验证原始文件
      const before = manager.verifyBackup(backup.id);
      expect(before.valid).toBe(true);

      // 修改一个字节
      const data = readFileSync(backup.filepath);
      const modified = Buffer.from(data);
      modified[0] = modified[0] ^ 0xFF; // 翻转第一个字节
      writeFileSync(backup.filepath, modified);

      // 再次验证
      const after = manager.verifyBackup(backup.id);
      expect(after.valid).toBe(false);
      expect(after.error).toContain("SHA256 mismatch");
    });
  });

  describe("加密升级（GCM + scrypt + 旁文件校验）", () => {
    const KEY = "v130-backup-key";
    /** MWBK(4) + version(1) + kdf(1) + N/r/p(12) + salt(16) + iv(12) + tag(16) */
    const HEADER_LENGTH = 62;

    function sha256Of(filepath: string): string {
      return createHash("sha256").update(readFileSync(filepath)).digest("hex");
    }

    function insertRow(filepath: string, filename: string, payload: Buffer): number {
      const result = env.db
        .prepare(`
          INSERT INTO backups (filename, filepath, size_bytes, sha256, schema_version, created_at, is_encrypted, label)
          VALUES (?, ?, ?, ?, ?, ?, 1, 'legacy')
        `)
        .run(filename, filepath, payload.length, sha256Of(filepath), SCHEMA_VERSION, Date.now());
      return Number(result.lastInsertRowid);
    }

    it("新加密文件带 GCM 头；同一明文两次加密结果不同（随机 salt + IV）", () => {
      const a = manager.createBackup({ label: "gcm-a", encrypt: true, encryptionKey: KEY });
      const b = manager.createBackup({ label: "gcm-b", encrypt: true, encryptionKey: KEY });

      const dataA = readFileSync(a.filepath);
      const dataB = readFileSync(b.filepath);

      expect(dataA.subarray(0, 4).toString("ascii")).toBe("MWBK");
      expect(dataA.readUInt8(4)).toBe(2); // FORMAT_VERSION
      expect(dataA.readUInt8(5)).toBe(1); // KDF_SCRYPT
      expect(dataA.length).toBeGreaterThan(HEADER_LENGTH);

      expect(dataA.subarray(0, HEADER_LENGTH).equals(dataB.subarray(0, HEADER_LENGTH))).toBe(false);
      expect(dataA.equals(dataB)).toBe(false);
    });

    it("加密往返：解密结果与原始字节逐字节一致", () => {
      const source = join(testDir, "backups", "roundtrip.src");
      const encrypted = join(testDir, "backups", "roundtrip.src.enc");
      const output = join(testDir, "backups", "roundtrip.src.out");
      const plaintext = randomBytes(4096);
      writeFileSync(source, plaintext);

      encryptFile(source, encrypted, KEY);
      decryptFile(encrypted, output, KEY);

      expect(readFileSync(output).equals(plaintext)).toBe(true);
      expect(readFileSync(encrypted).length).toBe(plaintext.length + HEADER_LENGTH);
    });

    it("数据库加密备份可以恢复到有效 SQLite 文件", () => {
      const enc = manager.createBackup({ label: "enc-restore", encrypt: true, encryptionKey: KEY });
      const { tempPath } = manager.prepareRestore(enc.id, KEY);

      const restored = readFileSync(tempPath);
      expect(restored.subarray(0, 15).toString("ascii")).toBe("SQLite format 3");
      expect(restored.length).toBeGreaterThan(0);
      manager.cleanupTempFile(tempPath);
      expect(existsSync(tempPath)).toBe(false);
    });

    it("篡改密文最后一个字节：GCM 认证失败，且不留下临时文件", () => {
      const enc = manager.createBackup({ label: "tamper-body", encrypt: true, encryptionKey: KEY });
      const data = readFileSync(enc.filepath);
      const bad = Buffer.from(data);
      bad[bad.length - 1] ^= 0xff;
      writeFileSync(enc.filepath, bad);

      expect(() => manager.prepareRestore(enc.id, KEY)).toThrow(/authentication failed/i);
      expect(existsSync(enc.filepath + ".tmp")).toBe(false);
    });

    it("篡改认证标签（头部 tag 区）：同样认证失败", () => {
      const enc = manager.createBackup({ label: "tamper-tag", encrypt: true, encryptionKey: KEY });
      const data = readFileSync(enc.filepath);
      const bad = Buffer.from(data);
      bad[HEADER_LENGTH - 1] ^= 0xff; // tag 的最后一个字节
      writeFileSync(enc.filepath, bad);

      expect(() => manager.prepareRestore(enc.id, KEY)).toThrow(/authentication failed/i);
    });

    it("错误密钥：GCM 认证失败而不是静默解出垃圾", () => {
      const enc = manager.createBackup({ label: "wrong-key", encrypt: true, encryptionKey: KEY });
      expect(() => manager.prepareRestore(enc.id, "definitely-not-the-key")).toThrow(/authentication failed/i);
    });

    it("旧 CBC 格式仍可解密（sha256 单次派生 + IV 前置）", () => {
      const plain = manager.createBackup({ label: "legacy-src" });
      const plaintext = readFileSync(plain.filepath);

      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(KEY).digest(), iv);
      const payload = Buffer.concat([iv, cipher.update(plaintext), cipher.final()]);

      const legacyPath = join(testDir, "backups", "legacy.db.enc");
      writeFileSync(legacyPath, payload);
      writeFileSync(legacyPath + ".sha256", sha256Of(legacyPath) + "\n");
      const id = insertRow(legacyPath, "legacy.db.enc", payload);

      const { tempPath } = manager.prepareRestore(id, KEY);
      expect(readFileSync(tempPath).equals(plaintext)).toBe(true);
      manager.cleanupTempFile(tempPath);
    });

    it("校验和写在旁文件，verify 优先用旁文件", () => {
      const backup = manager.createBackup({ label: "sidecar" });
      const sidecar = backup.filepath + ".sha256";

      expect(existsSync(sidecar)).toBe(true);
      expect(readFileSync(sidecar, "utf8").trim()).toBe(backup.sha256);

      const verification = manager.verifyBackup(backup.id);
      expect(verification.valid).toBe(true);
      expect(verification.checksumSource).toBe("sidecar");
    });

    it("旁文件缺失时回退数据库；文件被改仍然判损坏", () => {
      const backup = manager.createBackup({ label: "fallback" });
      rmSync(backup.filepath + ".sha256");

      expect(manager.verifyBackup(backup.id).checksumSource).toBe("db");

      writeFileSync(backup.filepath, "not a database");
      const verification = manager.verifyBackup(backup.id);
      expect(verification.valid).toBe(false);
      expect(verification.error).toContain("SHA256 mismatch");
    });

    it("只改旁文件也会被判无效（校验值不再由数据库单点决定）", () => {
      const backup = manager.createBackup({ label: "sidecar-tamper" });
      writeFileSync(backup.filepath + ".sha256", "0".repeat(64) + "\n");

      const verification = manager.verifyBackup(backup.id);
      expect(verification.valid).toBe(false);
      expect(verification.checksumSource).toBe("sidecar");
      expect(verification.expectedSha256).toBe("0".repeat(64));
    });

    it("删除备份时连同旁文件一起删除", () => {
      const backup = manager.createBackup({ label: "delete-sidecar" });
      const sidecar = backup.filepath + ".sha256";
      expect(existsSync(sidecar)).toBe(true);

      expect(manager.deleteBackup(backup.id)).toBe(true);
      expect(existsSync(sidecar)).toBe(false);
      expect(existsSync(backup.filepath)).toBe(false);
    });
  });

  describe("Schema Version Tracking", () => {
    it("应该记录正确的schema版本", () => {
      const backup = manager.createBackup({ label: "schema-v13" });

      expect(backup.schemaVersion).toBe(SCHEMA_VERSION);

      const row = env.db.prepare("SELECT schema_version FROM backups WHERE id = ?").get(backup.id) as any;
      expect(row.schema_version).toBe(SCHEMA_VERSION);
    });
  });
});

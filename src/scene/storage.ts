/**
 * 忆织 MemWeave —— 场景块存储层
 * 将场景块持久化到 <dataDir>/scenes/ 目录。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SceneBlock } from "./types";

export class SceneStorage {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private scenesDir(): string {
    return join(this.dataDir, "scenes");
  }

  private ensureDir(): void {
    const dir = this.scenesDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private sceneFile(sceneId: string): string {
    return join(this.scenesDir(), `${sceneId}.json`);
  }

  /**
   * 写入场景块
   */
  writeScene(scene: SceneBlock): void {
    this.ensureDir();
    const file = this.sceneFile(scene.id);
    writeFileSync(file, JSON.stringify(scene, null, 2), "utf8");
  }

  /**
   * 读取场景块
   */
  readScene(sceneId: string): SceneBlock | null {
    const file = this.sceneFile(sceneId);
    if (!existsSync(file)) return null;

    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return raw as SceneBlock;
    } catch {
      return null;
    }
  }

  /**
   * 读取所有场景块
   */
  readAllScenes(): SceneBlock[] {
    const dir = this.scenesDir();
    if (!existsSync(dir)) return [];

    const scenes: SceneBlock[] = [];
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
        scenes.push(raw as SceneBlock);
      } catch {
        // Skip corrupted files
      }
    }

    return scenes;
  }

  /**
   * 删除场景块
   */
  deleteScene(sceneId: string): boolean {
    const file = this.sceneFile(sceneId);
    if (!existsSync(file)) return false;

    try {
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 批量写入场景块
   */
  writeScenes(scenes: SceneBlock[]): void {
    this.ensureDir();
    for (const scene of scenes) {
      this.writeScene(scene);
    }
  }

  /**
   * 场景块总数
   */
  count(): number {
    const dir = this.scenesDir();
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  }

  /**
   * 检查场景块是否存在
   */
  exists(sceneId: string): boolean {
    return existsSync(this.sceneFile(sceneId));
  }
}

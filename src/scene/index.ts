/**
 * 忆织 MemWeave —— L2 场景块
 * 将一组 L1 entries 归纳成项目/生活场景。
 */

export { SceneManager } from "./manager";
export { SceneStorage } from "./storage";
export { SceneAggregator } from "./aggregator";

export type {
  SceneBlock,
  SceneType,
  SceneStatus,
  SceneAggregationConfig,
  SceneAggregationResult,
  SceneCandidate,
  SceneHit,
} from "./types";

export { DEFAULT_SCENE_CONFIG } from "./types";

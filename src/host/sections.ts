/**
 * 忆织 MemWeave —— S1 段文本生成与段位注册（规划文档 §6.2 / §3-I8）
 * 首选 deployment:persona-prefix / deployment:persona-suffix；
 * 占用失败降级 memweave:* 自有名；注册失败只告警不抛。
 */

import { renderS1 } from "../core/render";
import type { BudgetConfig, PersonaConfig } from "../core/types";

export interface SectionSpec {
  name: string;
  order: number;
  text: string;
  /** 占用失败时的降级名 */
  fallbackName?: string;
  /** 降级段位 order */
  fallbackOrder?: number;
}

export interface SectionHost {
  section(spec: { name: string; order: number; text: string }): unknown;
  getSectionOrder?(key: string): number | undefined;
}

export function buildSections(
  persona: PersonaConfig,
  modelHint?: string,
  budget?: BudgetConfig,
): SectionSpec[] {
  const s1 = renderS1(persona, modelHint, budget);
  return [
    {
      name: "deployment:persona-prefix",
      order: 0,
      text: s1.prefix,
      fallbackName: "memweave:persona",
      fallbackOrder: 1,
    },
    {
      name: "memweave:thinking-language",
      order: 20,
      text: s1.thinking,
      fallbackName: "memweave:thinking-language",
      fallbackOrder: 21,
    },
    {
      name: "deployment:persona-suffix",
      order: 10200,
      text: s1.suffix,
      fallbackName: "memweave:persona-suffix",
      fallbackOrder: 10201,
    },
  ];
}

/** order 优先问宿主 getSectionOrder()，查不到回落常量（§6.2） */
function resolveOrder(svc: SectionHost, key: string, fallback: number): number {
  try {
    const o = svc.getSectionOrder?.(key);
    if (typeof o === "number" && Number.isFinite(o)) return o;
  } catch {
    // 忽略：回落常量
  }
  return fallback;
}

export interface RegisteredSection {
  name: string;
  order: number;
  dispose: () => void;
}

export function registerSections(
  svc: SectionHost,
  specs: SectionSpec[],
  warn: (msg: string) => void,
): RegisteredSection[] {
  const out: RegisteredSection[] = [];
  const orderKeys = ["PERSONA_PREFIX", "THINKING_LANGUAGE", "PERSONA_SUFFIX"];
  specs.forEach((spec, i) => {
    const fallbackOrder = spec.fallbackOrder ?? spec.order + 1;
    const tries: Array<{ name: string; order: number }> = [
      { name: spec.name, order: resolveOrder(svc, orderKeys[i] ?? "", spec.order) },
    ];
    if (spec.fallbackName && spec.fallbackName !== spec.name) {
      tries.push({
        name: spec.fallbackName,
        order: resolveOrder(svc, orderKeys[i] ?? "", fallbackOrder),
      });
    }
    for (const t of tries) {
      try {
        const dispose = svc.section({ name: t.name, order: t.order, text: spec.text }) as unknown;
        out.push({
          name: t.name,
          order: t.order,
          dispose: typeof dispose === "function" ? (dispose as () => void) : () => undefined,
        });
        return;
      } catch {
        // 段名被占用 / 注册失败：吞异常，尝试降级名（I8）
      }
    }
    warn("section registration failed: " + spec.name);
  });
  return out;
}

/** systemPrompt 服务未就绪时轮询等待（§6.6：meow-memory 等 20s） */
export async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 20000,
  stepMs = 250,
): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    let value: T | undefined;
    try {
      value = probe();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() - start >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

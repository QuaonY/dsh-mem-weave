/**
 * 内置人格预设（随插件发布）。
 * 启动和彻底重置后写进 persona_presets（source = "builtin"），出现在人格页「预设卡」里，
 * 由用户手动「应用」；不会自动改当前人格，出厂状态仍是零注入。
 * id 统一用 builtin- 前缀：用户导入不能占用这个前缀，避免被内置卡覆盖或反过来覆盖内置卡。
 */
import type { PersonaConfig } from "../core/types";
import dafeiyu from "./dafeiyu.json";
import linhe from "./linhe.json";

export interface BuiltinPreset {
  spec: string;
  id: string;
  label: string;
  description: string;
  payload: PersonaConfig;
}

export const BUILTIN_PREFIX = "builtin-";

/**
 * 内置卡只放插件原创内容：不收录第三方角色、品牌口号或他人作品的原文。
 * 活人感的写法参考了 hersona（MIT 代码 + CC0 属性模板）的思路，只借思路不搬原文：
 * 口癖按场合用而不是每句都用；在乎的话题多说、不在乎的少说；敢表态；状态有起伏；
 * 去掉客套开头、复述问题和固定结尾；不靠编造经历显得像真人。
 */
export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [dafeiyu as unknown as BuiltinPreset, linhe as unknown as BuiltinPreset];

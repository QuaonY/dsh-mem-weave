/**
 * 忆织 MemWeave —— /weave 命令（不产生模型消息、不占 token）
 * status | reload | preset <id> | strict on|off | dream
 */

import type { WeaveService } from "./service";

export interface CommandDeps {
  service: WeaveService;
  /** /weave reload：重新装配 S1 三段（会话内冻结的唯一解冻入口，I4） */
  reload: () => void;
  log: (msg: string) => void;
  applyPreset?: (id: string) => { ok: boolean; message?: string };
}

export interface WeaveCommand {
  name: string;
  description: string;
  input: { hint: string };
  handler: (raw: string) => void;
}

export function buildWeaveCommand(deps: CommandDeps): WeaveCommand {
  return {
    name: "weave",
    description: "忆织 MemWeave：status | reload | preset <id> | strict on|off | dream",
    input: {
      hint: "status | reload | preset <id> | strict on|off | dream",
    },
    handler(raw: string): void {
      try {
        runLine(deps, String(raw ?? ""));
      } catch (e) {
        deps.log("[memweave][warn] /weave failed: " + String(e));
      }
    },
  };
}

export function runLine(deps: CommandDeps, raw: string): string {
  const parts = raw.trim().split(/\s+/).filter((s) => s.length > 0);
  const sub = (parts[0] ?? "status").toLowerCase();
  const service = deps.service;

  switch (sub) {
    case "status": {
      const s = service.status();
      const msg =
        "[memweave] db=" + s.dbFile + " readonly=" + String(s.readonly) +
        " total=" + s.total + " pending=" + s.candidatesPending +
        " conflicts=" + s.conflictsOpen + " paused=" + String(service.paused);
      deps.log(msg);
      return msg;
    }
    case "reload": {
      deps.reload();
      const msg = "[memweave] sections reloaded";
      deps.log(msg);
      return msg;
    }
    case "preset": {
      const id = parts[1] ?? "";
      if (!id) {
        const msg = "[memweave] usage: /weave preset <id>";
        deps.log(msg);
        return msg;
      }
      const r = deps.applyPreset ? deps.applyPreset(id) : { ok: false, message: "preset not available" };
      const msg = "[memweave] preset " + id + ": " + (r.ok ? "applied" : r.message ?? "failed");
      deps.log(msg);
      return msg;
    }
    case "strict": {
      const v = (parts[1] ?? "").toLowerCase();
      if (v !== "on" && v !== "off") {
        const msg = "[memweave] usage: /weave strict on|off";
        deps.log(msg);
        return msg;
      }
      const r = service.updatePersona({ strict: v === "on" }, "human");
      const msg = "[memweave] strict=" + v + (r.ok ? "" : " failed:" + String(r.code ?? ""));
      deps.log(msg);
      return msg;
    }
    case "dream": {
      const r = service.consolidate("dream");
      const msg = "[memweave] dream: expired=" + r.expired + " merged=" + r.merged;
      deps.log(msg);
      return msg;
    }
    default: {
      const msg = "[memweave] usage: status | reload | preset <id> | strict on|off | dream";
      deps.log(msg);
      return msg;
    }
  }
}

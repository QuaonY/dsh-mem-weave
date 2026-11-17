import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { invokeRpc } from "./rpc";
import type { WeaveService } from "./service";

export const REMOTE_PACKAGE = "dsh-mem-weave";
export const REMOTE_SERVICE = "memweaveRemoteService";
export const REMOTE_NAMESPACE = "memweave";

export class WeaveRemoteService extends TypertRemoteService {
  static inject = ["typert"];
  private readonly weave: WeaveService;

  constructor(ctx: object, weave: WeaveService) {
    super(ctx, REMOTE_SERVICE, { namespace: REMOTE_NAMESPACE });
    this.weave = weave;
  }

  invoke(id: string, args: Record<string, unknown>, actor: string): Promise<unknown> {
    return invokeRpc(this.weave, id, args, actor);
  }
}

Object.defineProperty(WeaveRemoteService.prototype, "@deepseek-ai/dsh-typert-protocol/remote-methods", {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([{ method: "invoke", invocation: Object.freeze({ kind: "direct" }) }]),
  }),
});

/**
 * 忆织 Typert Remote 描述符（客户端 $mount 用）。
 *
 * 网关 $mount 要求每个参数都是 strict 编解码器：src-json 会让 $mount 直接抛错，
 * remote.memweave 命名空间因此永远不会出现。schema 形状与 dsh-plugin-weixin 一致。
 * service / namespace / method 必须与 src/host/remote-service.ts 保持一致。
 */

const PKG = "dsh-mem-weave";
const schemaString = () => ({ type: "intersection", left: { type: "string" }, right: { type: "unknown" } });
const schemaUnknown = () => ({ type: "intersection", left: { type: "unknown" }, right: { type: "unknown" } });

export const REMOTE_CONTRIBUTION = {
  package: PKG,
  descriptors: [
    {
      id: `${PKG}#memweave/invoke`,
      service: "memweaveRemoteService",
      namespace: "memweave",
      method: "invoke",
      invocation: { kind: "direct" },
      parameters: [
        { name: "id", wire: "id", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#memweave/invoke:p0`, create: schemaString } },
        { name: "args", wire: "args", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#memweave/invoke:p1`, create: schemaUnknown } },
        { name: "actor", wire: "actor", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#memweave/invoke:p2`, create: schemaString } },
      ],
      result: { mode: "strict", typeSymbol: `${PKG}#memweave/invoke:result`, create: schemaUnknown },
    },
  ],
};

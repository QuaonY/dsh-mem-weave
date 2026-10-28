/**
 * 客户端 Remote 描述符必须通过 DSH 网关 $mount 的校验：
 * dsh-api-gateway client requireStrictInputs 要求每个参数都是 strict 编解码器，
 * typert-registry validateCodec 要求 strict 编解码器带非空 typeSymbol 与 create()。
 * 不满足时 $mount 直接抛错，remote.memweave 命名空间不会出现。
 */
import { describe, expect, it } from "vitest";
import { REMOTE_CONTRIBUTION } from "../src/client/remote";

type Codec = { mode: string; typeSymbol?: string; create?: () => unknown };

describe("Remote contribution", () => {
  const descriptor = REMOTE_CONTRIBUTION.descriptors[0];

  it("与宿主 Remote 服务契约一致", () => {
    expect(REMOTE_CONTRIBUTION.package).toBe("dsh-mem-weave");
    expect(descriptor.service).toBe("memweaveRemoteService");
    expect(descriptor.namespace).toBe("memweave");
    expect(descriptor.method).toBe("invoke");
    expect(descriptor.parameters.map((p) => p.wire)).toEqual(["id", "args", "actor"]);
  });

  it("所有参数与结果都使用带 typeSymbol 和 create() 的 strict 编解码器", () => {
    const codecs: Codec[] = [...descriptor.parameters.map((p) => p.codec as Codec), descriptor.result as Codec];
    for (const codec of codecs) {
      expect(codec.mode).toBe("strict");
      expect(codec.typeSymbol?.length).toBeGreaterThan(0);
      expect(typeof codec.create).toBe("function");
      expect(codec.create!()).toMatchObject({ type: "intersection" });
    }
  });
});

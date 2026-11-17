/**
 * lib/vendor/ 随包自带依赖的固定版本。升级时改这里，并重新跑全量验证
 * （本地模型推理 + vectra 读写 + npm pack 体积）。
 */
export const VENDOR_PACKAGES = {
  "@huggingface/transformers": "4.3.2",
  vectra: "0.15.0",
};

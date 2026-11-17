# Third-party notices / 第三方声明

本包内置了下列第三方软件，随 npm 包一起分发。

## 本地模型推理与 vectra（`lib/vendor/`）

- 内容：`@huggingface/transformers` 4.3.2（含 `@huggingface/tokenizers`、`@huggingface/jinja`）、
  `onnxruntime-node` / `onnxruntime-common` 1.30.0（win32-x64、win32-arm64、linux-x64、linux-arm64、
  darwin-arm64 的 CPU 推理库，不含 DirectML 等 GPU 文件）、`vectra` 0.15.0 及其运行时依赖
- 来源：npm 上的原版包，按 `scripts/vendor-pins.mjs` 的固定版本安装后裁剪（只删文件，不改内容）；
  `sharp` 是 MemWeave 自己写的空壳，不含 sharp 的任何代码
- 许可证：Apache-2.0、MIT、BSD-2-Clause、BSD-3-Clause、ISC。每个包的许可证原文都保留在它自己的目录里，
  汇总见 `lib/vendor/THIRD_PARTY_LICENSES.txt`，包名、版本与许可证清单见 `lib/vendor/manifest.json`

## sqlite-vec 0.1.9

- 项目：<https://github.com/asg017/sqlite-vec>
- 文件：`lib/native/<platform>-<arch>/vec0.{dll,so,dylib}`
  （源码目录 `vendor/sqlite-vec/`）
- 来源：npm 包 `sqlite-vec-<platform>-<arch>@0.1.9`，原样拷贝、未修改
- 许可证：**MIT OR Apache-2.0**，版权归 Alex Garcia
- 本项目按 MIT 条款使用，全文如下：

```
MIT License

Copyright (c) 2024 Alex Garcia

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

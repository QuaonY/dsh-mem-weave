# 内置 sqlite-vec 二进制

`sqlite-vec` 0.1.9（<https://github.com/asg017/sqlite-vec>）的官方预编译扩展，
按 `process.platform-process.arch` 分目录存放。构建时 `scripts/build.mjs` 会把它整体拷到
`lib/native/`，运行时 `src/store/vector.ts` 用 `DatabaseSync.loadExtension()` 直接加载。

| 目录 | 文件 | 大小 |
| --- | --- | --- |
| `win32-x64` | `vec0.dll` | 289,280 B |
| `linux-x64` | `vec0.so` | 159,816 B |
| `linux-arm64` | `vec0.so` | 156,520 B |
| `darwin-x64` | `vec0.dylib` | 127,632 B |
| `darwin-arm64` | `vec0.dylib` | 161,896 B |

来源：npm 包 `sqlite-vec-<platform>-<arch>@0.1.9`（`npm pack` 解包后原样拷贝，未修改）。
许可证：MIT OR Apache-2.0，版权归 Alex Garcia；见仓库根目录 `THIRD_PARTY_NOTICES.md`。

升级方式：

```bash
npm pack sqlite-vec-windows-x64@<new> --pack-destination /tmp
tar -xzf /tmp/sqlite-vec-windows-x64-<new>.tgz -C /tmp
# 把 package/vec0.dll 覆盖到 vendor/sqlite-vec/win32-x64/
```

只在 `MEMWEAVE_VECTOR_BACKEND=off` 之外、且宿主 SQLite 支持扩展加载时才会用到；
加载失败会自动退回 `builtin`（SQLite BLOB + JS 余弦），不影响召回可用性。

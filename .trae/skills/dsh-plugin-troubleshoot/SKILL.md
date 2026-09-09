---
name: "dsh-plugin-troubleshoot"
description: "排查 DSH（DeepSeek Harness）本地插件装了不生效/启动报错/工具不出现/内置功能 404 的问题。当 dsh plugin、cordis.patch.yml、插件 fiber 挂载、ctx.tools.register、Connection RPC 频道（/api 404）、client bundle 相关故障出现时调用。"
---

# DSH 插件排查手册（本地开发 / Windows）

DSH 插件「装了但没反应」「工具模型说不存在」「启动报错」「工作区/会话 404」时，按下面的顺序排查。每一条都来自真实踩坑，先验证证据再下结论，禁止无日志臆断。

## 0. 先做的三件事

1. **确认实际执行的命令行**：让用户贴 cmd 窗口里 `$ node ... bin.ts` 那一行。
   - `web` 后面必须有 `--patch <patch.yml>`（一次性参数，不持久），或插件已进 profile 的 `dsh.profile.bundles`（`dsh plugin add` 会自动写入，之后无需 `--patch`）。
   - 没带 `--patch` 又没进 bundles = 插件根本没加载。
2. **确认跑的不是旧进程**：tsx 只在启动瞬间加载源码，改代码不重启不生效。重启前先确认端口（默认 3080）上没有旧 node 进程。
3. **确认看的是新会话**：工具清单是建会话时的快照；插件新增工具后，浏览器里必须「新建会话」模型才看得到。

## 1. 安装方式：file: 会冻结源码，开发必须 link:（最高频根因）

- `dsh plugin add file:<路径>` → pnpm 把插件**打包成冻结快照副本**复制进 `<profile>/node_modules/<pkg>`（普通目录，非链接）。之后改源码运行时完全看不到。
- `dsh plugin add link:<绝对路径>` → 创建 Junction（活链接）指向源码目录，改源码重启即生效。

验证当前是不是活链接（PowerShell）：
```powershell
Get-Item "$HOME\.dsh\profiles\web\node_modules\<pkg>" | Select-Object LinkType, Target
# LinkType: Junction  Target: <源码目录>  → 活链接 ✅
# LinkType 为空                                  → 冻结副本 ❌，需 remove 后 link: 重装
```

修复：
```powershell
# 在 dsh monorepo 目录执行（dsh 会把参数转发给 profile 目录里的 pnpm）
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web remove <pkg>
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add "link:<源码绝对路径>"
```

快速判别：改源码后在 `<profile>/node_modules/<pkg>/src/x.ts` 里搜新增内容，搜不到 = 冻结副本。

## 2. /api 频道是网关保留的，插件不能 intercept（内置功能全 404 的根因）

- Connection 的 `/api` 共享频道**全局只允许一个 interceptor**，槽位属于内置 Typert 网关（directoryPicker、session/create、dynamicCordisRunner 等所有内置 API 都走它）。
- 第三方插件若调 `ctx.connection.rpc.intercept('/api', …)`，会抢占唯一槽位（`rpc-host.ts` 里 `interceptors.has(channel)` 直接 throw 或导致网关注册失败），结果：所有非自己 matcher 命中的 `/api/*` 端点返回 **HTTP 404**——表现为「工作区选择弹无法打开文件夹」「新建会话失败」。
- 正确做法：用 `rpc.handle()` 注册**自己的独立频道**（有独立物理路由和认证围栏）：
  ```ts
  // host 侧：注册 /laap 频道（assertChannel 规定频道不能是 /api）
  ctx.connection.rpc.handle('/laap', async (endpoint, payload) => {
    if (endpoint === 'snapshot') return { ok: true, value: ctx.laap.uiSnapshot() }
    return { ok: false, error: { code: 'not-found', message: endpoint, details: {} } }
  })
  // client 侧：rpc.call('/laap', 'snapshot', {})  →  POST /laap/snapshot
  ```
- 端点不能用共享频道上的 Fetch exact route 之外的方式抢 `/api`；流式/浏览器原生响应用 `rpc.fetch.register({ path, methods, fetch })`（path 必须在 `/api/` 之下）。

验证路由归属（未认证探针，401=路由存在且归属正确，404=owner 缺失）：
```powershell
$body = '{"type":"client-request","rpcId":"x","method":"x","payload":{}}'
Invoke-WebRequest -Uri "http://127.0.0.1:3080/api/directoryPicker/pick?token=<token>" -Method POST -Body $body -ContentType 'application/json'
# 401 = 网关重新拥有 /api ✅；404 = 仍被抢占 ❌
```

## 3. fiber 是否真的激活：要证据不要猜

现象层级：
- `--dump-config` 能看到插件 entry ≠ 插件运行了（只证明 patch 组合进配置树）。
- `cordis.yml`（profile 根配置）里搜不到插件是**正常的**——它是被反复重写的空 root 锚点，patch 经 `boot()` 单独传入，别拿它当证据。
- 插件副作用产物（如 zvec mmap 目录 `~/.dsh-laap/`）能证明跑过一次，但要看时间戳是否是本次启动。

可靠探针（info 级日志默认被过滤，用 warn 或文件探针）：
- 文件探针最硬：apply 入口/出口 `appendFileSync` 写一个 trace 文件（写 `<pkg>/boot-trace.log`），重启后看哪些 fiber 落了 ENTER/DONE/THREW。
- warn 探针：`ctx.logger('<name>').warn(...)`（console exporter 默认 warn/error 可见）。
- 工具注册用 `defineTool`（`@deepseek-ai/dsh-tools`），output 必须 `{ schema, render }`，schema 会过 `assertSupportedJsonSchema`，非法直接 throw。
- 排查完务必删除所有探针代码，`tsc --noEmit` 归零。

注意：fiber 注入的服务没 provide 会永远 PENDING（不报错）。确认 `static provide = '<id>'` 与消费方 `inject = ['<id>']` 一致；Service 类插件 provide 在类静态字段，函数插件通过 entry 的 id。

## 4. 浏览器端 UI（client 半区）规则

- **一个包只能有一个激活的 loader 入口**（client-modules 硬约束）。client-modules 对每条 loader 入口沿目录上溯到 package.json 归并所属包；同一个包若被多条 entry 命中（比如 cordis.patch.yml 里列了 service/tools/hooks/… 五个深层 file 入口），会报 `package <name> resolves from multiple active Loader sources: ...; remove one entry`。正解：host 侧写一个 `src/index.ts` 编排器，在单个 `apply(ctx, config)` 里用 `ctx.plugin(service, config)` / `ctx.plugin(tools)` … 把所有子插件挂上（子插件保留各自 `name`/`inject`，cordis 按 inject 自动等依赖）；cordis.patch.yml 只列 index 一个 entry（`name: './src/index.ts'`，id 用包名）。client bundle 由这个包的 `dsh.client` 自动发现，无需单独的入口。
- host 侧插件用 patch 的 file entry 直接挂源码（tsx 加载）；**client 侧不能**——它在浏览器跑，需要预构建 bundle。
- package.json 里若声明 `dsh.client`，必须同时满足：
  - `dsh.client.platform` 必须是字符串 `"web"`；
  - `exports["./client"]` 指向**预构建的 bundle 文件**（`window.__ModuleLoader__.load({id,factory})` factory 形式，参考 monorepo `packages/client/tsdown.client.ts`）；
  - `dsh.client.inject` 声明浏览器端服务（如 `@deepseek-ai/dsh-client-ui-slots`；platform 模块是静态种子，写上是无害空边）。
- **外部插件构建 client bundle（没有 monorepo tsdown 预设）**：用 esbuild 直接产等价 CJS 包裹体：
  - `entryPoints: [src/ui-client.tsx]`，`bundle:true, platform:'browser', format:'cjs', jsx:'automatic', target:'es2020', write:false`；
  - `external: ['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis']`——这些由宿主模块表 PLATFORM_MODULES 经 factory 的 `require` 注入，**绝不能打进 bundle**（react 版本由 shell 决定，devDep 里 react 19 仅供类型）；
  - banner `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {\nvar module={exports:{}};\nvar exports=module.exports;`，footer `return module.exports;\n} });`；产物写 `lib/client.js`。esbuild 在 pnpm 里可能只在 `.pnpm/node_modules/esbuild`（tsx 传递依赖），用 createRequire 兜底。
  - 用 slot 注册 UI：`ctx.slots.inject('<hole>', () => ctx.slots.register({name:'<hole>', id, order}, Component))`；槽位名查 monorepo slot-catalog.ts（如 `sidebar.footer.action` 是 list/root）。
- 只写 `dsh.client.entry`（指向 .tsx 源码）是非法半成品，ClientModuleRegistry 扫描时对每条相关 entry 抛错，聚合成 "N client packages failed to compose"。没准备好 bundle 就**整个删掉 `dsh.client` 字段**，host 半区照常工作。
- `@deepseek-ai/dsh-client-connection/client` 的浏览器 bundle 可能没有导出某些函数（如 `createWebConnectionRpc` 被 rollup 漏掉）。需要时在 client 代码里自实现轻量 RPC：POST `{channel}/{endpoint}`，信封 `{type:'client-request', rpcId, method, payload}`，响应 `{type:'server-response', rpcId, result:{ok,value|error}}`。

## 5. Windows / 沙箱环境注意

- dsh 运行要写 `~/.dsh/profiles/<name>/cordis.yml` 等家目录文件，受限沙箱里会 EPERM——跑 dsh 需在沙箱外执行（`pnpm`/`node` 命令）。
- PowerShell 复合命令（含 `if`/`;`）可能触发沙箱写日志限制；拆成单条命令执行。
- 后台起服务：`node --import tsx/esm apps/cli/src/bin.ts web --no-open`（`--no-open` 避免自动开浏览器），输出重定向到日志文件，等 ~20-25s 再读。

## 6. 常用命令速查

```powershell
# 组合配置（不启动服务，验证 patch 是否进配置树）
node --import tsx/esm apps/cli/src/bin.ts web --dump-config 2>&1 | Select-String <plugin-id>

# 查插件安装列表 / bundles
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web list
Get-Content "$HOME\.dsh\profiles\web\package.json" | Select-String bundles

# 类型检查（在插件目录）
node node_modules/typescript/bin/tsc --noEmit

# 停掉占 3080 的进程
Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | Stop-Process -Id {$_} -Force
```

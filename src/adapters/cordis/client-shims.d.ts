/**
 * react-dom 最小类型 shim（仅浏览器端 ui-client.tsx 使用）。
 *
 * 运行时 react-dom 由 dsh web 外壳的 PLATFORM_MODULES 表注入
 * （见 dsh 框架 packages/client/web/src/seed.ts），build-client.mjs 也把它
 * 列为 external，仓库无需安装 react-dom 依赖；这里只补 createPortal 的
 * 可调用形状，供 tsconfig.web.json 做客户端类型检查。
 *
 * 注意：本文件也会被服务端 tsconfig（按 src 目录 .ts glob 扫描）扫到，因此
 * 不能引用 @types/react 的命名空间（服务端 types 仅含 node），签名保持 any。
 */
declare module 'react-dom' {
  export function createPortal(children: any, container: any, key?: string | null): any
}

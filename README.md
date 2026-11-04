# Harvey 家庭 AI

正式入口：[harveychat.dpdns.org](https://harveychat.dpdns.org/)。

这是面向受邀家人的私人 AI 聊天工作台，基于 NextChat 修改，使用 Vercel 和 Neon PostgreSQL 部署。账号、会话、附件及用量由服务端管理。

## 当前功能

- 单次邀请、注册审批、设备登录管理和持续登录。
- 独立聊天记录、会话搜索、重命名、置顶、归档和 Markdown 导出。
- 文字与推理模型选择，轻度、中等、高强度推理。
- 图片生成、图片/PDF/文本附件、个人文件管理。
- 按住说话、回复朗读和连续实时语音。
- 多主题、移动端布局、输入偏好和草稿保留。
- 个人 Token 与费用统计，管理员汇总及 API 使用顺序管理。
- 多个服务端 API key，明确额度耗尽时依次切换，支持最后保底。

## 开发与部署

运行环境：Node.js 22、Yarn 1、Next.js、PostgreSQL。正式部署使用 Vercel，数据库使用 Neon；Preview 必须使用独立测试数据库。

首次本地配置：

```powershell
corepack yarn install --frozen-lockfile
if (-not (Test-Path .env.local)) { Copy-Item .env.template .env.local }
```

填写 `.env.local` 中的数据库、身份验证和模型配置，再运行：

```text
corepack yarn dev
```

生产构建与离线测试：

```text
corepack yarn build
corepack yarn test:ci --runInBand
```

API key、数据库连接和认证密钥使用本地忽略文件或 Vercel 的 Secret 环境变量。环境变量模板只保留家庭站使用的配置。

部署、初始化、数据库迁移、邀请审批及验收说明见 [家庭站部署说明](docs/family-deployment.md)。交互组件约定见 [二级界面说明](docs/family-secondary-ui.md)。

线上只开放正式入口。历史域名和部署 URL 的退役规则、本地材料归档及隔离 Preview 的维护方式见 [维护说明](docs/family-maintenance.md)。

## 目录

| 目录                                | 用途                               |
| ----------------------------------- | ---------------------------------- |
| `app/family/`                       | 家庭聊天界面、服务端和共享数据契约 |
| `app/api/family/`、`app/api/auth/`  | 已认证的家庭站 API 与登录接口      |
| `public/family-realtime-worklet.js` | 实时语音音频处理                   |
| `scripts/family/`                   | 迁移与验收工具                     |
| `test/`                             | 功能与安全边界回归测试             |
| `docs/`                             | 当前部署和界面维护说明             |

原 NextChat 的部分兼容代码仍在仓库中，生产入口由家庭站独立实现，旧公开代理接口由中间件拒绝访问。

## 开源来源

本项目基于 [NextChat](https://github.com/ChatGPTNextWeb/NextChat)，保留其 [MIT 许可证](LICENSE)及原版权声明。上游基础版本 `2.16.1` 已从原桌面打包配置迁入 `app/config/version.json`，版本信息不再依赖桌面工程。

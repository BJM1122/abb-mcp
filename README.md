# ABB MCP

用于 Windows 的本地 ABB Robot Web Services MCP 服务和 `abbctl` 命令行工具。支持 Claude Code、Codex 和兼容 stdio MCP 的客户端。公开发行版 **1.6.1**，基于原工具 1.6.0，并包含 RWS 分页及备份 HTTP 303 完成状态修复。

**完整功能版：保留原工具的 20 个 MCP 工具、CLI、Node.js 直连读写/备份、legacy PowerShell 后端和可选 PC SDK helper。** 不包含作者的控制器登记、密码、证书指纹、机器人程序、备份、现场数据或原私有仓库历史。示例地址 `192.0.2.x` 仅用于文档，不能直接连接机器人。

## 1. 安装

需要 **Windows、Git、Node.js 20+、PowerShell 7 (`pwsh`)**。Windows 的 .NET Framework C# 编译器用于构建 DPAPI 凭据 helper（通常位于 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`）；特殊路径可设置 `ABB_MCP_CSC`。

在 **PowerShell 7** 中执行，无需管理员权限：

```powershell
git clone https://github.com/BJM1122/abb-mcp.git
cd abb-mcp
pwsh -NoProfile -File .\install.ps1
```

安装器安装锁定依赖、构建凭据 helper、创建**空的本地 registry**，并提示输入你自己的 ABB RWS 账号密码。密码通过 Windows DPAPI 加密保存至 `%USERPROFILE%\.abb-mcp\secrets\controller.clixml`，只适用于创建它的 Windows 账户和电脑。安装器不访问控制器、不改客户端配置，也不覆盖已有 registry 或凭据。

只安装并检查工具、暂不录入账号：

```powershell
pwsh -NoProfile -File .\install.ps1 -SkipCredential
```

以后录入账号，或为不同柜创建不同凭据文件：

```powershell
pwsh -NoProfile -File .\provision-credential.ps1
# 自定义文件名：
pwsh -NoProfile -File .\provision-credential.ps1 -OutputPath "$env:USERPROFILE\.abb-mcp\secrets\another-controller.clixml"
```

已有凭据文件时安装器会拒绝覆盖；更新或重复安装使用 `-SkipCredential`。无需 OpenAI/Anthropic API key 来启动这个 MCP；聊天客户端的登录单独管理。

## 2. 接入 MCP 客户端

安装结束会打印使用本机绝对路径的通用 `mcpServers` JSON。下面以安装到 `C:\ABB_MCP` 为例，**必须换成自己的实际路径**。

### Claude Code

```powershell
claude mcp add --transport stdio --scope user --env ABB_MCP_CHANGESET_BACKEND=direct-rws-preview --env ABB_MCP_ALLOW_LEGACY=0 abb_local -- node "C:\ABB_MCP\server.mjs"
claude mcp list
```

重新打开会话，通过 `/mcp` 查看连接状态。参考 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)。

### Codex

将以下内容合并到你自己的 `%USERPROFILE%\.codex\config.toml`，不要覆盖已有其他配置：

```toml
[mcp_servers.abb_local]
command = "node"
args = ['C:\ABB_MCP\server.mjs']
env = { ABB_MCP_CHANGESET_BACKEND = "direct-rws-preview", ABB_MCP_ALLOW_LEGACY = "0" }
```

若客户端找不到 `node`，将 `command` 换成 `Get-Command node` 返回的绝对路径。参考 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)。重新打开客户端/建立新会话，调用 `abb_health`，确认 `version: 1.6.1`、`restartRequired: false`，以及 `read/backup: direct-rws`、`changeset: direct-rws-preview`。配置列表能显示服务不等于运行连接已经成功。

### DeepSeek

可以通过 **Cline + DeepSeek** 使用全部相同的 ABB MCP 工具：

1. 在 Cline 的 Settings 中选择 DeepSeek provider，填写**自己的** DeepSeek API key 并选择支持工具调用的模型。模型凭据只配置在客户端，不填入 ABB registry，也不提交到本仓库。
2. 打开 Cline 的 MCP Servers → Configure → Configure MCP Servers，将下面的通用 `mcpServers` JSON 合并进去，修改成本机路径；保留 `autoApprove: []`，不要自动批准机器人写入。
3. 确认出现 20 个 `abb_*` 工具，先调用 `abb_health`。完成自己的控制器登记后再读取或准备变更。

也可按 [DeepSeek 官方 Claude Code 接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)在客户端设置 DeepSeek，然后沿用上面的 Claude Code MCP 注册命令。ABB MCP 本身不绑定模型供应商。

这里指通过具备本地 stdio MCP 能力的客户端接入 DeepSeek；没有将 DeepSeek 官网/App 直接连接本地 MCP 的方式列为已验证。未使用真实 DeepSeek API key 执行端到端模型测试。

参考：[Cline DeepSeek 配置](https://docs.cline.bot/provider-config/deepseek)、[Cline MCP 配置](https://docs.cline.bot/mcp/mcp-overview)。

### 通用 stdio MCP 配置（包括 Cline + DeepSeek）

在该客户端要求的位置合并安装器打印的 JSON，或使用：

```json
{
  "mcpServers": {
    "abb_local": {
      "command": "node",
      "args": ["C:\\ABB_MCP\\server.mjs"],
      "env": {
        "ABB_MCP_CHANGESET_BACKEND": "direct-rws-preview",
        "ABB_MCP_ALLOW_LEGACY": "0"
      },
      "autoApprove": []
    }
  }
}
```

这些环境变量明确选择直连后端；源代码为兼容旧用法仍默认 legacy。CLI 使用直连时先在当前 PowerShell 会话设置：

```powershell
$env:ABB_MCP_CHANGESET_BACKEND = 'direct-rws-preview'
$env:ABB_MCP_ALLOW_LEGACY = '0'
node .\abbctl.mjs health
node .\abbctl.mjs controllers
```

初次 `controllers` 返回空列表是正常现象。所有命令可用 `node .\abbctl.mjs --help` 查看。

## 3. 配置自己的机器人

安装器生成的 `controller-registry.json` 已被 Git 忽略。仅编辑此本地文件，**不要将示例文件改成真实配置后提交**。

1. 从自己的控制器/RobotStudio 获取准确 URL、控制器名称、SystemId、RobotWare 版本、RAPID task、I/O network/device。不同柜不得复用身份。
2. 参照 [controller-registry.example.json](controller-registry.example.json)，在本地 `controllers` 对象内添加自己的条目。`credentialFile` 改为上一步创建的文件；`username` 与自己的账号一致。RWS1 显式指定 `rwsProtocol: "rws1"`；RWS2 指定 `"rws2"`，并从该准确端点独立核验真实 TLS 证书 SHA-256 指纹，填写 `certificateSha256`。禁止关闭 TLS 校验。
3. 保留安装器生成的 `rwsHelperPath` 和 `allowedLocalRoots`。默认只允许仓库 `artifacts` 下的备份、模块导出和 staging；需要其他目录时精确增加自己的允许目录，不要开放整块磁盘。
4. 在 MCP 中调用 `abb_list_controllers`，首次选择后调用 `abb_bind_controller`，核对返回的完整身份，再进行只读查询。

新柜也可以先用已有本地凭据条目，通过 `abb_probe_controller(includeResources=true)` 发现实际任务/网络/设备，再用 `abb_register_controller` 登记；不要猜测设备名称。登记本地 registry 不会写机器人。

## 完整功能

| 功能 | MCP 工具 |
| --- | --- |
| 健康、版本、别名、接入、会话 | `abb_health`, `abb_list_controllers`, `abb_probe_controller`, `abb_register_controller`, `abb_bind_controller`, `abb_disconnect` |
| 状态、信号、系统配置 | `abb_controller_snapshot`, `abb_read_signals`, `abb_list_config_instances`, `abb_read_config_instance` |
| RAPID 模块、符号、当前位置只读 | `abb_list_rapid_modules`, `abb_read_rapid_module`, `abb_read_rapid_data`, `abb_read_current_robtarget` |
| 配置/RAPID 批量修改 | `abb_plan_changeset`, `abb_apply_changeset`, `abb_verify_changeset` |
| 控制柜完整备份、下载、验证 | `abb_plan_backup`, `abb_apply_backup`, `abb_verify_backup` |

模块读取支持按例程/行号摘录及保存；配置列表支持字段筛选和数量限制。配置、PROFINET、信号、RAPID 模块更新/移除、build 和可选 restart 使用 [changeset.schema.json](changeset.schema.json)，示例见 [examples](examples/)。CLI `batch` 可复用同一传输和 RWS 会话。

工具接口一致不代表所有柜都支持同一操作：RWS 版本、控制器选项、账号权限和现场状态仍决定可用能力。RWS2 的离线 Mock 验证不代表所有 OmniCore 现场写入均已验证。

## 审批与运行边界

- 不提供启动 RAPID、开电机、点动、强制 I/O 或运动命令。
- 写入必须先 `abb_plan_changeset`，由人批准该准确差异和单次令牌，再 `abb_apply_changeset`。运行中可只读预览，但 RAPID 未停止或电机状态不满足时不会发放写入令牌。停止后必须重新计划和批准。
- 删除、重置、restart 必须在批准计划中可见。`SourceDiff.Truncated` 时先查看完整差异。接口不会自动做备份或自动回滚；写前明确备份安排。
- apply 返回 `Verified:true`、`ReadbackSucceeded:true`、`VerificationMode:independent-session` 且操作/build 均通过，才表示独立回读成功；未知或部分成功时 fresh readback 并新建计划，禁止重放旧令牌。
- 备份也遵循 plan → 人批准 → apply → 验证证据。备份目录不覆盖；实际物理动作须在现场独立验证。
- MCP 内的批准令牌是流程约束，并不是独立的用户身份认证系统。客户端/代理必须执行人的批准要求，不能自行调用 apply。

## 可选后端（没有删减）

**legacy PowerShell changeset**：通用 RWS transport 已包含在 `legacy/abb_rws_session.ps1`。在客户端 env 中改为 `ABB_MCP_CHANGESET_BACKEND=legacy`、`ABB_MCP_ALLOW_LEGACY=1`，必要时设置 `ABB_MCP_PWSH` 为自己机器的 PowerShell 7 绝对路径。保留本地 registry 的 `rwsHelperPath`。legacy 的协议/Unicode 能力与直连后端不同，不会在直连失败后静默切换。

**PC SDK helper**：源码全部包含，原工具中它是可选独立 helper，并非默认 MCP 路由。需自行安装 ABB RobotStudio/PC SDK 及所需授权选项，仓库不分发 ABB 专有程序集：

```powershell
$env:ABB_PCSDK_DIR = 'C:\Path\To\Your\RobotStudio\Bin'
npm run build:pcsdk
```

参阅 [PC SDK helper 文档](direct-rws/native/pcsdk/README.md)。这不是普通 RWS 功能的前置条件。

## 更新与测试

```powershell
git pull --ff-only
pwsh -NoProfile -File .\install.ps1 -SkipCredential
npm run test:all
```

更新时保留本地 registry/凭据；修改 server 后重开客户端会话并检查 `abb_health`。不要在有效审批或写入期间重启。测试使用离线 fixture/本机 Mock，不需要真实控制器账号。未构建可选 PC SDK helper 时，测试会验证缺失 helper 时明确拒绝，然后报告跳过 SDK 能力检查；自行安装 SDK 并构建后才运行这些检查。live PC SDK 测试默认关闭。不要为了测试录入或使用现场账号。

## 隐私与分发

`.gitignore` 排除本地 registry、凭据、`.env`、证书/私钥、备份、导出、日志、生成二进制和缓存。仓库只有通用代码和虚构测试数据。提交前仍应检查 `git diff --cached`，不要把现场数据写入源码、Issue 或截图。当前为 Git 克隆安装，未发布 npm 包，也没有声称支持直接 `npx` 安装。

# QClaw Skip Invite

跳过 [QClaw](https://claw.guanjia.qq.com/) 应用的邀请码验证，去除启动时的邀请码弹窗。

## 支持

- QClaw v0.1.9.0+（macOS / Windows）

## 前置要求

- Node.js >= 22

## 使用

```bash
npx qclaw-skip-invite@latest
```

如果 QClaw 正在运行，工具会自动关闭并在完成后重启。该命令可重复执行，已打过补丁会自动跳过。

## 常见问题

### 补丁成功但微信远程连接失败（提示「请先验证邀请码」）

本工具**仅跳过客户端的邀请码输入界面**，不涉及服务器端验证。微信远程功能需要服务器端邀请码校验通过才能使用，补丁无法绕过。需要自行配置自定义渠道，例如企业微信渠道插件：[openclaw-plugin-wecom](https://github.com/sunnoy/openclaw-plugin-wecom)。

### 大模型提示「API key has not been activated」

内置大模型同样受服务器端邀请码限制，需要在设置中配置自定义大模型渠道（自行填入第三方 API key）。

## 还原

重新安装 QClaw 即可还原。

## 免责声明

本工具仅供学习研究使用，不得用于商业用途。使用本工具所产生的一切后果由使用者自行承担，与作者无关。

## License

[MIT](./LICENSE)

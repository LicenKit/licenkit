# Site 模板

这是 LicenKit 提供的完整用户前端模板，不包含 Admin。它包括：

- 产品列表与 Checkout SDK 购买入口；
- 邮箱 Magic Link 请求与消费；
- 客户 License、设备和订阅管理。

模板由 LicenKit 维护，默认参与上游升级。要定制官网，请把模板内容复制到 `custom/site`，将 `package.json` 的包名改为 `@licenkit/site`，再修改复制后的文件：

```bash
cp -R custom_template/site/. custom/site/
```

只要 `custom/site/package.json` 存在，根目录的 site 命令就会完整使用 `custom/site`；不会与模板逐文件合并。删除该文件后会重新使用模板。

复制 `.env.example` 为 `.env`，至少配置 Account slug 和需要展示的产品 slug。产品价格与购买能力通过 `@licenkit/checkout` 从 LicenKit 服务端读取，模板不会在前端保存 Paddle Price ID 或密钥。

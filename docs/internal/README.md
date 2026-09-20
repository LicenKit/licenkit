# 维护者参考

本目录保存实现 LicenKit 所需的长期技术参考，不是用户文档入口：

- [领域模型](./zh-CN/domain-model.md)
- [核心业务流程](./zh-CN/business-flows.md)
- [系统架构](./zh-CN/system-architecture.md)
- [数据模型](./zh-CN/data-model.md)
- [实现验证与发布检查](./zh-CN/operations-and-verification.md)
- [目标数据库结构](./schema.sql)

这些文档描述稳定的领域不变量、状态所有权、事务和安全边界。实现变化影响这些边界时，必须同步更新；阶段计划、临时差距和审计记录不应写入这里。

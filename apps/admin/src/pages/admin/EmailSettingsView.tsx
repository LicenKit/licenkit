import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Copy, Download, KeyRound, Mail, Pencil, Plus, Power, RefreshCw, Send } from "lucide-react";
import {
  api,
  type EmailConfigurationTestResult,
  type EmailIntegration,
  type EmailProviderTemplateExample,
  type EmailTemplateBinding,
  type EmailTemplateContract,
} from "../../lib/api-client";
import { templateDownload } from "../../lib/email-delivery";
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, StatusBadge, formatDate, safeJson } from "../../components/ui";

interface IntegrationForm {
  name: string;
  apiKey: string;
  defaultFromEmail: string;
  defaultFromName: string;
  replyToEmail: string;
  maxAutomaticAttempts: string;
}

const emptyIntegrationForm = (): IntegrationForm => ({
  name: "Primary Resend",
  apiKey: "",
  defaultFromEmail: "",
  defaultFromName: "",
  replyToEmail: "",
  maxAutomaticAttempts: "4",
});

function optionalString(value: string): string | undefined {
  return value.trim() || undefined;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function downloadHtml(example: EmailProviderTemplateExample): void {
  const file = templateDownload(example);
  const objectUrl = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = file.fileName;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

export function EmailSettingsView({ canManage, embedded = false }: { canManage: boolean; embedded?: boolean }) {
  const [contracts, setContracts] = useState<EmailTemplateContract[]>([]);
  const [integrations, setIntegrations] = useState<EmailIntegration[]>([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null);
  const [bindings, setBindings] = useState<EmailTemplateBinding[]>([]);
  const [examples, setExamples] = useState<Record<string, EmailProviderTemplateExample>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [integrationMode, setIntegrationMode] = useState<"create" | "edit" | null>(null);
  const [integrationTarget, setIntegrationTarget] = useState<EmailIntegration | null>(null);
  const [integrationForm, setIntegrationForm] = useState<IntegrationForm>(emptyIntegrationForm);
  const [rotateTarget, setRotateTarget] = useState<EmailIntegration | null>(null);
  const [newApiKey, setNewApiKey] = useState("");
  const [bindingContract, setBindingContract] = useState<EmailTemplateContract | null>(null);
  const [providerTemplateRef, setProviderTemplateRef] = useState("");
  const [testContract, setTestContract] = useState<EmailTemplateContract | null>(null);
  const [testRecipient, setTestRecipient] = useState("");
  const [testResult, setTestResult] = useState<EmailConfigurationTestResult | null>(null);
  const [retryWaitingResult, setRetryWaitingResult] = useState<{ queuedCount: number } | null>(null);

  const selectedIntegration = integrations.find((item) => item.id === selectedIntegrationId) ?? null;
  const bindingsByType = useMemo(() => new Map(bindings.map((item) => [item.notificationType, item])), [bindings]);
  const currentContracts = useMemo(() => {
    const latest = new Map<string, EmailTemplateContract>();
    for (const contract of contracts) {
      const existing = latest.get(contract.notificationType);
      if (!existing || contract.version > existing.version) latest.set(contract.notificationType, contract);
    }
    return [...latest.values()];
  }, [contracts]);
  const activeBindingCount = bindings.filter((item) => item.status === "active").length;

  async function load(preferredIntegrationId?: string | null) {
    setLoading(true);
    setError(null);
    try {
      const [contractResult, integrationResult] = await Promise.all([
        api.admin.emailTemplateContracts.list(),
        api.admin.emailIntegrations.list(),
      ]);
      const preferred = preferredIntegrationId ?? selectedIntegrationId;
      const selected = integrationResult.items.find((item) => item.id === preferred)
        ?? integrationResult.items.find((item) => item.status === "active")
        ?? integrationResult.items[0]
        ?? null;
      const provider = selected?.provider ?? "resend";
      const [bindingResult, exampleEntries] = await Promise.all([
        selected ? api.admin.emailIntegrations.bindings.list(selected.id) : Promise.resolve({ items: [] as EmailTemplateBinding[] }),
        Promise.all(contractResult.items.map(async (contract) => [
          contract.notificationType,
          await api.admin.emailTemplateContracts.example(provider, contract.notificationType, contract.version),
        ] as const)),
      ]);
      setContracts(contractResult.items);
      setIntegrations(integrationResult.items);
      setSelectedIntegrationId(selected?.id ?? null);
      setBindings(bindingResult.items);
      setExamples(Object.fromEntries(exampleEntries));
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(null) }, []);

  function openCreateIntegration() {
    setIntegrationForm(emptyIntegrationForm());
    setIntegrationTarget(null);
    setIntegrationMode("create");
  }

  function openEditIntegration(integration: EmailIntegration) {
    setIntegrationTarget(integration);
    setIntegrationForm({
      name: integration.name,
      apiKey: "",
      defaultFromEmail: integration.defaultFromEmail,
      defaultFromName: integration.defaultFromName ?? "",
      replyToEmail: integration.replyToEmail ?? "",
      maxAutomaticAttempts: String(integration.maxAutomaticAttempts),
    });
    setIntegrationMode("edit");
  }

  async function saveIntegration(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      let id = selectedIntegrationId;
      if (integrationMode === "create") {
        const created = await api.admin.emailIntegrations.create({
          provider: "resend",
          name: integrationForm.name.trim(),
          apiKey: integrationForm.apiKey,
          defaultFromEmail: integrationForm.defaultFromEmail.trim(),
          ...(optionalString(integrationForm.defaultFromName) ? { defaultFromName: optionalString(integrationForm.defaultFromName) } : {}),
          ...(optionalString(integrationForm.replyToEmail) ? { replyToEmail: optionalString(integrationForm.replyToEmail) } : {}),
          maxAutomaticAttempts: Number(integrationForm.maxAutomaticAttempts),
        });
        id = created.id;
      } else if (integrationTarget) {
        await api.admin.emailIntegrations.update(integrationTarget.id, {
          name: integrationForm.name.trim(),
          defaultFromEmail: integrationForm.defaultFromEmail.trim(),
          defaultFromName: optionalString(integrationForm.defaultFromName) ?? null,
          replyToEmail: optionalString(integrationForm.replyToEmail) ?? null,
          maxAutomaticAttempts: Number(integrationForm.maxAutomaticAttempts),
        });
      }
      setIntegrationMode(null);
      setIntegrationTarget(null);
      await load(id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function rotateCredential(event: FormEvent) {
    event.preventDefault();
    if (!rotateTarget) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.emailIntegrations.rotateCredential(rotateTarget.id, newApiKey);
      const id = rotateTarget.id;
      setRotateTarget(null);
      setNewApiKey("");
      await load(id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function toggleIntegration(integration: EmailIntegration) {
    setSaving(true);
    setError(null);
    try {
      if (integration.status === "active") await api.admin.emailIntegrations.disable(integration.id);
      else await api.admin.emailIntegrations.enable(integration.id);
      await load(integration.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  function openBinding(contract: EmailTemplateContract) {
    setBindingContract(contract);
    setProviderTemplateRef(bindingsByType.get(contract.notificationType)?.providerTemplateRef ?? "");
  }

  async function saveBinding(event: FormEvent) {
    event.preventDefault();
    if (!selectedIntegration || !bindingContract) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.emailIntegrations.bindings.upsert(selectedIntegration.id, bindingContract.notificationType, {
        contractVersion: bindingContract.version,
        providerTemplateRef: providerTemplateRef.trim(),
      });
      setBindingContract(null);
      await load(selectedIntegration.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function toggleBinding(binding: EmailTemplateBinding) {
    if (!selectedIntegration) return;
    setSaving(true);
    setError(null);
    try {
      if (binding.status === "active") await api.admin.emailIntegrations.bindings.disable(selectedIntegration.id, binding.notificationType);
      else await api.admin.emailIntegrations.bindings.enable(selectedIntegration.id, binding.notificationType);
      await load(selectedIntegration.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function sendConfigurationTest(event: FormEvent) {
    event.preventDefault();
    if (!selectedIntegration || !testContract) return;
    setSaving(true);
    setError(null);
    setTestResult(null);
    setRetryWaitingResult(null);
    try {
      setTestResult(await api.admin.emailIntegrations.bindings.test(selectedIntegration.id, testContract.notificationType, { recipientEmail: testRecipient.trim() }));
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function retryWaitingDeliveries() {
    if (!selectedIntegration || !testContract || !testResult?.providerAccepted) return;
    setSaving(true);
    setError(null);
    try {
      setRetryWaitingResult(await api.admin.emailIntegrations.bindings.retryWaiting(selectedIntegration.id, testContract.notificationType));
      await load(selectedIntegration.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  if (loading && contracts.length === 0) return <LoadingState label="正在读取邮件配置" />;

  return (
    <div className="page-stack">
      {!embedded ? (
        <PageHeader
          eyebrow="服务与通知"
          title="邮件服务设置"
          description="管理 Resend 发信通道连接、API 密钥轮换，以及业务通知模板与参数变量的映射配置。"
          action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>}
        />
      ) : null}
      <ErrorPanel error={error} />

      <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">发信服务商</p>
            <h2>发信通道配置</h2>
            <p>配置发信通道及发件人信息。新发出的业务邮件将始终使用这里的最新设置。</p>
          </div>
          {canManage ? <Button onClick={openCreateIntegration}><Plus className="size-4" />连接通道</Button> : null}
        </div>
        <Notice>
          <strong>通道配置即时生效</strong>
          <p>修改 API Key、发件人名称、邮箱或回复地址后全局即刻生效，无需繁琐迁移。</p>
        </Notice>
        {integrations.length === 0 ? (
          <EmptyState title="尚未连接发信服务商" description="连接 Resend 通道后，即可为各项业务通知绑定对应的远程邮件模板。" />
        ) : (
          <div className="card-grid">
            {integrations.map((integration) => (
              <article className={`entity-card ${selectedIntegrationId === integration.id ? "selected" : ""}`} key={integration.id}>
                <header>
                  <div>
                    <strong>{integration.name}</strong>
                    <span>{integration.provider} · {integration.id}</span>
                  </div>
                  <StatusBadge status={integration.status} />
                </header>
                <div className="metric-grid compact">
                  <div>
                    <span>发件人 (From)</span>
                    <strong>{integration.defaultFromName ? `${integration.defaultFromName} <${integration.defaultFromEmail}>` : integration.defaultFromEmail}</strong>
                  </div>
                  <div>
                    <span>回复地址 (Reply-To)</span>
                    <strong>{integration.replyToEmail || "—"}</strong>
                  </div>
                  <div>
                    <span>自动重试上限</span>
                    <strong>{integration.maxAutomaticAttempts} 次</strong>
                  </div>
                  <div>
                    <span>API 密钥</span>
                    <strong>{integration.credentialConfigured ? "已配置" : "未配置"}</strong>
                  </div>
                </div>
                <div className="button-row wrap">
                  <Button variant="ghost" onClick={() => void load(integration.id)}>查看模板</Button>
                  {canManage ? <Button variant="secondary" onClick={() => openEditIntegration(integration)}><Pencil className="size-4" />编辑</Button> : null}
                  {canManage ? <Button variant="secondary" onClick={() => { setRotateTarget(integration); setNewApiKey("") }}><KeyRound className="size-4" />轮换 Key</Button> : null}
                  {canManage ? (
                    <Button variant={integration.status === "active" ? "danger" : "secondary"} loading={saving} onClick={() => void toggleIntegration(integration)}>
                      <Power className="size-4" />{integration.status === "active" ? "禁用" : "启用"}
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">通知类型与模板</p>
            <h2>模板与变量绑定</h2>
            <p>{selectedIntegration ? `${selectedIntegration.name} · 已启用 ${activeBindingCount}/${currentContracts.length} 个通知模板` : "先选择一个发信通道。"}</p>
          </div>
          <Badge>{activeBindingCount}/{currentContracts.length} active</Badge>
        </div>
        <Notice tone="warning">
          <strong>实时测试说明</strong>
          <p>测试将使用示例数据实际调用发信服务商发送测试邮件，便于验证密钥可用性与模板语法是否正确。</p>
        </Notice>
        {!selectedIntegration ? (
          <EmptyState title="尚未选择 Email Provider" description="先连接或选择一个 Provider Integration。" />
        ) : (
          <div className="email-contract-list">
            {currentContracts.map((contract) => {
              const binding = bindingsByType.get(contract.notificationType);
              const example = examples[contract.notificationType];
              return (
                <article className="email-contract" key={`${contract.notificationType}@${contract.version}`}>
                  <header>
                    <div>
                      <div className="button-row wrap">
                        <Mail className="size-5" />
                        <h3>{contract.name}</h3>
                        <Badge>v{contract.version}</Badge>
                        {binding ? <StatusBadge status={binding.status} /> : <Badge tone="warning">未绑定</Badge>}
                      </div>
                      <code>{contract.notificationType}</code>
                      <p>{contract.description}</p>
                    </div>
                    <div className="button-row wrap">
                      {canManage ? (
                        <Button variant="secondary" onClick={() => openBinding(contract)}>
                          {binding ? "编辑 Binding" : "创建 Binding"}
                        </Button>
                      ) : null}
                      {canManage && binding ? (
                        <Button
                          variant="secondary"
                          disabled={binding.status !== "active" || selectedIntegration.status !== "active"}
                          onClick={() => { setTestContract(contract); setTestRecipient(""); setTestResult(null); setRetryWaitingResult(null) }}
                        >
                          <Send className="size-4" />发送测试
                        </Button>
                      ) : null}
                      {canManage && binding ? (
                        <Button
                          variant={binding.status === "active" ? "danger" : "secondary"}
                          loading={saving}
                          onClick={() => void toggleBinding(binding)}
                        >
                          {binding.status === "active" ? "禁用" : "启用"}
                        </Button>
                      ) : null}
                    </div>
                  </header>
                  {binding ? (
                    <div className="metric-grid compact">
                      <div><span>Provider Template Ref</span><strong>{binding.providerTemplateRef}</strong></div>
                      <div><span>合同版本</span><strong>v{binding.contractVersion}</strong></div>
                      <div><span>状态</span><strong>{binding.status}</strong></div>
                      <div><span>更新时间</span><strong>{formatDate(binding.updatedAt)}</strong></div>
                    </div>
                  ) : null}
                  <details className="email-contract-detail">
                    <summary>查看合同变量与 Provider 示例</summary>
                    <section>
                      <div className="email-section-heading">
                        <div>
                          <h4>合同变量</h4>
                          <p>变量名、类型、约束和取值逻辑预定义在服务端代码中；业务事件创建 Delivery 时写入加密变量。</p>
                        </div>
                        <Badge>{contract.variables.length} variables</Badge>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>变量</th>
                              <th>类型</th>
                              <th>必填</th>
                              <th>敏感</th>
                              <th>说明</th>
                              <th>示例</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {contract.variables.map((variable) => (
                              <tr key={variable.name}>
                                <td><code>{variable.name}</code></td>
                                <td>{variable.type}{variable.format ? <small>{variable.format}</small> : null}</td>
                                <td>{variable.required ? "是" : "否"}</td>
                                <td>{variable.sensitive ? <Badge tone="warning">敏感</Badge> : "否"}</td>
                                <td>{variable.description}</td>
                                <td><code>{String(variable.example)}</code></td>
                                <td><Button variant="ghost" aria-label={`复制变量 ${variable.name}`} onClick={() => void copyText(variable.name)}><Copy className="size-4" /></Button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    {example ? (
                      <section>
                        <div className="email-section-heading">
                          <div>
                            <h4>{example.provider} 参考模板</h4>
                            <p>占位语法 {example.placeholderSyntax}；LicenKit 不会创建或同步 Provider 远程模板。</p>
                          </div>
                          <Badge>{example.fileName}</Badge>
                        </div>
                        <div className="button-row wrap">
                          <Button variant="secondary" onClick={() => void copyText(example.subject)}><Copy className="size-4" />复制 Subject</Button>
                          <Button variant="secondary" onClick={() => void copyText(example.html)}><Copy className="size-4" />复制 HTML</Button>
                          <Button variant="secondary" onClick={() => downloadHtml(example)}><Download className="size-4" />下载 HTML</Button>
                        </div>
                      </section>
                    ) : null}
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </Card>

      <Modal open={integrationMode !== null} onClose={() => { setIntegrationMode(null); setIntegrationTarget(null) }} title={integrationMode === "create" ? "连接 Resend" : "编辑 Email Provider"} description="保存后，尚未成功的 Delivery 会在下一次发送时读取这些最新配置。">
        <form className="form-stack" onSubmit={saveIntegration}>
          <Field label="Provider"><Input value="resend" disabled /></Field>
          <Field label="连接名称"><Input value={integrationForm.name} onChange={(event) => setIntegrationForm({ ...integrationForm, name: event.target.value })} maxLength={120} required /></Field>
          {integrationMode === "create" ? (
            <Field label="Resend API Key" hint="保存后不回显。">
              <Input type="password" value={integrationForm.apiKey} onChange={(event) => setIntegrationForm({ ...integrationForm, apiKey: event.target.value })} autoComplete="new-password" required />
            </Field>
          ) : null}
          <div className="form-grid">
            <Field label="From Email"><Input type="email" value={integrationForm.defaultFromEmail} onChange={(event) => setIntegrationForm({ ...integrationForm, defaultFromEmail: event.target.value })} required /></Field>
            <Field label="From Name（可选）"><Input value={integrationForm.defaultFromName} onChange={(event) => setIntegrationForm({ ...integrationForm, defaultFromName: event.target.value })} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Reply-To（可选）"><Input type="email" value={integrationForm.replyToEmail} onChange={(event) => setIntegrationForm({ ...integrationForm, replyToEmail: event.target.value })} /></Field>
            <Field label="最大自动发送次数" hint="包含首次 Provider 调用"><Input type="number" min="1" max="20" value={integrationForm.maxAutomaticAttempts} onChange={(event) => setIntegrationForm({ ...integrationForm, maxAutomaticAttempts: event.target.value })} required /></Field>
          </div>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setIntegrationMode(null)}>取消</Button>
            <Button type="submit" loading={saving}>保存</Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(rotateTarget)} onClose={() => setRotateTarget(null)} title="轮换 Resend API Key" description="保存后，之后的所有发送立即使用新 Key。">
        <form className="form-stack" onSubmit={rotateCredential}>
          <Field label="新 API Key"><Input type="password" value={newApiKey} onChange={(event) => setNewApiKey(event.target.value)} autoComplete="new-password" required /></Field>
          <Notice tone="warning"><strong>Key 不会回显</strong><p>建议保存后立即从某个 Binding 发送测试邮件。</p></Notice>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setRotateTarget(null)}>取消</Button>
            <Button type="submit" loading={saving}>轮换 Key</Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(bindingContract)} onClose={() => setBindingContract(null)} title="配置 Template Binding" description={bindingContract ? `${bindingContract.notificationType}@${bindingContract.version}` : undefined} wide>
        {bindingContract ? (
          <form className="form-stack" onSubmit={saveBinding}>
            <Field label="Provider Template Ref" hint="填写 Resend Template ID 或 Alias；保存不会修改远程模板。">
              <Input value={providerTemplateRef} onChange={(event) => setProviderTemplateRef(event.target.value)} maxLength={512} required />
            </Field>
            <Notice><strong>变量合同来自服务端代码</strong><p>Provider 模板必须使用下列变量名。事件发生时由对应业务代码取值并写入加密变量。</p></Notice>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>变量</th>
                    <th>类型</th>
                    <th>必填</th>
                    <th>说明</th>
                    <th>示例</th>
                  </tr>
                </thead>
                <tbody>
                  {bindingContract.variables.map((variable) => (
                    <tr key={variable.name}>
                      <td><code>{variable.name}</code></td>
                      <td>{variable.type}</td>
                      <td>{variable.required ? "是" : "否"}</td>
                      <td>{variable.description}</td>
                      <td><code>{String(variable.example)}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setBindingContract(null)}>取消</Button>
              <Button type="submit" loading={saving}>保存 Binding</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal open={Boolean(testContract)} onClose={() => setTestContract(null)} title="发送配置测试" description={testContract?.notificationType} wide>
        {testContract ? (
          <form className="form-stack" onSubmit={sendConfigurationTest}>
            <Field label="测试收件邮箱" hint="测试会真实发送，并使用合同中显示的示例变量。">
              <Input type="email" value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="you@example.com" required />
            </Field>
            <Notice tone="warning">
              <strong>结果只在本次操作中展示</strong>
              <p>Provider accepted 只表示请求被接管，不代表最终进入收件箱；服务端不会保存这次测试。</p>
            </Notice>
            {testResult ? (
              <Notice tone={testResult.providerAccepted ? "success" : "warning"}>
                <strong>{testResult.providerAccepted ? "Provider accepted" : "Provider 未接受"}</strong>
                <pre>{safeJson(testResult)}</pre>
              </Notice>
            ) : null}
            {retryWaitingResult ? (
              <Notice tone="success">
                <strong>已重新排队</strong>
                <p>{retryWaitingResult.queuedCount} 条等待配置的 Delivery 将使用最新配置发送。</p>
              </Notice>
            ) : null}
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setTestContract(null)}>关闭</Button>
              {testResult?.providerAccepted ? (
                <Button type="button" variant="secondary" loading={saving} onClick={() => void retryWaitingDeliveries()}>
                  <RefreshCw className="size-4" />重试等待配置的邮件
                </Button>
              ) : null}
              <Button type="submit" loading={saving}><Send className="size-4" />发送测试</Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

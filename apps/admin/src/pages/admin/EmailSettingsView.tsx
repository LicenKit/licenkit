import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Copy, Download, KeyRound, Mail, Pencil, Plus, Power, RefreshCw, Send, Upload } from "lucide-react";
import {
  api,
  formatApiError,
  type EmailConfigurationTestResult,
  type EmailDefaultTemplateInstallationResult,
  type EmailIntegration,
  type EmailProviderTemplateExample,
  type EmailTemplateBinding,
  type EmailTemplateContract,
} from "../../lib/api-client";
import { templateDownload } from "../../lib/email-delivery";
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, StatusBadge, safeJson } from "../../components/ui";
import { useI18n } from "../../lib/i18n/I18nContext";

interface IntegrationForm {
  name: string;
  apiKey: string;
  defaultFromEmail: string;
  defaultFromName: string;
  replyToEmail: string;
  maxAutomaticAttempts: string;
}

type DefaultTemplateInstallProgressStatus =
  | "pending"
  | "waiting"
  | "installing"
  | "installed"
  | "already_bound"
  | "failed";

interface DefaultTemplateInstallProgressRow {
  notificationType: string;
  contractVersion: number;
  name: string;
  status: DefaultTemplateInstallProgressStatus;
  waitSeconds?: number;
  providerTemplateRef?: string;
  error?: string;
}

const DEFAULT_TEMPLATE_INSTALL_DELAY_SECONDS = 5;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  const { t, formatDate } = useI18n();
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
  const [installTarget, setInstallTarget] = useState<EmailIntegration | null>(null);
  const [fullAccessApiKey, setFullAccessApiKey] = useState("");
  const [installResult, setInstallResult] = useState<{
    integrationId: string;
    result: EmailDefaultTemplateInstallationResult;
  } | null>(null);
  const [installProgress, setInstallProgress] = useState<DefaultTemplateInstallProgressRow[]>([]);
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
  const missingBindingCount = currentContracts.filter(
    (contract) => !bindingsByType.has(contract.notificationType),
  ).length;

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

  async function installDefaultTemplates(event: FormEvent) {
    event.preventDefault();
    if (!installTarget) return;
    setSaving(true);
    setError(null);
    const integrationId = installTarget.id;
    const tasks = installProgress.filter((row) => row.status === "pending" || row.status === "failed");
    const completedItems: EmailDefaultTemplateInstallationResult["items"] = installProgress
      .filter((row) => (row.status === "installed" || row.status === "already_bound") && row.providerTemplateRef)
      .map((row) => ({
        notificationType: row.notificationType,
        contractVersion: row.contractVersion,
        providerTemplateRef: row.providerTemplateRef!,
        outcome: row.status === "installed" ? "installed" : "already_bound",
      }));
    let installedCount = installProgress.filter((row) => row.status === "installed").length;
    let skippedCount = installProgress.filter((row) => row.status === "already_bound").length;
    setInstallProgress((rows) => rows.map((row) => row.status === "failed"
      ? { ...row, status: "pending", waitSeconds: undefined, error: undefined }
      : row));
    try {
      for (const [index, task] of tasks.entries()) {
        if (index > 0) {
          for (
            let waitSeconds = DEFAULT_TEMPLATE_INSTALL_DELAY_SECONDS;
            waitSeconds > 0;
            waitSeconds -= 1
          ) {
            setInstallProgress((rows) => rows.map((row) => row.notificationType === task.notificationType
              ? { ...row, status: "waiting", waitSeconds, error: undefined }
              : row));
            await wait(1_000);
          }
        }
        setInstallProgress((rows) => rows.map((row) => row.notificationType === task.notificationType
          ? { ...row, status: "installing", waitSeconds: undefined, error: undefined }
          : row));

        try {
          const result = await api.admin.emailIntegrations.installDefaultTemplates(
            integrationId,
            fullAccessApiKey,
            {
              notificationType: task.notificationType,
              contractVersion: task.contractVersion,
            },
          );
          const item = result.items[0];
          if (!item) throw new Error(`Template installation returned no result for ${task.notificationType}.`);
          completedItems.push(item);
          if (item.outcome === "installed") installedCount += 1;
          else skippedCount += 1;
          setInstallProgress((rows) => rows.map((row) => row.notificationType === task.notificationType
            ? {
              ...row,
              status: item.outcome,
              waitSeconds: undefined,
              providerTemplateRef: item.providerTemplateRef,
              error: undefined,
            }
            : row));
        } catch (caught) {
          setInstallProgress((rows) => rows.map((row) => row.notificationType === task.notificationType
            ? { ...row, status: "failed", waitSeconds: undefined, error: formatApiError(caught) }
            : row));
          await load(integrationId);
          setError(caught);
          return;
        }
      }

      setInstallResult({
        integrationId,
        result: {
          provider: "resend",
          installedCount,
          skippedCount,
          totalCount: installProgress.length,
          complete: true,
          items: completedItems,
        },
      });
      setInstallTarget(null);
      setInstallProgress([]);
      await load(integrationId);
    } finally {
      setFullAccessApiKey("");
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

  if (loading && contracts.length === 0) return <LoadingState label={t.email.loadingSettings} />;

  return (
    <div className="page-stack">
      {!embedded ? (
        <PageHeader
          eyebrow={t.email.settingsEyebrow}
          title={t.email.settingsTitle}
          description={t.email.settingsDesc}
          action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />{t.common.refresh}</Button>}
        />
      ) : null}
      <ErrorPanel error={error} onClose={() => setError(null)} />

      <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">{t.email.channelSectionEyebrow}</p>
            <h2>{t.email.channelSectionTitle}</h2>
            <p>{t.email.channelSectionDesc}</p>
          </div>
          {canManage ? <Button onClick={openCreateIntegration}><Plus className="size-4" />{t.email.newIntegration}</Button> : null}
        </div>
        <Notice>
          <strong>{t.email.channelNoticeTitle}</strong>
          <p>{t.email.channelNoticeDesc}</p>
        </Notice>
        {integrations.length === 0 ? (
          <EmptyState title={t.email.integrationsEmptyTitle} description={t.email.integrationsEmptyDesc} />
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
                    <span>{t.email.colSenderFrom}</span>
                    <strong>{integration.defaultFromName ? `${integration.defaultFromName} <${integration.defaultFromEmail}>` : integration.defaultFromEmail}</strong>
                  </div>
                  <div>
                    <span>{t.email.colReplyTo}</span>
                    <strong>{integration.replyToEmail || "—"}</strong>
                  </div>
                  <div>
                    <span>{t.email.colMaxRetry}</span>
                    <strong>{t.email.countTimes(integration.maxAutomaticAttempts)}</strong>
                  </div>
                  <div>
                    <span>{t.email.colApiKey}</span>
                    <strong>{integration.credentialConfigured ? t.email.statusConfigured : t.email.statusNotConfigured}</strong>
                  </div>
                </div>
                <div className="button-row wrap">
                  <Button variant="ghost" onClick={() => void load(integration.id)}>{t.email.btnViewTemplates}</Button>
                  {canManage ? <Button variant="secondary" onClick={() => openEditIntegration(integration)}><Pencil className="size-4" />{t.common.edit}</Button> : null}
                  {canManage ? <Button variant="secondary" onClick={() => { setRotateTarget(integration); setNewApiKey("") }}><KeyRound className="size-4" />{t.email.btnRotateKey}</Button> : null}
                  {canManage ? (
                    <Button variant={integration.status === "active" ? "danger" : "secondary"} loading={saving} onClick={() => void toggleIntegration(integration)}>
                      <Power className="size-4" />{integration.status === "active" ? t.common.disable : t.common.enable}
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
            <p className="eyebrow">{t.email.templatesEyebrow}</p>
            <h2>{t.email.templatesSectionTitle}</h2>
            <p>{selectedIntegration ? t.email.templatesSectionSubdesc(selectedIntegration.name, activeBindingCount, currentContracts.length) : t.email.templatesSelectPrompt}</p>
          </div>
          <div className="button-row wrap">
            {canManage && selectedIntegration?.provider === "resend" && missingBindingCount > 0 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setInstallTarget(selectedIntegration);
                  setFullAccessApiKey("");
                  setInstallResult(null);
                  setInstallProgress(currentContracts.map((contract) => {
                    const binding = bindingsByType.get(contract.notificationType);
                    return {
                      notificationType: contract.notificationType,
                      contractVersion: contract.version,
                      name: contract.name,
                      status: binding ? "already_bound" : "pending",
                      ...(binding ? { providerTemplateRef: binding.providerTemplateRef } : {}),
                    };
                  }));
                }}
              >
                <Upload className="size-4" />{t.email.btnInstallDefaultTemplates}
              </Button>
            ) : null}
            <Badge>{activeBindingCount}/{currentContracts.length} active</Badge>
          </div>
        </div>
        <Notice tone="warning">
          <strong>{t.email.testingNoticeTitle}</strong>
          <p>{t.email.testingNoticeDesc}</p>
        </Notice>
        {installResult && installResult.integrationId === selectedIntegration?.id ? (
          <Notice tone="success">
            <strong>{t.email.defaultTemplateInstallSuccessTitle}</strong>
            <p>{t.email.defaultTemplateInstallSuccessDesc(
              installResult.result.installedCount,
              installResult.result.skippedCount,
            )}</p>
          </Notice>
        ) : null}
        {!selectedIntegration ? (
          <EmptyState title={t.email.notSelectedTitle} description={t.email.notSelectedDesc} />
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
                        {binding ? <StatusBadge status={binding.status} /> : <Badge tone="warning">{t.email.unboundBadge}</Badge>}
                      </div>
                      <code>{contract.notificationType}</code>
                      <p>{contract.description}</p>
                    </div>
                    <div className="button-row wrap">
                      {canManage ? (
                        <Button variant="secondary" onClick={() => openBinding(contract)}>
                          {binding ? t.email.btnEditBinding : t.email.btnBindTemplate}
                        </Button>
                      ) : null}
                      {canManage && binding ? (
                        <Button
                          variant="secondary"
                          disabled={binding.status !== "active" || selectedIntegration.status !== "active"}
                          onClick={() => { setTestContract(contract); setTestRecipient(""); setTestResult(null); setRetryWaitingResult(null) }}
                        >
                          <Send className="size-4" />{t.email.btnSendTestEmail}
                        </Button>
                      ) : null}
                      {canManage && binding ? (
                        <Button
                          variant={binding.status === "active" ? "danger" : "secondary"}
                          loading={saving}
                          onClick={() => void toggleBinding(binding)}
                        >
                          {binding.status === "active" ? t.common.disable : t.common.enable}
                        </Button>
                      ) : null}
                    </div>
                  </header>
                  {binding ? (
                    <div className="metric-grid compact">
                      <div><span>{t.email.colTemplateRef}</span><strong>{binding.providerTemplateRef}</strong></div>
                      <div><span>{t.email.colContractVersion}</span><strong>v{binding.contractVersion}</strong></div>
                      <div><span>{t.common.status}</span><strong>{binding.status}</strong></div>
                      <div><span>{t.common.updatedAt}</span><strong>{formatDate(binding.updatedAt)}</strong></div>
                    </div>
                  ) : null}
                  <details className="email-contract-detail">
                    <summary>{t.email.variablesSectionSummary}</summary>
                    <section>
                      <div className="email-section-heading">
                        <div>
                          <h4>{t.email.variablesTitle}</h4>
                          <p>{t.email.variablesDesc}</p>
                        </div>
                        <Badge>{contract.variables.length} variables</Badge>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>{t.email.tableColVariable}</th>
                              <th>{t.email.tableColDataType}</th>
                              <th>{t.email.tableColRequired}</th>
                              <th>{t.email.tableColSensitive}</th>
                              <th>{t.email.tableColDescription}</th>
                              <th>{t.email.tableColExample}</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {contract.variables.map((variable) => (
                              <tr key={variable.name}>
                                <td><code>{variable.name}</code></td>
                                <td>{variable.type}{variable.format ? <small>{variable.format}</small> : null}</td>
                                <td>{variable.required ? t.email.yes : t.email.no}</td>
                                <td>{variable.sensitive ? <Badge tone="warning">{t.email.sensitiveBadge}</Badge> : t.email.no}</td>
                                <td>{variable.description}</td>
                                <td><code>{String(variable.example)}</code></td>
                                <td><Button variant="ghost" aria-label={t.common.copyValue(variable.name)} onClick={() => void copyText(variable.name)}><Copy className="size-4" /></Button></td>
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
                            <h4>{t.email.sampleTemplateTitle(example.provider)}</h4>
                            <p>{t.email.sampleTemplateDesc(example.placeholderSyntax)}</p>
                          </div>
                          <Badge>{example.fileName}</Badge>
                        </div>
                        <div className="button-row wrap">
                          <Button variant="secondary" onClick={() => void copyText(example.subject)}><Copy className="size-4" />{t.email.btnCopySubject}</Button>
                          <Button variant="secondary" onClick={() => void copyText(example.html)}><Copy className="size-4" />{t.email.btnCopyHtml}</Button>
                          <Button variant="secondary" onClick={() => downloadHtml(example)}><Download className="size-4" />{t.email.btnDownloadHtml}</Button>
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

      <Modal open={integrationMode !== null} onClose={() => { setIntegrationMode(null); setIntegrationTarget(null) }} title={t.email.modalIntegrationTitle(integrationMode === "edit")} description={t.email.modalIntegrationSaveDesc}>
        <form className="form-stack" onSubmit={saveIntegration}>
          <Field label={t.email.fieldProviderLabel}><Input value="resend" disabled /></Field>
          <Field label={t.email.fieldChannelName}><Input value={integrationForm.name} onChange={(event) => setIntegrationForm({ ...integrationForm, name: event.target.value })} maxLength={120} required /></Field>
          {integrationMode === "create" ? (
            <Field label={t.email.fieldApiKey} hint={t.email.fieldApiKeyHint}>
              <Input type="password" value={integrationForm.apiKey} onChange={(event) => setIntegrationForm({ ...integrationForm, apiKey: event.target.value })} autoComplete="new-password" required />
            </Field>
          ) : null}
          <div className="form-grid">
            <Field label={t.email.fieldFromEmail}><Input type="email" value={integrationForm.defaultFromEmail} onChange={(event) => setIntegrationForm({ ...integrationForm, defaultFromEmail: event.target.value })} required /></Field>
            <Field label={t.email.fieldFromName}><Input value={integrationForm.defaultFromName} onChange={(event) => setIntegrationForm({ ...integrationForm, defaultFromName: event.target.value })} /></Field>
          </div>
          <div className="form-grid">
            <Field label={t.email.fieldReplyTo}><Input type="email" value={integrationForm.replyToEmail} onChange={(event) => setIntegrationForm({ ...integrationForm, replyToEmail: event.target.value })} /></Field>
            <Field label={t.email.fieldMaxAttempts} hint={t.email.fieldMaxAttemptsHint}><Input type="number" min="1" max="20" value={integrationForm.maxAutomaticAttempts} onChange={(event) => setIntegrationForm({ ...integrationForm, maxAutomaticAttempts: event.target.value })} required /></Field>
          </div>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setIntegrationMode(null)}>{t.common.cancel}</Button>
            <Button type="submit" loading={saving}>{t.common.save}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(rotateTarget)} onClose={() => setRotateTarget(null)} title={t.email.modalRotateKeyTitle} description={t.email.modalRotateKeyDesc}>
        <form className="form-stack" onSubmit={rotateCredential}>
          <Field label={t.email.fieldNewApiKey}><Input type="password" value={newApiKey} onChange={(event) => setNewApiKey(event.target.value)} autoComplete="new-password" required /></Field>
          <Notice tone="warning"><strong>{t.email.rotateKeyNoticeTitle}</strong><p>{t.email.rotateKeyNoticeDesc}</p></Notice>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setRotateTarget(null)}>{t.common.cancel}</Button>
            <Button type="submit" loading={saving}>{t.email.btnConfirmRotate}</Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(installTarget)}
        onClose={() => {
          if (saving) return;
          setInstallTarget(null);
          setFullAccessApiKey("");
          setInstallProgress([]);
        }}
        title={t.email.modalDefaultTemplateInstallTitle}
        description={t.email.modalDefaultTemplateInstallDesc(missingBindingCount)}
        wide
      >
        <form className="form-stack" onSubmit={installDefaultTemplates}>
          <Field
            label={t.email.fieldFullAccessApiKey}
            hint={t.email.fieldFullAccessApiKeyHint}
          >
            <Input
              type="password"
              value={fullAccessApiKey}
              onChange={(event) => setFullAccessApiKey(event.target.value)}
              autoComplete="new-password"
              disabled={saving}
              required
            />
          </Field>
          <Notice tone="warning">
            <strong>{t.email.defaultTemplateInstallNoticeTitle}</strong>
            <p>{t.email.defaultTemplateInstallNoticeDesc}</p>
          </Notice>
          <div className="table-wrap" aria-live="polite">
            <table>
              <thead>
                <tr>
                  <th>{t.email.defaultTemplateInstallProgressTemplate}</th>
                  <th>{t.common.status}</th>
                  <th>{t.common.details}</th>
                </tr>
              </thead>
              <tbody>
                {installProgress.map((row) => {
                  const status = row.status === "installing"
                    ? { value: "processing", label: t.email.defaultTemplateInstallStatusInstalling }
                    : row.status === "waiting"
                      ? {
                        value: "pending",
                        label: t.email.defaultTemplateInstallStatusWaiting(
                          row.waitSeconds ?? DEFAULT_TEMPLATE_INSTALL_DELAY_SECONDS,
                        ),
                      }
                      : row.status === "installed"
                        ? { value: "completed", label: t.email.defaultTemplateInstallStatusInstalled }
                        : row.status === "already_bound"
                          ? { value: "linked", label: t.email.defaultTemplateInstallStatusSkipped }
                          : row.status === "failed"
                            ? { value: "failed", label: t.email.defaultTemplateInstallStatusFailed }
                            : { value: "pending", label: t.email.defaultTemplateInstallStatusPending };
                  return (
                    <tr key={`${row.notificationType}@${row.contractVersion}`}>
                      <td><strong>{row.name}</strong><small>{row.notificationType}@{row.contractVersion}</small></td>
                      <td><StatusBadge status={status.value} label={status.label} /></td>
                      <td><small>{row.error ?? row.providerTemplateRef ?? (row.status === "waiting"
                        ? t.email.defaultTemplateInstallDelayNotice(
                          row.waitSeconds ?? DEFAULT_TEMPLATE_INSTALL_DELAY_SECONDS,
                        )
                        : "—")}</small></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => { setInstallTarget(null); setFullAccessApiKey(""); setInstallProgress([]) }}
            >
              {installProgress.every((row) => row.status === "installed" || row.status === "already_bound")
                ? t.common.close
                : t.common.cancel}
            </Button>
            {installProgress.some((row) => row.status === "pending" || row.status === "failed") ? (
              <Button type="submit" loading={saving}>
                <Upload className="size-4" />{t.email.btnConfirmDefaultTemplateInstall}
              </Button>
            ) : null}
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(bindingContract)} onClose={() => setBindingContract(null)} title={t.email.modalBindingTitle} description={bindingContract ? `${bindingContract.notificationType}@${bindingContract.version}` : undefined} wide>
        {bindingContract ? (
          <form className="form-stack" onSubmit={saveBinding}>
            <Field label={t.email.fieldTemplateRef} hint={t.email.bindingTemplateRefHint}>
              <Input value={providerTemplateRef} onChange={(event) => setProviderTemplateRef(event.target.value)} maxLength={512} required />
            </Field>
            <Notice><strong>{t.email.bindingVariablesNoticeTitle}</strong><p>{t.email.bindingVariablesNoticeDesc}</p></Notice>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t.email.tableColVariable}</th>
                    <th>{t.email.tableColDataType}</th>
                    <th>{t.email.tableColRequired}</th>
                    <th>{t.email.tableColDescription}</th>
                    <th>{t.email.tableColExample}</th>
                  </tr>
                </thead>
                <tbody>
                  {bindingContract.variables.map((variable) => (
                    <tr key={variable.name}>
                      <td><code>{variable.name}</code></td>
                      <td>{variable.type}</td>
                      <td>{variable.required ? t.email.yes : t.email.no}</td>
                      <td>{variable.description}</td>
                      <td><code>{String(variable.example)}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setBindingContract(null)}>{t.common.cancel}</Button>
              <Button type="submit" loading={saving}>{t.email.btnSaveBinding}</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal open={Boolean(testContract)} onClose={() => setTestContract(null)} title={t.email.modalTestTitle} description={testContract?.notificationType} wide>
        {testContract ? (
          <form className="form-stack" onSubmit={sendConfigurationTest}>
            <Field label={t.email.fieldTestRecipient} hint={t.email.testRecipientHint}>
              <Input type="email" value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="you@example.com" required />
            </Field>
            <Notice tone="warning">
              <strong>{t.email.testNoticeTitle}</strong>
              <p>{t.email.testNoticeDesc}</p>
            </Notice>
            {testResult ? (
              <Notice tone={testResult.providerAccepted ? "success" : "warning"}>
                <strong>{testResult.providerAccepted ? t.email.testSuccessTitle : t.email.testFailedTitle}</strong>
                <pre>{safeJson(testResult)}</pre>
              </Notice>
            ) : null}
            {retryWaitingResult ? (
              <Notice tone="success">
                <strong>{t.email.retryQueuedTitle}</strong>
                <p>{t.email.retryQueuedDesc(retryWaitingResult.queuedCount)}</p>
              </Notice>
            ) : null}
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setTestContract(null)}>{t.common.close}</Button>
              {testResult?.providerAccepted ? (
                <Button type="button" variant="secondary" loading={saving} onClick={() => void retryWaitingDeliveries()}>
                  <RefreshCw className="size-4" />{t.email.btnRetryWaitingDeliveries}
                </Button>
              ) : null}
              <Button type="submit" loading={saving}><Send className="size-4" />{t.email.btnSendTestEmail}</Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

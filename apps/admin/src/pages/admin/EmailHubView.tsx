import { useState } from "react";
import { Mail, Send } from "lucide-react";
import { PageHeader } from "../../components/ui";
import { EmailDeliveriesView } from "./EmailDeliveriesView";
import { EmailSettingsView } from "./EmailSettingsView";
import { useI18n } from "../../lib/i18n";

type EmailTab = "deliveries" | "settings";

export function EmailHubView({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<EmailTab>("deliveries");

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.email.hubEyebrow}
        title={t.email.hubTitle}
        description={t.email.hubDesc}
      />
      <div className="tabs" role="tablist" aria-label={t.email.hubTitle}>
        <button
          role="tab"
          aria-selected={tab === "deliveries"}
          className={tab === "deliveries" ? "active" : ""}
          onClick={() => setTab("deliveries")}
        >
          <Send className="size-4 inline-block mr-1.5 align-middle" />
          {t.email.tabDeliveries}
        </button>
        <button
          role="tab"
          aria-selected={tab === "settings"}
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          <Mail className="size-4 inline-block mr-1.5 align-middle" />
          {t.email.tabSettings}
        </button>
      </div>

      {tab === "deliveries" ? <EmailDeliveriesView canManage={canManage} /> : null}
      {tab === "settings" ? <EmailSettingsView canManage={canManage} embedded /> : null}
    </div>
  );
}

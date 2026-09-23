import { useState } from "react";
import { Mail, Send } from "lucide-react";
import { PageHeader } from "../../components/ui";
import { EmailDeliveriesView } from "./EmailDeliveriesView";
import { EmailSettingsView } from "./EmailSettingsView";

type EmailTab = "deliveries" | "settings";

export function EmailHubView({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<EmailTab>("deliveries");

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="服务与通知"
        title="邮件中心"
        description="统一管理系统外发邮件队列、投递状态排查，以及 Resend 发信通道和模板绑定配置。"
      />
      <div className="tabs" role="tablist" aria-label="邮件中心导航">
        <button
          role="tab"
          aria-selected={tab === "deliveries"}
          className={tab === "deliveries" ? "active" : ""}
          onClick={() => setTab("deliveries")}
        >
          <Send className="size-4 inline-block mr-1.5 align-middle" />
          投递记录与队列
        </button>
        <button
          role="tab"
          aria-selected={tab === "settings"}
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          <Mail className="size-4 inline-block mr-1.5 align-middle" />
          通道与模板设置
        </button>
      </div>

      {tab === "deliveries" ? <EmailDeliveriesView canManage={canManage} /> : null}
      {tab === "settings" ? <EmailSettingsView canManage={canManage} embedded /> : null}
    </div>
  );
}

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, Mail, RefreshCw } from "lucide-react";
import { TurnstileWidget } from "../components/TurnstileWidget";
import { Button, Card, ErrorPanel, Field, Input, LoadingState, Notice } from "../components/ui";
import { api } from "../lib/api-client";

function accountSlugFromQuery(): string | null {
  const value = new URLSearchParams(window.location.search).get("accountSlug")?.trim().toLowerCase() ?? "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 63 ? value : null;
}

export function MagicLinkRequestPage() {
  const [accountSlug] = useState(accountSlugFromQuery);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [challengeVersion, setChallengeVersion] = useState(0);
  const [email, setEmail] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const onToken = useCallback((token: string | null) => setTurnstileToken(token), []);
  const onTurnstileError = useCallback((caught: Error) => setError(caught), []);

  useEffect(() => {
    if (!accountSlug) return;
    setError(null);
    void api.customer.auth.config()
      .then((config) => setSiteKey(config.turnstileSiteKey))
      .catch(setError);
  }, [accountSlug]);

  async function requestLink(event: FormEvent) {
    event.preventDefault();
    if (!accountSlug || !turnstileToken) return;
    setLoading(true);
    setError(null);
    try {
      await api.customer.auth.requestMagicLink({ accountSlug, email: email.trim(), turnstileToken });
      setAccepted(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setTurnstileToken(null);
      setChallengeVersion((value) => value + 1);
      setLoading(false);
    }
  }

  if (!accountSlug) {
    return <main className="portal-auth-page"><Card className="portal-auth-card"><h1>请求地址无效</h1><p>缺少合法的公开 Account slug。请从发行方提供的客户授权中心入口重新进入。</p></Card></main>;
  }

  return (
    <main className="portal-auth-page">
      <form className="portal-auth-card card" onSubmit={requestLink}>
        <div className="brand-mark"><Mail className="size-6" /></div>
        <p className="eyebrow">{accountSlug} · 客户授权中心</p>
        <h1>通过邮箱登录</h1>
        <p>无需密码。通过人机验证后，我们会向已存在的客户邮箱发送 15 分钟有效的一次性链接。</p>
        <ErrorPanel error={error} />
        {accepted ? <Notice tone="success"><strong>如果该邮箱存在有效客户记录，登录链接将会发送。</strong><p>请检查收件箱。为保护隐私，我们不会说明邮箱是否存在或是否命中发送冷却。</p></Notice> : null}
        <Field label="购买时使用的邮箱"><Input type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setAccepted(false); }} required /></Field>
        {siteKey ? <TurnstileWidget key={challengeVersion} siteKey={siteKey} onToken={onToken} onError={onTurnstileError} /> : error ? <Button type="button" variant="secondary" onClick={() => window.location.reload()}><RefreshCw className="size-4" />重新加载验证</Button> : <LoadingState label="正在加载人机验证" />}
        <Button className="w-full" type="submit" loading={loading} disabled={!turnstileToken}>发送登录链接 <ArrowRight className="size-4" /></Button>
        <a className="support-note" href={`/customer/${encodeURIComponent(accountSlug)}`}><KeyRound className="size-4" />已经登录？返回客户授权中心</a>
      </form>
    </main>
  );
}

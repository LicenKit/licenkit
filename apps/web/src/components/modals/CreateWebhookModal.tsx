import React, { useState } from "react";
import { api } from "../../lib/api-client";
import { X, Webhook, Loader2, Check, Copy, AlertTriangle, ShieldCheck } from "lucide-react";

interface CreateWebhookModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  products: Array<{ id: string; name: string }>;
}

const AVAILABLE_EVENTS = [
  { id: "license.created", label: "license.created", desc: "Triggered when a new license key is issued" },
  { id: "license.revoked", label: "license.revoked", desc: "Triggered when a license is revoked or cancelled" },
  { id: "license.suspended", label: "license.suspended", desc: "Triggered when a license is temporarily suspended" },
  { id: "license.updated", label: "license.updated", desc: "Triggered when license attributes or expiration change" },
  { id: "client.activated", label: "client.activated", desc: "Triggered when a machine binds a seat" },
  { id: "client.deactivated", label: "client.deactivated", desc: "Triggered when a machine releases a seat" },
];

export const CreateWebhookModal: React.FC<CreateWebhookModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  products,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [productId, setProductId] = useState("*");
  const [url, setUrl] = useState("");
  const [allEvents, setAllEvents] = useState(true);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);

  // Result state (showing secret once)
  const [createdEndpoint, setCreatedEndpoint] = useState<{
    id: string;
    url: string;
    secret: string;
  } | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  if (!isOpen) return null;

  const handleToggleEvent = (eventId: string) => {
    if (selectedEvents.includes(eventId)) {
      setSelectedEvents(selectedEvents.filter((e) => e !== eventId));
    } else {
      setSelectedEvents([...selectedEvents, eventId]);
    }
  };

  const handleCopySecret = async () => {
    if (!createdEndpoint?.secret) return;
    try {
      await navigator.clipboard.writeText(createdEndpoint.secret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleResetAndClose = () => {
    setCreatedEndpoint(null);
    setUrl("");
    setProductId("*");
    setAllEvents(true);
    setSelectedEvents([]);
    setError(null);
    setLoading(false);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (!url.trim().startsWith("https://") && !url.trim().startsWith("http://")) {
      setError("Please provide a valid webhook URL (must start with https:// or http://)");
      setLoading(false);
      return;
    }

    const events = allEvents ? ["*"] : selectedEvents;
    if (events.length === 0) {
      setError("Please select at least one event to subscribe to");
      setLoading(false);
      return;
    }

    try {
      const res = await api.webhooks.createEndpoint({
        productId,
        url: url.trim(),
        events,
      });

      if (res?.id && res?.secret) {
        setCreatedEndpoint({
          id: res.id,
          url: res.url,
          secret: res.secret,
        });
        onSuccess();
      } else {
        throw new Error("Failed to create webhook endpoint");
      }
    } catch (err: any) {
      setError(err.message || "Failed to create webhook endpoint");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-indigo-400">
              <Webhook className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">
                {createdEndpoint ? "Webhook Endpoint Created" : "Add Outbound Webhook"}
              </h2>
              <p className="text-xs text-slate-400">
                {createdEndpoint
                  ? "Save your webhook signing secret now"
                  : "Stream real-time licensing events to Zapier, Resend, or your server"}
              </p>
            </div>
          </div>
          <button
            onClick={handleResetAndClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        {createdEndpoint ? (
          <div className="p-6 space-y-5">
            <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200 leading-relaxed">
                <span className="font-semibold text-amber-300 block mb-0.5">Copy your Signing Secret</span>
                This secret is required to verify the <code className="font-mono bg-amber-950/80 px-1 py-0.5 rounded text-amber-200">X-LicenKit-Signature</code> header on your endpoint. For your security, it will never be displayed again.
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5 uppercase tracking-wider">
                Signing Secret (HMAC-SHA256)
              </label>
              <div className="flex items-center gap-2 bg-slate-950 border border-slate-700/80 rounded-lg p-2.5">
                <code className="text-xs font-mono text-emerald-400 flex-1 select-all break-all">
                  {createdEndpoint.secret}
                </code>
                <button
                  type="button"
                  onClick={handleCopySecret}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-md transition-colors border border-slate-700"
                >
                  {copiedSecret ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="text-xs text-slate-400 bg-slate-950/40 border border-slate-800 rounded-lg p-3 space-y-1">
              <div className="flex items-center gap-2 text-slate-300 font-medium">
                <ShieldCheck className="w-4 h-4 text-indigo-400" />
                <span>Zero SMTP Decoupled Architecture</span>
              </div>
              <p className="text-[11px] text-slate-400">
                LicenKit asynchronously broadcasts events via Cloudflare Queues with exponential retry.
                Configure your receiver to verify HMAC signatures against the raw request body.
              </p>
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={handleResetAndClose}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-indigo-600/20 transition-colors"
              >
                I Have Saved the Secret
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs text-rose-300">
                {error}
              </div>
            )}

            {/* Target URL */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Endpoint URL <span className="text-rose-400">*</span>
              </label>
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.yourdomain.com/webhooks/licenkit"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                LicenKit will send HTTP POST requests with an <code className="font-mono text-slate-400">X-LicenKit-Signature</code> header.
              </p>
            </div>

            {/* Scope Product */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Product Scope</label>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="*">All Products (*)</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Event Subscriptions */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-slate-300">Subscribed Events</label>
                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-indigo-400 hover:text-indigo-300">
                  <input
                    type="checkbox"
                    checked={allEvents}
                    onChange={(e) => {
                      setAllEvents(e.target.checked);
                      if (e.target.checked) setSelectedEvents([]);
                    }}
                    className="rounded border-slate-700 text-indigo-600 focus:ring-0 bg-slate-950"
                  />
                  <span>Subscribe to All Events (*)</span>
                </label>
              </div>

              {!allEvents && (
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1 border border-slate-800 rounded-lg p-2.5 bg-slate-950/60">
                  {AVAILABLE_EVENTS.map((evt) => (
                    <label
                      key={evt.id}
                      className="flex items-start gap-2.5 p-1.5 hover:bg-slate-900 rounded cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedEvents.includes(evt.id)}
                        onChange={() => handleToggleEvent(evt.id)}
                        className="mt-0.5 rounded border-slate-700 text-indigo-600 focus:ring-0 bg-slate-900"
                      />
                      <div>
                        <div className="text-xs font-mono text-slate-200">{evt.label}</div>
                        <div className="text-[11px] text-slate-500">{evt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={handleResetAndClose}
                disabled={loading}
                className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !url.trim()}
                className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-white rounded-lg transition-colors shadow-lg shadow-indigo-600/20"
              >
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Create Endpoint</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

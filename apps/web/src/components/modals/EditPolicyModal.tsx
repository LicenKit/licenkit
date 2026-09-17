import React, { useState, useEffect } from "react";
import { api } from "../../lib/api-client";
import { X, Loader2, Edit3, Trash2, Clock, ShieldCheck, Monitor } from "lucide-react";

interface EditPolicyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  policy: any;
}

export const EditPolicyModal: React.FC<EditPolicyModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  policy,
}) => {
  const [loading, setLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [durationType, setDurationType] = useState<"perpetual" | "period">("period");
  const [durationDays, setDurationDays] = useState(365);
  const [maxMachines, setMaxMachines] = useState(3);
  const [offlineGraceDays, setOfflineGraceDays] = useState(30);
  const [scheme, setScheme] = useState<"ed25519" | "guid">("ed25519");
  const [strict, setStrict] = useState(true);
  const [featuresText, setFeaturesText] = useState("");
  const [stripePriceId, setStripePriceId] = useState("");
  const [paddlePriceId, setPaddlePriceId] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (policy) {
      setName(policy.name || "");
      if (policy.duration) {
        setDurationType("period");
        setDurationDays(Math.round(policy.duration / 86400));
      } else {
        setDurationType("perpetual");
        setDurationDays(365);
      }
      setMaxMachines(policy.maxMachines ?? 1);
      setOfflineGraceDays(Math.round((policy.offlineGracePeriod ?? 2592000) / 86400));
      setScheme(policy.scheme || "ed25519");
      setStrict(policy.strict ?? true);
      const feats = policy.features || [];
      setFeaturesText(Array.isArray(feats) ? feats.join(", ") : "");
      const meta = policy.metadata || {};
      setStripePriceId(meta.stripe_price_id || "");
      setPaddlePriceId(meta.paddle_price_id || "");
      setIsActive(policy.isActive ?? true);
      setError(null);
    }
  }, [policy]);

  if (!isOpen || !policy) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const durationSeconds = durationType === "perpetual" ? null : durationDays * 86400;
      const offlineGraceSeconds = offlineGraceDays * 86400;

      const featuresArray = featuresText
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);

      const metadata: Record<string, string> = { ...(policy.metadata || {}) };
      if (stripePriceId.trim()) metadata.stripe_price_id = stripePriceId.trim();
      else delete metadata.stripe_price_id;

      if (paddlePriceId.trim()) metadata.paddle_price_id = paddlePriceId.trim();
      else delete metadata.paddle_price_id;

      await api.policies.update(policy.id, {
        name: name.trim(),
        duration: durationSeconds,
        offlineGracePeriod: offlineGraceSeconds,
        maxMachines: Number(maxMachines),
        scheme,
        strict,
        features: featuresArray,
        metadata,
        isActive,
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to update policy");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete policy "${policy.name}"? This action cannot be undone.`)) {
      return;
    }

    setError(null);
    setDeleteLoading(true);

    try {
      await api.policies.delete(policy.id);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to delete policy");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl text-slate-100 overflow-hidden animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Edit3 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base text-white">Edit Licensing Policy</h3>
              <p className="text-xs text-slate-400 font-mono">{policy.id}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg text-xs leading-relaxed">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Policy Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Duration & Billing Model</label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <button
                type="button"
                onClick={() => setDurationType("period")}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-medium border transition-colors ${
                  durationType === "period"
                    ? "bg-indigo-600/20 border-indigo-500 text-indigo-300"
                    : "bg-slate-950 border-slate-800 text-slate-400 hover:text-white"
                }`}
              >
                <Clock className="w-3.5 h-3.5" />
                <span>Expiring / Subscription</span>
              </button>
              <button
                type="button"
                onClick={() => setDurationType("perpetual")}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-medium border transition-colors ${
                  durationType === "perpetual"
                    ? "bg-indigo-600/20 border-indigo-500 text-indigo-300"
                    : "bg-slate-950 border-slate-800 text-slate-400 hover:text-white"
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Perpetual (Lifetime)</span>
              </button>
            </div>
            {durationType === "period" && (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value))}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                />
                <span className="text-xs text-slate-400 shrink-0">Days</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1 flex items-center gap-1">
                <Monitor className="w-3.5 h-3.5 text-indigo-400" />
                Max Devices (Seats)
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={maxMachines}
                onChange={(e) => setMaxMachines(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Offline Grace (Days)</label>
              <input
                type="number"
                min={1}
                value={offlineGraceDays}
                onChange={(e) => setOfflineGraceDays(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Feature Entitlements (Comma-separated)</label>
            <input
              type="text"
              value={featuresText}
              onChange={(e) => setFeaturesText(e.target.value)}
              placeholder="feature_a, feature_b"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 mt-1">Comma-separated tags (e.g. feature_a, feature_b). Included in signed tokens.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Stripe Price ID</label>
              <input
                type="text"
                value={stripePriceId}
                onChange={(e) => setStripePriceId(e.target.value)}
                placeholder="price_..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Paddle Price ID</label>
              <input
                type="text"
                value={paddlePriceId}
                onChange={(e) => setPaddlePriceId(e.target.value)}
                placeholder="pri_..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
          </div>

          <div className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-lg">
            <div>
              <div className="text-xs font-medium text-white">Policy Active Status</div>
              <div className="text-[11px] text-slate-400">Inactive policies cannot be used to issue new licenses.</div>
            </div>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded bg-slate-800 border-slate-700 text-indigo-600 focus:ring-0 cursor-pointer h-4 w-4"
            />
          </div>

          <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteLoading}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
            >
              {deleteLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              <span>Delete Policy</span>
            </button>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 rounded-lg transition-colors border border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !name.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg transition-colors shadow"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>{loading ? "Saving..." : "Save Changes"}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

import React, { useState } from "react";
import { api } from "../../lib/api-client";
import { X, FileCheck2, Loader2, ShieldCheck, Clock, Monitor } from "lucide-react";

interface CreatePolicyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  products: Array<{ id: string; name: string }>;
}

export const CreatePolicyModal: React.FC<CreatePolicyModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  products,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [productId, setProductId] = useState(products[0]?.id || "");
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

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const targetProductId = productId || products[0]?.id;
    if (!targetProductId) {
      setError("Please select or create a product first");
      setLoading(false);
      return;
    }

    try {
      const durationSeconds =
        durationType === "perpetual" ? null : durationDays * 86400;
      const offlineGraceSeconds = offlineGraceDays * 86400;

      const featuresArray = featuresText
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);

      const metadata: Record<string, string> = {};
      if (stripePriceId.trim()) metadata.stripe_price_id = stripePriceId.trim();
      if (paddlePriceId.trim()) metadata.paddle_price_id = paddlePriceId.trim();

      await api.policies.create({
        productId: targetProductId,
        name: name.trim(),
        duration: durationSeconds,
        offlineGracePeriod: offlineGraceSeconds,
        maxMachines: Number(maxMachines),
        scheme,
        strict,
        features: featuresArray,
        metadata,
      });

      onSuccess();
      handleClose();
    } catch (err: any) {
      setError(err.message || "Failed to create policy");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setName("");
    setDurationType("period");
    setDurationDays(365);
    setMaxMachines(3);
    setOfflineGraceDays(30);
    setFeaturesText("");
    setStripePriceId("");
    setPaddlePriceId("");
    setError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl text-slate-100 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <FileCheck2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base text-white">Create Licensing Policy</h3>
              <p className="text-xs text-slate-400">Define seat limits, duration, and offline verification rules</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg text-xs">
              {error}
            </div>
          )}

          {/* Product Selector */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Associated Product <span className="text-red-400">*</span>
            </label>
            <select
              value={productId || products[0]?.id || ""}
              onChange={(e) => setProductId(e.target.value)}
              required
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Policy Name */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Policy Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Professional Annual (3 Seats)"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Duration Type */}
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
                <span>Subscription / Expiring</span>
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
                <span className="text-xs text-slate-400 shrink-0">Days (e.g. 365)</span>
              </div>
            )}
          </div>

          {/* Machine Seats & Grace Period */}
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
              <p className="text-[11px] text-slate-500 mt-1">Simultaneous machine limit</p>
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
              <p className="text-[11px] text-slate-500 mt-1">Max offline valid window</p>
            </div>
          </div>

          {/* Scheme Selection */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Verification Scheme</label>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer text-xs transition-colors ${
                  scheme === "ed25519"
                    ? "bg-indigo-600/15 border-indigo-500 text-indigo-200"
                    : "bg-slate-950 border-slate-800 text-slate-400"
                }`}
              >
                <input
                  type="radio"
                  name="scheme"
                  value="ed25519"
                  checked={scheme === "ed25519"}
                  onChange={() => setScheme("ed25519")}
                  className="hidden"
                />
                <div>
                  <div className="font-semibold text-white">Ed25519 (Recommended)</div>
                  <div className="text-[10px] text-slate-400">Offline Asymmetric Token</div>
                </div>
              </label>

              <label
                className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer text-xs transition-colors ${
                  scheme === "guid"
                    ? "bg-indigo-600/15 border-indigo-500 text-indigo-200"
                    : "bg-slate-950 border-slate-800 text-slate-400"
                }`}
              >
                <input
                  type="radio"
                  name="scheme"
                  value="guid"
                  checked={scheme === "guid"}
                  onChange={() => setScheme("guid")}
                  className="hidden"
                />
                <div>
                  <div className="font-semibold text-white">Online GUID</div>
                  <div className="text-[10px] text-slate-400">Pure Online Verification</div>
                </div>
              </label>
            </div>
          </div>

          {/* Feature Entitlements */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Feature Entitlements <span className="text-slate-500 font-normal">(Optional, comma-separated)</span>
            </label>
            <input
              type="text"
              value={featuresText}
              onChange={(e) => setFeaturesText(e.target.value)}
              placeholder="feature_a, feature_b"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 mt-1">Comma-separated tags (e.g. feature_a, feature_b). Included in signed tokens.</p>
          </div>

          {/* Payment Gateway Price ID Bindings */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Stripe Price ID <span className="text-slate-500 font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                value={stripePriceId}
                onChange={(e) => setStripePriceId(e.target.value)}
                placeholder="price_1Ov..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Paddle Price ID <span className="text-slate-500 font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                value={paddlePriceId}
                onChange={(e) => setPaddlePriceId(e.target.value)}
                placeholder="pri_01j..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
          </div>

          {/* Strict Mode Toggle */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-slate-300">Strict Enforcement (Block activations beyond limit)</span>
            <input
              type="checkbox"
              checked={strict}
              onChange={(e) => setStrict(e.target.checked)}
              className="rounded bg-slate-800 border-slate-700 text-indigo-600 focus:ring-0 cursor-pointer"
            />
          </div>

          {/* Action Buttons */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={handleClose}
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
              <span>{loading ? "Creating..." : "Create Policy"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

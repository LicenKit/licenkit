import React, { useState, useEffect } from "react";
import { api } from "../../lib/api-client";
import { X, Key, Loader2, Sparkles, Check, Copy } from "lucide-react";

interface IssueLicenseModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  products: Array<{ id: string; name: string }>;
  policies: Array<{ id: string; name: string; productId?: string }>;
}

export const IssueLicenseModal: React.FC<IssueLicenseModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  products,
  policies,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [productId, setProductId] = useState(products[0]?.id || "");
  const [policyId, setPolicyId] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customKey, setCustomKey] = useState("");

  // Result state
  const [issuedLicense, setIssuedLicense] = useState<{
    key: string;
    customerEmail: string;
    expiresAt: string | null;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Filter policies by selected product
  const currentPolicies = policies.filter(
    (p: any) => !productId || p.productId === productId
  );

  useEffect(() => {
    if (products.length > 0 && !productId) {
      setProductId(products[0].id);
    }
  }, [products, productId]);

  useEffect(() => {
    const matching = policies.filter((p: any) => !productId || p.productId === productId);
    if (matching.length > 0) {
      if (!policyId || !matching.some((m) => m.id === policyId)) {
        setPolicyId(matching[0].id);
      }
    } else {
      setPolicyId("");
    }
  }, [productId, policies]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (!policyId) {
      setError("Please create and select a policy for this product first");
      setLoading(false);
      return;
    }

    try {
      const res = await api.licenses.issue({
        productId,
        policyId,
        customerEmail: customerEmail.trim().toLowerCase(),
        key: customKey.trim() || undefined,
        metadata: { source: "manual_console_issuance" },
      });

      setIssuedLicense(res);
      onSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to issue license");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyKey = () => {
    if (!issuedLicense?.key) return;
    navigator.clipboard.writeText(issuedLicense.key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleClose = () => {
    setIssuedLicense(null);
    setCustomerEmail("");
    setCustomKey("");
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
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base text-white">Issue License Key</h3>
              <p className="text-xs text-slate-400">Generate and assign a commercial license to a customer</p>
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
        <div className="p-6">
          {issuedLicense ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
                <div className="text-sm font-semibold text-emerald-200 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  License Key Issued Successfully!
                </div>
                <div className="text-xs text-emerald-300/80 mt-1">
                  Customer Email: <span className="font-medium text-white">{issuedLicense.customerEmail}</span>
                </div>
                {issuedLicense.expiresAt ? (
                  <div className="text-xs text-emerald-300/80 mt-0.5">
                    Expires: {new Date(issuedLicense.expiresAt).toLocaleDateString()}
                  </div>
                ) : (
                  <div className="text-xs text-emerald-300/80 mt-0.5">Duration: Perpetual (Lifetime)</div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  License Key
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={issuedLicense.key}
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-indigo-300 font-mono select-all focus:outline-none"
                  />
                  <button
                    onClick={handleCopyKey}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs text-white rounded-lg font-medium transition-colors shadow"
                  >
                    {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedKey ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={handleClose}
                  className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white rounded-lg transition-colors border border-slate-700"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg text-xs">
                  {error}
                </div>
              )}

              {/* Product Selection */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Product <span className="text-red-400">*</span>
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

              {/* Policy Selection */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Licensing Policy <span className="text-red-400">*</span>
                </label>
                {currentPolicies.length === 0 ? (
                  <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs rounded-lg">
                    No policies found for this product. Please create a policy first.
                  </div>
                ) : (
                  <select
                    value={policyId}
                    onChange={(e) => setPolicyId(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    {currentPolicies.map((pol) => (
                      <option key={pol.id} value={pol.id}>
                        {pol.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Customer Email */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Customer Email <span className="text-red-400">*</span>
                </label>
                <input
                  type="email"
                  required
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  placeholder="buyer@example.com"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Custom Key (Optional) */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Custom License Key <span className="text-slate-500 font-normal">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder="Leave blank to auto-generate (LIC-XXXX-XXXX-XXXX-XXXX)"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
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
                  disabled={loading || !customerEmail.trim() || !policyId}
                  className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg transition-colors shadow"
                >
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  <span>{loading ? "Issuing..." : "Issue License"}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

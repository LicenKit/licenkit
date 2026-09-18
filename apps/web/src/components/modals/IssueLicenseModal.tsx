import React, { useState, useEffect } from "react";
import { api } from "../../lib/api-client";
import { escapeCsvCell } from "../../lib/csv";
import { X, Key, Loader2, Sparkles, Check, Copy, Download, Layers, AlertCircle } from "lucide-react";

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
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [productId, setProductId] = useState(products[0]?.id || "");
  const [policyId, setPolicyId] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [batchCount, setBatchCount] = useState<number>(5);

  // Result state
  const [issuedLicense, setIssuedLicense] = useState<{
    key: string;
    customerEmail?: string | null;
    expiresAt: string | null;
  } | null>(null);

  const [issuedBatch, setIssuedBatch] = useState<{
    items: any[];
    requestedCount: number;
    actualCount: number;
    notice: string | null;
    batchId: string;
  } | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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

  const downloadBatchCsv = (items: any[], batchId: string) => {
    const headers = ["License Key", "Product", "Policy", "Customer Email", "Status", "Expires At", "Created At"];
    const rows = items.map((it) => [
      escapeCsvCell(it.key),
      escapeCsvCell(it.productName),
      escapeCsvCell(it.policyName),
      escapeCsvCell(it.customerEmail || ""),
      escapeCsvCell(it.status),
      escapeCsvCell(it.expiresAt || "Perpetual"),
      escapeCsvCell(it.createdAt),
    ]);
    const csvContent = "\uFEFF" + [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `batch-${batchId.slice(0, 16)}-licenses.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (!policyId) {
      setError("Please create and select a policy for this product first");
      setLoading(false);
      return;
    }

    const email = customerEmail.trim() ? customerEmail.trim().toLowerCase() : undefined;

    try {
      if (mode === "single") {
        const res = await api.licenses.issue({
          productId,
          policyId,
          customerEmail: email,
          metadata: { source: "manual_console_issuance" },
        });

        setIssuedLicense(res);
        onSuccess();
      } else {
        const res = await api.licenses.batchIssue({
          productId,
          policyId,
          count: batchCount,
          customerEmail: email,
          metadata: { source: "manual_console_batch" },
        });

        setIssuedBatch(res);
        if (res.items && res.items.length > 0) {
          downloadBatchCsv(res.items, res.batchId);
        }
        onSuccess();
      }
    } catch (err: any) {
      setError(err.message || "Failed to issue license");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleClose = () => {
    setIssuedLicense(null);
    setIssuedBatch(null);
    setCustomerEmail("");
    setBatchCount(5);
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
              {mode === "batch" ? <Layers className="w-4 h-4" /> : <Key className="w-4 h-4" />}
            </div>
            <div>
              <h3 className="font-semibold text-base text-white">
                {mode === "batch" ? "Batch Issue Licenses" : "Issue License Key"}
              </h3>
              <p className="text-xs text-slate-400">
                {mode === "batch"
                  ? "Generate pre-fabricated licenses (max 10) & auto-export CSV"
                  : "Generate and assign a commercial license to a customer"}
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Selector Tabs (only when not showing results) */}
        {!issuedLicense && !issuedBatch && (
          <div className="px-6 pt-3 flex gap-2 border-b border-slate-800/80 bg-slate-950/40">
            <button
              type="button"
              onClick={() => setMode("single")}
              className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-colors ${
                mode === "single"
                  ? "border-indigo-500 text-indigo-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              Single License
            </button>
            <button
              type="button"
              onClick={() => setMode("batch")}
              className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                mode === "batch"
                  ? "border-indigo-500 text-indigo-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Batch Issue (Max 10)</span>
            </button>
          </div>
        )}

        {/* Body */}
        <div className="p-6">
          {/* 1. Single Result View */}
          {issuedLicense && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
                <div className="text-sm font-semibold text-emerald-200 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  License Key Issued Successfully!
                </div>
                <div className="text-xs text-emerald-300/80 mt-1">
                  Customer Email:{" "}
                  <span className="font-medium text-white">
                    {issuedLicense.customerEmail || "Unassigned"}
                  </span>
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
                    onClick={() => handleCopyKey(issuedLicense.key)}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs text-white rounded-lg font-medium transition-colors shadow"
                  >
                    {copiedKey === issuedLicense.key ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedKey === issuedLicense.key ? "Copied" : "Copy"}</span>
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
          )}

          {/* 2. Batch Result View */}
          {issuedBatch && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
                <div className="text-sm font-semibold text-emerald-200 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-emerald-400" />
                    Batch Generated Successfully!
                  </span>
                  <span className="text-xs bg-emerald-500/20 px-2 py-0.5 rounded font-mono">
                    {issuedBatch.actualCount} Keys Generated
                  </span>
                </div>
                <div className="text-xs text-emerald-300/80 mt-1">
                  CSV file has been triggered for auto-download.
                </div>
              </div>

              {/* Truncation warning if applicable */}
              {issuedBatch.notice && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
                  <div>
                    <span className="font-semibold">Quota Auto-Truncation: </span>
                    {issuedBatch.notice}
                  </div>
                </div>
              )}

              {/* Generated Keys List */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-medium text-slate-400">
                  <span>Generated Keys Preview</span>
                  <button
                    onClick={() => downloadBatchCsv(issuedBatch.items, issuedBatch.batchId)}
                    className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 font-medium"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download CSV Again</span>
                  </button>
                </div>
                <div className="max-h-48 overflow-y-auto space-y-1.5 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
                  {issuedBatch.items.map((it: any) => (
                    <div
                      key={it.id}
                      className="flex items-center justify-between bg-slate-900/80 px-3 py-1.5 rounded-lg border border-slate-800 text-xs font-mono text-indigo-300"
                    >
                      <span>{it.key}</span>
                      <button
                        onClick={() => handleCopyKey(it.key)}
                        title="Copy Key"
                        className="text-slate-500 hover:text-slate-300 p-1"
                      >
                        {copiedKey === it.key ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  ))}
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
          )}

          {/* 3. Form Input View */}
          {!issuedLicense && !issuedBatch && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg text-xs">
                  {error}
                </div>
              )}

              {/* Mode-specific guidance */}
              {mode === "batch" && (
                <div className="p-3 bg-slate-800/60 border border-slate-700/60 rounded-xl text-xs text-slate-400 space-y-1">
                  <div className="font-semibold text-slate-200">Batch Issuance Policy:</div>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] text-slate-400">
                    <li>Single batch generates up to 10 keys.</li>
                    <li>Unused manual keys cap at 100 (auto-truncated if quota reached).</li>
                    <li>Unused keys older than 30 days are automatically revoked.</li>
                  </ul>
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

              {/* Batch Count (Batch Mode only) */}
              {mode === "batch" && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Batch Count <span className="text-slate-500 font-normal">(1 to 10 keys)</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={batchCount}
                    onChange={(e) => setBatchCount(Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                    required
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              )}

              {/* Customer Email (Optional in both modes) */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Customer Email <span className="text-slate-500 font-normal">(Optional)</span>
                </label>
                <input
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  placeholder={mode === "batch" ? "Leave blank for unassigned channel distribution" : "buyer@example.com (optional)"}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
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
                  disabled={loading || !policyId}
                  className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg transition-colors shadow cursor-pointer"
                >
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  <span>{loading ? "Generating..." : mode === "batch" ? `Generate ${batchCount} Keys & Export` : "Issue License"}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

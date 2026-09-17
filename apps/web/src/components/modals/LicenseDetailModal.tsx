import React, { useState, useEffect } from "react";
import { api } from "../../lib/api-client";
import {
  X,
  Key,
  Copy,
  Check,
  RotateCcw,
  Ban,
  ShieldCheck,
  Monitor,
  Calendar,
  AlertTriangle,
  Loader2,
  Trash2,
} from "lucide-react";

interface LicenseDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  licenseId: string | null;
  readOnly?: boolean;
}

export const LicenseDetailModal: React.FC<LicenseDetailModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  licenseId,
  readOnly = false,
}) => {
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Extend expiration state
  const [isEditingExpiry, setIsEditingExpiry] = useState(false);
  const [newExpiryDate, setNewExpiryDate] = useState("");

  useEffect(() => {
    if (isOpen && licenseId) {
      loadDetails();
    } else {
      setData(null);
      setError(null);
      setIsEditingExpiry(false);
    }
  }, [isOpen, licenseId]);

  const loadDetails = async () => {
    if (!licenseId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.licenses.get(licenseId);
      setData(res);
      if (res.expiresAt) {
        const d = new Date(res.expiresAt);
        setNewExpiryDate(d.toISOString().slice(0, 10));
      } else {
        setNewExpiryDate("");
      }
    } catch (err: any) {
      setError(err.message || "Failed to load license details");
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !licenseId) return null;

  const handleCopyKey = () => {
    if (!data?.key) return;
    navigator.clipboard.writeText(data.key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleUnbindMachine = async (machineId: string, machineName: string) => {
    if (!window.confirm(`Unbind machine "${machineName || machineId}" from this license? The seat will be immediately freed.`)) {
      return;
    }

    setActionLoading(true);
    try {
      await api.licenses.unbindMachine(licenseId, machineId);
      await loadDetails();
      onSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to unbind machine");
    } finally {
      setActionLoading(false);
    }
  };

  const handleRotateKey = async () => {
    if (!window.confirm("Are you sure you want to rotate this license key? The old key will be permanently invalidated and all currently activated devices will be unregistered.")) {
      return;
    }

    setActionLoading(true);
    try {
      await api.licenses.rotateKey(licenseId);
      await loadDetails();
      onSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to rotate key");
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleSuspend = async () => {
    if (!data) return;
    setActionLoading(true);
    try {
      if (data.status === "active") {
        await api.licenses.suspend(licenseId);
      } else {
        await api.licenses.reinstate(licenseId);
      }
      await loadDetails();
      onSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to update license status");
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevoke = async () => {
    const reason = window.prompt(
      "DANGER: Are you sure you want to permanently revoke this license? This will kick all devices.\n\nEnter revocation reason (optional):",
      "Manual revocation"
    );
    if (reason === null) {
      return;
    }

    setActionLoading(true);
    try {
      await api.licenses.revoke(licenseId, reason.trim() || undefined);
      await loadDetails();
      onSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to revoke license");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveExpiry = async () => {
    setActionLoading(true);
    try {
      const expiresAt = newExpiryDate ? new Date(newExpiryDate).toISOString() : null;
      await api.licenses.update(licenseId, { expiresAt });
      setIsEditingExpiry(false);
      await loadDetails();
      onSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to update expiration date");
    } finally {
      setActionLoading(false);
    }
  };

  const machines = data?.machines || [];
  const maxMachines = data?.maxMachines || 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl text-slate-100 overflow-hidden animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base text-white">License Details & Device Seats</h3>
              <p className="text-xs text-slate-400 font-mono">{licenseId}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg text-xs leading-relaxed">
              {error}
            </div>
          )}

          {loading || !data ? (
            <div className="py-12 flex flex-col items-center justify-center text-slate-400 gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
              <span className="text-xs">Loading license and seat data...</span>
            </div>
          ) : (
            <>
              {/* Top Summary Card */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">License Key</span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                      data.status === "active"
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        : data.status === "suspended"
                        ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                        : "bg-red-500/20 text-red-300 border border-red-500/30"
                    }`}
                  >
                    {data.status}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={data.key}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-indigo-300 font-mono font-medium select-all focus:outline-none"
                  />
                  <button
                    onClick={handleCopyKey}
                    className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs text-white rounded-lg font-medium transition-colors shadow shrink-0"
                  >
                    {copiedKey ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedKey ? "Copied" : "Copy"}</span>
                  </button>
                  {!readOnly && (
                    <button
                      onClick={handleRotateKey}
                      disabled={actionLoading}
                      title="Rotate Key (Invalidate old key & kick devices)"
                      className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 hover:text-white rounded-lg font-medium transition-colors border border-slate-700 shrink-0"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                      <span>Rotate Key</span>
                    </button>
                  )}
                </div>

                {/* Metadata Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs border-t border-slate-800/80">
                  <div>
                    <span className="text-slate-500 block">Customer</span>
                    <span className="text-slate-200 font-medium truncate block">
                      {data.customerEmail || <span className="text-slate-500 italic">Unassigned</span>}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Product</span>
                    <span className="text-slate-200 font-medium truncate block">{data.productName || "Unknown"}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Policy</span>
                    <span className="text-slate-200 font-medium truncate block">{data.policyName || "Unknown"}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Seat Limit</span>
                    <span className="text-slate-200 font-medium">
                      {machines.length} / {maxMachines} Devices
                    </span>
                  </div>
                </div>

                {data.status === "revoked" && data.revokeReason && (
                  <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
                    <span className="font-semibold">Revocation Reason: </span>
                    <span className="font-mono">{data.revokeReason}</span>
                  </div>
                )}

                {/* Expiration bar */}
                <div className="pt-2 flex items-center justify-between text-xs border-t border-slate-800/80">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    <span className="text-slate-400">Expires:</span>
                    {isEditingExpiry ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="date"
                          value={newExpiryDate}
                          onChange={(e) => setNewExpiryDate(e.target.value)}
                          className="bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                        />
                        <button
                          onClick={handleSaveExpiry}
                          disabled={actionLoading}
                          className="px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[11px]"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setIsEditingExpiry(false)}
                          className="px-2 py-0.5 bg-slate-800 text-slate-300 rounded text-[11px]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <span className="text-white font-medium">
                        {data.expiresAt
                          ? new Date(data.expiresAt).toLocaleDateString()
                          : "Perpetual (Lifetime)"}
                      </span>
                    )}
                  </div>
                  {!readOnly && !isEditingExpiry && (
                    <button
                      onClick={() => setIsEditingExpiry(true)}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 underline"
                    >
                      Adjust Expiration
                    </button>
                  )}
                </div>
              </div>

              {/* Bound Machines (Seats) Management */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    <Monitor className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Active Device Seats ({machines.length} / {maxMachines})</span>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    {maxMachines - machines.length} seat(s) remaining
                  </span>
                </div>

                {machines.length === 0 ? (
                  <div className="p-6 bg-slate-950/40 border border-dashed border-slate-800 rounded-xl text-center">
                    <p className="text-xs text-slate-400">
                      No machines have activated with this license key yet.
                    </p>
                  </div>
                ) : (
                  <div className="bg-slate-950/80 border border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-800/80">
                    {machines.map((m: any) => (
                      <div key={m.id} className="p-3.5 flex items-center justify-between hover:bg-slate-900/50 transition-colors">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">{m.name || "Unnamed Device"}</span>
                            {m.platform && (
                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 font-mono">
                                {m.platform}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono truncate max-w-sm">
                            Fingerprint: {m.fingerprint}
                          </div>
                          <div className="text-[11px] text-slate-500 flex items-center gap-3">
                            <span>IP: {m.ip || "unknown"}</span>
                            <span>
                              Last Heartbeat: {new Date(m.lastHeartbeatAt).toLocaleString()}
                            </span>
                          </div>
                        </div>

                        {!readOnly && (
                          <button
                            onClick={() => handleUnbindMachine(m.id, m.name)}
                            disabled={actionLoading}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors border border-red-500/20"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Unbind Seat</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Danger Zone Actions */}
              <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {!readOnly && (
                    <>
                      <button
                        onClick={handleToggleSuspend}
                        disabled={actionLoading}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          data.status === "active"
                            ? "bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-amber-500/30"
                            : "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                        }`}
                      >
                        {data.status === "active" ? "Suspend License" : "Reinstate License"}
                      </button>

                      {data.status !== "revoked" && (
                        <button
                          onClick={handleRevoke}
                          disabled={actionLoading}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/30 transition-colors"
                        >
                          Revoke Permanently
                        </button>
                      )}
                    </>
                  )}
                </div>

                <button
                  onClick={onClose}
                  className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white rounded-lg transition-colors border border-slate-700"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

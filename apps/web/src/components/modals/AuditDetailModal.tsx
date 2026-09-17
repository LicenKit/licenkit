import React, { useState } from "react";
import { X, Copy, Check, ShieldCheck, Terminal, Globe, Calendar, User } from "lucide-react";

interface AuditDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  auditLog: any | null;
}

export const AuditDetailModal: React.FC<AuditDetailModalProps> = ({
  isOpen,
  onClose,
  auditLog,
}) => {
  const [copiedJson, setCopiedJson] = useState(false);

  if (!isOpen || !auditLog) return null;

  const jsonString = JSON.stringify(auditLog.details || {}, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonString);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  const getActionBadgeClass = (action: string) => {
    if (action.includes("delete") || action.includes("revoke")) {
      return "bg-rose-500/10 text-rose-400 border-rose-500/30";
    }
    if (action.includes("create") || action.includes("reinstate")) {
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
    }
    if (action.includes("update") || action.includes("rotate")) {
      return "bg-sky-500/10 text-sky-400 border-sky-500/30";
    }
    if (action.includes("suspend")) {
      return "bg-amber-500/10 text-amber-400 border-amber-500/30";
    }
    return "bg-purple-500/10 text-purple-400 border-purple-500/30";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Audit Event Details</h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">{auditLog.id}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 gap-4 bg-slate-800/40 p-4 rounded-xl border border-slate-700/50">
            <div>
              <div className="text-xs font-medium text-slate-400 mb-1 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5" /> Action
              </div>
              <span
                className={`inline-block text-xs px-2.5 py-0.5 rounded-md font-mono font-medium border ${getActionBadgeClass(
                  auditLog.action
                )}`}
              >
                {auditLog.action}
              </span>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-400 mb-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" /> Timestamp
              </div>
              <div className="text-xs font-mono text-slate-200">
                {new Date(auditLog.createdAt).toLocaleString()}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-400 mb-1 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" /> Operator
              </div>
              <div className="text-xs text-slate-200 font-medium">{auditLog.userEmail}</div>
              <div className="text-[10px] text-slate-500 font-mono">{auditLog.userId}</div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-400 mb-1 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5" /> Origin
              </div>
              <div className="text-xs font-mono text-slate-200">{auditLog.ip || "unknown"}</div>
              <div className="text-[10px] text-slate-500 truncate max-w-[200px]" title={auditLog.userAgent}>
                {auditLog.userAgent || "unknown"}
              </div>
            </div>

            {auditLog.resourceId && (
              <div className="col-span-2 pt-2 border-t border-slate-700/40">
                <div className="text-xs font-medium text-slate-400 mb-1">Target Resource</div>
                <div className="text-xs font-mono text-indigo-300">
                  <span className="text-slate-400 capitalize">{auditLog.resourceType}: </span>
                  {auditLog.resourceId}
                </div>
              </div>
            )}
          </div>

          {/* JSON Payload Details */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-indigo-400" /> Event Details & Change Snapshot
              </span>
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors cursor-pointer"
              >
                {copiedJson ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" /> Copied JSON
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" /> Copy JSON
                  </>
                )}
              </button>
            </div>
            <pre className="p-4 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300 overflow-x-auto max-h-60 leading-relaxed select-all">
              {jsonString}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-slate-800 bg-slate-900/50">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium rounded-xl transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

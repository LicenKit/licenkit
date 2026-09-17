import React, { useState } from "react";
import { api } from "../../lib/api-client";
import { X, UserPlus, Loader2, AlertCircle, Shield, User } from "lucide-react";

interface CreateUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const CreateUserModal: React.FC<CreateUserModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  if (!isOpen) return null;

  const handleResetAndClose = () => {
    setName("");
    setEmail("");
    setPassword("");
    setRole("member");
    setError(null);
    setLoading(false);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Please enter member name");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters long");
      return;
    }

    setLoading(true);
    try {
      await api.users.create({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        role,
      });

      onSuccess();
      handleResetAndClose();
    } catch (err: any) {
      setError(err.message || "Failed to create team member");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-400">
              <UserPlus className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Add Team Member</h3>
              <p className="text-xs text-slate-400">Invite a collaborator to access the dashboard</p>
            </div>
          </div>
          <button
            onClick={handleResetAndClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/80 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl flex items-center gap-2.5 text-xs text-rose-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Full Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Alex Cooper"
              className="w-full px-3.5 py-2 bg-slate-800/70 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 transition-all"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Email Address</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alex@example.com"
              className="w-full px-3.5 py-2 bg-slate-800/70 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 transition-all"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Initial Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full px-3.5 py-2 bg-slate-800/70 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 transition-all"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Role & Permissions</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setRole("admin")}
                className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all ${
                  role === "admin"
                    ? "bg-indigo-600/15 border-indigo-500 text-white"
                    : "bg-slate-800/40 border-slate-700/60 text-slate-400 hover:border-slate-600"
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Shield className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Admin</span>
                </div>
                <span className="text-[11px] text-slate-400 leading-tight">
                  Full access to products, licenses, and webhooks.
                </span>
              </button>

              <button
                type="button"
                onClick={() => setRole("member")}
                className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all ${
                  role === "member"
                    ? "bg-indigo-600/15 border-indigo-500 text-white"
                    : "bg-slate-800/40 border-slate-700/60 text-slate-400 hover:border-slate-600"
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <User className="w-3.5 h-3.5 text-slate-400" />
                  <span>Member</span>
                </div>
                <span className="text-[11px] text-slate-400 leading-tight">
                  Read-only view of dashboard stats and licenses.
                </span>
              </button>
            </div>
          </div>

          <div className="pt-2 flex justify-end gap-2.5">
            <button
              type="button"
              onClick={handleResetAndClose}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white bg-slate-800/80 hover:bg-slate-800 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-xl shadow-md shadow-indigo-600/20 disabled:opacity-50 transition-all cursor-pointer"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{loading ? "Adding..." : "Add Member"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

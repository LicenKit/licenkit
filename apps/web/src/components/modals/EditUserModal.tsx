import React, { useState, useEffect } from "react";
import { api } from "../../lib/api-client";
import { X, UserCog, Loader2, AlertCircle, Shield, User, CheckCircle, Ban, Key } from "lucide-react";

interface EditUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  userToEdit: {
    id: string;
    name: string;
    email: string;
    role: string;
    isActive: boolean;
  } | null;
  currentUserId: string;
}

export const EditUserModal: React.FC<EditUserModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  userToEdit,
  currentUserId,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [isActive, setIsActive] = useState(true);
  const [newPassword, setNewPassword] = useState("");

  const isSelf = userToEdit?.id === currentUserId;
  const isOwner = userToEdit?.role === "owner";

  useEffect(() => {
    if (userToEdit) {
      setName(userToEdit.name || "");
      setRole((userToEdit.role as "admin" | "member") || "member");
      setIsActive(userToEdit.isActive !== false);
      setNewPassword("");
      setError(null);
    }
  }, [userToEdit]);

  if (!isOpen || !userToEdit) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Please enter member name");
      return;
    }
    if (newPassword && newPassword.length < 8) {
      setError("New password must be at least 8 characters long");
      return;
    }

    setLoading(true);
    try {
      const payload: any = {
        name: name.trim(),
      };

      // Only allow changing role if target is not owner
      if (!isOwner) {
        payload.role = role;
      }

      // Only allow changing active status if not self
      if (!isSelf) {
        payload.isActive = isActive;
      }

      // Only update password if provided
      if (newPassword.trim()) {
        payload.password = newPassword.trim();
      }

      await api.users.update(userToEdit.id, payload);

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to update member");
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
              <UserCog className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Edit Member</h3>
              <p className="text-xs text-slate-400">{userToEdit.email}</p>
            </div>
          </div>
          <button
            onClick={onClose}
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
              placeholder="Full Name"
              className="w-full px-3.5 py-2 bg-slate-800/70 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 transition-all"
            />
          </div>

          {!isOwner && (
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
                    Full management of licenses and products.
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
                    Read-only view of dashboard and stats.
                  </span>
                </button>
              </div>
            </div>
          )}

          {!isSelf && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Account Status</label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setIsActive(true)}
                  className={`p-3 rounded-xl border text-left flex items-center gap-2 transition-all ${
                    isActive
                      ? "bg-emerald-500/15 border-emerald-500/60 text-emerald-400"
                      : "bg-slate-800/40 border-slate-700/60 text-slate-400 hover:border-slate-600"
                  }`}
                >
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span className="text-xs font-medium">Active</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsActive(false)}
                  className={`p-3 rounded-xl border text-left flex items-center gap-2 transition-all ${
                    !isActive
                      ? "bg-amber-500/15 border-amber-500/60 text-amber-400"
                      : "bg-slate-800/40 border-slate-700/60 text-slate-400 hover:border-slate-600"
                  }`}
                >
                  <Ban className="w-4 h-4 shrink-0" />
                  <span className="text-xs font-medium">Suspended</span>
                </button>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Reset Password <span className="text-slate-500 font-normal">(Optional)</span>
            </label>
            <div className="relative">
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Leave blank to keep current password"
                className="w-full pl-9 pr-3.5 py-2 bg-slate-800/70 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 transition-all"
              />
              <Key className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
            </div>
          </div>

          <div className="pt-2 flex justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
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
              <span>{loading ? "Saving..." : "Save Changes"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

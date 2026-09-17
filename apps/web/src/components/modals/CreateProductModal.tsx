import React, { useState } from "react";
import { api } from "../../lib/api-client";
import {
  X,
  KeyRound,
  Copy,
  Check,
  ShieldCheck,
  Sparkles,
  Loader2,
  Download,
  AlertTriangle,
  UploadCloud,
  Eye,
  EyeOff,
  Lock,
} from "lucide-react";

interface CreateProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const CreateProductModal: React.FC<CreateProductModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trialDays, setTrialDays] = useState(14);
  const [trialFeatures, setTrialFeatures] = useState("");
  const [keyMode, setKeyMode] = useState<"auto" | "upload">("auto");
  const [uploadPrivateKey, setUploadPrivateKey] = useState("");
  const [uploadPublicKey, setUploadPublicKey] = useState("");

  // Result state when creation succeeds
  const [createdProduct, setCreatedProduct] = useState<{
    id: string;
    name: string;
    publicKey: string;
    privateKey?: string;
    keySource?: "platform" | "uploaded";
    kid?: string;
  } | null>(null);

  const [copiedPublic, setCopiedPublic] = useState(false);
  const [copiedPrivate, setCopiedPrivate] = useState(false);
  const [hasDownloadedKey, setHasDownloadedKey] = useState(false);
  const [showPrivateKeyText, setShowPrivateKeyText] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const featuresArray = trialFeatures
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);

      const payload: any = {
        name: name.trim(),
        description: description.trim() || undefined,
        trialDays: Number(trialDays),
        trialFeatures: featuresArray,
        keyMode,
      };

      if (keyMode === "upload") {
        if (!uploadPrivateKey.trim()) {
          throw new Error("Please provide your Ed25519 private key (PEM or Base64).");
        }
        if (!uploadPublicKey.trim()) {
          throw new Error("Please provide the matching Ed25519 public key (PEM or Base64).");
        }
        payload.privateKey = uploadPrivateKey.trim();
        payload.publicKey = uploadPublicKey.trim();
      }

      const res = await api.products.create(payload);

      setCreatedProduct({
        id: res.id,
        name: res.name,
        publicKey: res.publicKey,
        privateKey: res.privateKey,
        keySource: res.keySource,
        kid: res.kid,
      });
      setHasDownloadedKey(false);
      onSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to create product");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadKey = () => {
    if (!createdProduct?.privateKey) return;
    const raw = createdProduct.privateKey;
    const pem = raw.includes("BEGIN PRIVATE KEY")
      ? raw
      : `-----BEGIN PRIVATE KEY-----\n${raw.match(/.{1,64}/g)?.join("\n") || raw}\n-----END PRIVATE KEY-----\n`;

    const blob = new Blob([pem], { type: "application/x-pem-file;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const dateStr = `${year}${month}${day}`;

    const safeName =
      createdProduct.name
        .trim()
        .toLowerCase()
        .replace(/[\s/\\?%*:|"<>]+/g, "-")
        .replace(/^-+|-+$/g, "") || "product";

    a.href = url;
    a.download = `licenkit-${safeName}-private-key-${dateStr}.key`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setHasDownloadedKey(true);
  };

  const handleCopyPublic = () => {
    if (!createdProduct?.publicKey) return;
    navigator.clipboard.writeText(createdProduct.publicKey);
    setCopiedPublic(true);
    setTimeout(() => setCopiedPublic(false), 2000);
  };

  const handleCopyPrivate = () => {
    if (!createdProduct?.privateKey) return;
    navigator.clipboard.writeText(createdProduct.privateKey);
    setCopiedPrivate(true);
    setTimeout(() => setCopiedPrivate(false), 2000);
  };

  const handleAttemptClose = () => {
    // If a product was created and contains a private key that hasn't been downloaded yet
    if (createdProduct && createdProduct.privateKey && !hasDownloadedKey) {
      setShowCloseConfirm(true);
      return;
    }
    performClose();
  };

  const performClose = () => {
    setShowCloseConfirm(false);
    setCreatedProduct(null);
    setName("");
    setDescription("");
    setTrialDays(14);
    setTrialFeatures("");
    setKeyMode("auto");
    setUploadPrivateKey("");
    setUploadPublicKey("");
    setHasDownloadedKey(false);
    setShowPrivateKeyText(false);
    setError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl shadow-2xl text-slate-100 overflow-hidden animate-in fade-in zoom-in-95 duration-150 relative">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base text-white">
                {createdProduct ? "Product Credentials & Private Key" : "Create New Product"}
              </h3>
              <p className="text-xs text-slate-400">
                {createdProduct
                  ? "Save your cryptographic signing credentials immediately"
                  : "Generate product and configure Ed25519 signing keypair"}
              </p>
            </div>
          </div>
          <button
            onClick={handleAttemptClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {createdProduct ? (
            <div className="space-y-4">
              {/* SUCCESS VIEW: Download Private Key & Public Key */}
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 flex items-start gap-3">
                <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-emerald-200">
                    Product "{createdProduct.name}" Created Successfully!
                  </div>
                  <div className="text-xs text-emerald-300/80 mt-1">
                    An asymmetric Ed25519 keypair is active. The private key has been encrypted in D1 with
                    AES-256-GCM envelope encryption.
                  </div>
                </div>
              </div>

              {/* Private Key Card (High Priority with Warning) */}
              {createdProduct.privateKey && (
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Lock className="w-4 h-4 text-amber-400" />
                      <span className="text-xs font-bold uppercase tracking-wider text-amber-300">
                        Ed25519 Private Key (One-time Download)
                      </span>
                    </div>
                    {hasDownloadedKey ? (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium flex items-center gap-1 border border-emerald-500/30">
                        <Check className="w-3 h-3" />
                        Downloaded
                      </span>
                    ) : (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-medium flex items-center gap-1 border border-amber-500/30">
                        <AlertTriangle className="w-3 h-3" />
                        Download Required
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-amber-200/90 leading-relaxed">
                    ⚠️ <strong>Notice:</strong> This is your <strong>ONLY opportunity</strong> to download or copy this private key.
                    LicenKit will never display or export unencrypted private keys again once you close this window.
                  </p>

                  <div className="flex items-center gap-2">
                    <div className="flex-1 relative">
                      <input
                        type={showPrivateKeyText ? "text" : "password"}
                        readOnly
                        value={createdProduct.privateKey}
                        className="w-full bg-slate-950 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-200 font-mono select-all focus:outline-none pr-8"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPrivateKeyText(!showPrivateKeyText)}
                        className="absolute right-2 top-2.5 text-amber-400 hover:text-amber-200"
                        title={showPrivateKeyText ? "Hide private key" : "Show private key"}
                      >
                        {showPrivateKeyText ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    <button
                      onClick={handleCopyPrivate}
                      className="flex items-center gap-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-xs text-amber-200 rounded-lg font-medium transition-colors border border-amber-500/30 shrink-0"
                    >
                      {copiedPrivate ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedPrivate ? "Copied" : "Copy"}</span>
                    </button>

                    <button
                      onClick={handleDownloadKey}
                      className={`flex items-center gap-1.5 px-3.5 py-2 text-xs rounded-lg font-medium transition-all shadow shrink-0 ${
                        hasDownloadedKey
                          ? "bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700"
                          : "bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold shadow-amber-900/40"
                      }`}
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>{hasDownloadedKey ? "Download Again" : "Download (.key)"}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Public Key Card */}
              <div className="space-y-1.5 pt-1">
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
                  Product Ed25519 Public Key (Embed in client app)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={createdProduct.publicKey}
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-indigo-300 font-mono select-all focus:outline-none"
                  />
                  <button
                    onClick={handleCopyPublic}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs text-white rounded-lg font-medium transition-colors shadow shrink-0"
                  >
                    {copiedPublic ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedPublic ? "Copied" : "Copy Key"}</span>
                  </button>
                </div>
                <p className="text-[11px] text-slate-500">
                  Embed this public key directly in your desktop or mobile binary. Clients use it to verify offline license tokens without internet access.
                </p>
              </div>

              {/* Footer Buttons */}
              <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
                <span className="text-[11px] text-slate-500 font-mono">ID: {createdProduct.id}</span>
                <button
                  onClick={handleAttemptClose}
                  className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white rounded-lg transition-colors border border-slate-700 shadow"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* CREATION FORM */}
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg text-xs">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Product Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. ScreenStudio Pro"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Description (Optional)</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Professional screen recording tool for creators..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Trial Period (Days)</label>
                  <input
                    type="number"
                    min={0}
                    value={trialDays}
                    onChange={(e) => setTrialDays(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">0 = Disable free trial</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Trial Features</label>
                  <input
                    type="text"
                    value={trialFeatures}
                    onChange={(e) => setTrialFeatures(e.target.value)}
                    placeholder="feature_a, feature_b"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Comma-separated tags (e.g. feature_a, feature_b)</p>
                </div>
              </div>

              {/* Keypair Generation & Upload Options */}
              <div className="pt-2 border-t border-slate-800 space-y-3">
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Ed25519 Signing Keypair
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setKeyMode("auto")}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      keyMode === "auto"
                        ? "bg-indigo-600/10 border-indigo-500/40 text-white shadow"
                        : "bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles className={`w-4 h-4 ${keyMode === "auto" ? "text-indigo-400" : "text-slate-500"}`} />
                      <span className="text-xs font-semibold text-slate-200">Auto-Generate (Recommended)</span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      System generates a secure Ed25519 keypair and allows immediate one-time download.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setKeyMode("upload")}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      keyMode === "upload"
                        ? "bg-indigo-600/10 border-indigo-500/40 text-white shadow"
                        : "bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <UploadCloud className={`w-4 h-4 ${keyMode === "upload" ? "text-indigo-400" : "text-slate-500"}`} />
                      <span className="text-xs font-semibold text-slate-200">Upload Existing Keypair</span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Import your own Ed25519 private and public keys (PEM or Base64 format).
                    </p>
                  </button>
                </div>

                {keyMode === "upload" && (
                  <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3 animate-in fade-in duration-150">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Ed25519 Private Key <span className="text-red-400">*</span>
                      </label>
                      <textarea
                        rows={3}
                        required
                        value={uploadPrivateKey}
                        onChange={(e) => setUploadPrivateKey(e.target.value)}
                        placeholder="-----BEGIN PRIVATE KEY-----&#10;MC4CAQAwBwYDK2VwBQAEIG...&#10;-----END PRIVATE KEY-----"
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-indigo-300 font-mono focus:outline-none focus:border-indigo-500"
                      />
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Accepts PKCS#8 PEM or 32-byte Base64 raw private key.
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Matching Ed25519 Public Key <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        value={uploadPublicKey}
                        onChange={(e) => setUploadPublicKey(e.target.value)}
                        placeholder="Base64 or PEM public key"
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-indigo-300 font-mono focus:outline-none focus:border-indigo-500"
                      />
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Verified cryptographically against the private key upon submission.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={handleAttemptClose}
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
                  <span>{loading ? "Creating..." : "Create Product & Generate Key"}</span>
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Secondary confirmation modal: prevent closing without download */}
        {showCloseConfirm && (
          <div className="absolute inset-0 z-20 bg-black/85 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-150">
            <div className="bg-slate-900 border border-amber-500/50 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
                  <AlertTriangle className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-white">Private Key Not Downloaded!</h4>
                  <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                    You have not downloaded or backed up your Ed25519 private key.
                  </p>
                </div>
              </div>

              <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-xl text-xs text-red-300 leading-relaxed">
                <strong>CRITICAL WARNING:</strong> For security purposes, LicenKit <strong>never stores or displays the unencrypted private key again</strong>. If you close this modal without downloading it, you will <strong>never be able to recover it</strong>.
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowCloseConfirm(false)}
                  className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 rounded-lg transition-colors border border-slate-700"
                >
                  Return to Modal
                </button>

                <button
                  type="button"
                  onClick={() => {
                    handleDownloadKey();
                    setShowCloseConfirm(false);
                  }}
                  className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-xs font-semibold text-slate-950 rounded-lg transition-colors shadow"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Key & Keep</span>
                </button>

                <button
                  type="button"
                  onClick={performClose}
                  className="px-3.5 py-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors border border-red-500/20"
                >
                  I Understand, Close Anyway
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n/I18nContext";
import { downloadRecoveryCredential, type RecoveryCredentialFile } from "../lib/recovery-credential-file";
import { Button, Modal, Notice } from "./ui";

export function RecoveryCredentialDialog({ file, onClose }: { file: RecoveryCredentialFile; onClose: () => void }) {
  const { t } = useI18n();
  const downloaded = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  function download() {
    try { downloadRecoveryCredential(file); setFailed(false) }
    catch { setFailed(true) }
  }
  useEffect(() => {
    if (downloaded.current === file.credential) return;
    downloaded.current = file.credential;
    download();
  }, [file.credential]);
  return (
    <Modal open title={t.recoveryCredential.saveTitle} description={t.recoveryCredential.saveDescription} onClose={onClose}>
      <div className="form-stack">
        <Notice tone={failed ? "warning" : "info"}><p>{failed ? t.recoveryCredential.downloadFailed : t.recoveryCredential.downloadStarted}</p></Notice>
        <div className="form-actions">
          <Button variant="secondary" onClick={download}>{t.recoveryCredential.downloadAgain}</Button>
          <Button onClick={onClose}>{t.recoveryCredential.saved}</Button>
        </div>
      </div>
    </Modal>
  );
}

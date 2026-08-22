import { CircleNotch, FolderOpen, X } from "@phosphor-icons/react";
import { useState } from "react";
import { useSonic } from "../../app/SonicProvider";

export function SidecarImportDialog() {
  const { state, scanSidecarFolder, clearSidecarReport } = useSonic();
  const [folderPath, setFolderPath] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [working, setWorking] = useState(false);
  const report = state.sidecarReport;

  const close = () => {
    clearSidecarReport();
    setFolderPath("");
  };

  const run = async () => {
    if (!folderPath.trim() || working) return;
    setWorking(true);
    try {
      await scanSidecarFolder(folderPath.trim(), recursive);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="tool-dialog" role="dialog" aria-modal="true" aria-labelledby="import-heading">
        <header>
          <div>
            <span className="eyebrow">Library tools</span>
            <h2 id="import-heading">Import a Sonic folder</h2>
          </div>
          <button type="button" onClick={close} aria-label="Close import dialog"><X size={17} aria-hidden="true" /></button>
        </header>

        <p className="dialog-lede">
          Point Sonic at a folder of exported audio. Every verified <code>.sonic.json</code> sidecar rebuilds
          its Library record — nothing on disk is modified.
        </p>

        {!report ? (
          <form className="import-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
            <label className="field">
              <span>Folder to scan</span>
              <input
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                placeholder="D:\Beats\2026"
                aria-label="Absolute folder path to scan"
                autoFocus
              />
            </label>
            <label className="switch-field">
              <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
              <span><b>Include subfolders</b><small>Scan every nested folder under the path</small></span>
            </label>
            <footer>
              <button type="button" onClick={close}>Cancel</button>
              <button className="primary-action" type="submit" disabled={!folderPath.trim() || working}>
                {working ? <CircleNotch className="spin" size={16} aria-hidden="true" /> : <FolderOpen size={17} aria-hidden="true" />}
                {working ? "Scanning…" : "Scan folder"}
              </button>
            </footer>
          </form>
        ) : (
          <div className="import-report" role="status">
            <dl>
              <div><dt>Scanned</dt><dd>{report.scannedCount}</dd></div>
              <div><dt>Imported</dt><dd>{report.importedCount}</dd></div>
              <div><dt>Skipped</dt><dd>{report.skippedCount}</dd></div>
              <div><dt>Errors</dt><dd>{report.errorCount}</dd></div>
            </dl>
            {report.errors.length ? (
              <ul className="import-errors" aria-label="Import problems">
                {report.errors.slice(0, 8).map((entry, index) => (
                  <li key={`${entry.path}-${index}`}><strong>{entry.errorCode}</strong><span>{entry.error}</span></li>
                ))}
              </ul>
            ) : null}
            <footer>
              <button type="button" onClick={() => clearSidecarReport()}>Import another folder</button>
              <button className="primary-action" type="button" onClick={close}>Done</button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}

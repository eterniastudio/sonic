import { Copy, Trash, X } from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";

const GROUP_LABELS = {
  exact_sha256: "Identical audio files",
  same_source: "Exports of the same source",
} as const;

export function DuplicatesDialog() {
  const { state, selectLibraryItem, setRoute, clearDuplicateScan, bulkDeleteItems, removeLibraryItem } = useSonic();
  const scan = state.duplicateScan;
  if (!scan) return null;

  const titleFor = (itemId: string) => state.library.find((item) => item.id === itemId)?.title ?? itemId;
  const keepFirst = (itemIds: string[]) => itemIds.slice(1);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) clearDuplicateScan(); }}>
      <section className="tool-dialog" role="dialog" aria-modal="true" aria-labelledby="duplicates-heading">
        <header>
          <div>
            <span className="eyebrow">Library tools</span>
            <h2 id="duplicates-heading">{scan.groups.length ? `${scan.groups.length} duplicate ${scan.groups.length === 1 ? "group" : "groups"}` : "No duplicates found"}</h2>
          </div>
          <button type="button" onClick={clearDuplicateScan} aria-label="Close duplicate results"><X size={17} aria-hidden="true" /></button>
        </header>

        <p className="dialog-lede">
          {scan.kind === "sha256"
            ? "These exports have byte-identical audio. Removing extras keeps your archive lean."
            : "These exports came from the same source link or file, in different formats."}
        </p>

        {scan.groups.length ? (
          <div className="duplicate-groups">
            {scan.groups.map((group) => (
              <article key={`${group.groupType}-${group.fingerprint}`} className="duplicate-group">
                <h3><Copy size={14} aria-hidden="true" /> {GROUP_LABELS[group.groupType]} · {group.count} copies</h3>
                <ul>
                  {group.itemIds.map((itemId, index) => {
                    const item = state.library.find((candidate) => candidate.id === itemId);
                    return (
                      <li key={itemId}>
                        <span className="duplicate-name">
                          <strong>{titleFor(itemId)}</strong>
                          <small>{[item?.format.toUpperCase(), index === 0 ? "oldest copy" : null].filter(Boolean).join(" · ")}</small>
                        </span>
                        <span className="duplicate-actions">
                          <button type="button" onClick={() => {
                            clearDuplicateScan();
                            selectLibraryItem(itemId);
                            setRoute("library");
                          }}>Inspect</button>
                          {index > 0 ? (
                            <button
                              type="button"
                              className="danger-text"
                              onClick={() => void removeLibraryItem(itemId, false)}
                              aria-label={`Remove ${titleFor(itemId)} from Library`}
                            >
                              <Trash size={13} aria-hidden="true" /> Remove record
                            </button>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {group.itemIds.length > 2 ? (
                  <button
                    type="button"
                    className="danger-text group-clean"
                    onClick={() => void bulkDeleteItems(keepFirst(group.itemIds), false)}
                  >
                    Keep the oldest copy, remove the other {group.itemIds.length - 1} records
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="dialog-empty">Every export in view is unique.</p>
        )}
      </section>
    </div>
  );
}

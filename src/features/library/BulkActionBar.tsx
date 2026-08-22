import { FolderOpen, Tag as TagIcon, Trash, X } from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";

export function BulkActionBar() {
  const {
    state,
    selectedLibraryItems,
    clearLibrarySelection,
    bulkTagItems,
    bulkAddSelectionToCollection,
    bulkDeleteItems,
  } = useSonic();

  if (!selectedLibraryItems.length) return null;
  const count = selectedLibraryItems.length;

  return (
    <div className="bulk-bar" role="toolbar" aria-label={`Actions for ${count} selected tracks`}>
      <span className="bulk-count"><b>{count}</b> {count === 1 ? "track" : "tracks"} selected</span>
      <label className="bulk-action">
        <TagIcon size={15} aria-hidden="true" />
        <span className="sr-only">Tag selected tracks</span>
        <select
          value=""
          onChange={(event) => {
            const tagId = event.target.value;
            if (tagId) void bulkTagItems(state.selectedLibraryIds, tagId).then(() => clearLibrarySelection());
          }}
        >
          <option value="">Tag as…</option>
          {state.tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </select>
      </label>
      <label className="bulk-action">
        <FolderOpen size={15} aria-hidden="true" />
        <span className="sr-only">Add selected tracks to collection</span>
        <select
          value=""
          onChange={(event) => {
            const collectionId = event.target.value;
            if (collectionId) void bulkAddSelectionToCollection(collectionId).then(() => clearLibrarySelection());
          }}
        >
          <option value="">Add to collection…</option>
          {state.collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
        </select>
      </label>
      <button
        type="button"
        className="danger-text"
        onClick={() => {
          if (window.confirm(`Remove ${count} ${count === 1 ? "track" : "tracks"} from the Library? Audio files are kept.`)) {
            void bulkDeleteItems([...state.selectedLibraryIds], false);
          }
        }}
      >
        <Trash size={14} aria-hidden="true" /> Remove records
      </button>
      <button type="button" className="bulk-clear" onClick={clearLibrarySelection} aria-label="Clear selection">
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

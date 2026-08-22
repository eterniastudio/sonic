import { Bookmark, FolderOpen, MagnifyingGlass, Plus, Tag as TagIcon, Trash, WarningCircle } from "@phosphor-icons/react";
import { useState, type CSSProperties } from "react";
import { useSonic } from "../../app/SonicProvider";

type LibrarySidebarProps = {
  missingActive: boolean;
  onShowAll(): void;
  onShowMissing(): void;
  onOpenImport(): void;
};

export function LibrarySidebar({ missingActive, onShowAll, onShowMissing, onOpenImport }: LibrarySidebarProps) {
  const {
    state,
    createTag,
    toggleTagSelection,
    createCollection,
    deleteCollection,
    selectCollection,
    findDuplicates,
  } = useSonic();
  const [newTag, setNewTag] = useState("");
  const [newCollection, setNewCollection] = useState("");

  const submitTag = () => {
    const name = newTag.trim();
    if (!name) return;
    void createTag(name).then(() => setNewTag(""));
  };

  const submitCollection = () => {
    const name = newCollection.trim();
    if (!name) return;
    void createCollection(name).then(() => setNewCollection(""));
  };

  const baseViewActive = !state.selectedCollectionId && !state.selectedTagIds.length && !missingActive;

  return (
    <nav className="library-sidebar" aria-label="Library organization">
      <section className="sidebar-group" aria-labelledby="views-heading">
        <h2 className="sidebar-heading" id="views-heading">Views</h2>
        <button
          type="button"
          className={`sidebar-row${baseViewActive ? " is-active" : ""}`}
          onClick={onShowAll}
        >
          <Bookmark size={16} aria-hidden="true" />
          <span>All tracks</span>
          <b>{state.libraryTotalCount}</b>
        </button>
        <button
          type="button"
          className={`sidebar-row${missingActive ? " is-active" : ""}`}
          onClick={onShowMissing}
        >
          <WarningCircle size={16} aria-hidden="true" />
          <span>Missing files</span>
          {state.libraryFacets?.missingCount ? <b>{state.libraryFacets.missingCount}</b> : null}
        </button>
      </section>

      <section className="sidebar-group" aria-labelledby="collections-heading">
        <h2 className="sidebar-heading" id="collections-heading">Collections</h2>
        {state.collections.length ? (
          <ul className="sidebar-list">
            {state.collections.map((collection) => (
              <li key={collection.id} className={state.selectedCollectionId === collection.id ? "is-active" : ""}>
                <div className="sidebar-row-wrap">
                  <button
                    type="button"
                    className="sidebar-row"
                    aria-pressed={state.selectedCollectionId === collection.id}
                    onClick={() => selectCollection(state.selectedCollectionId === collection.id ? null : collection.id)}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    <span>{collection.name}</span>
                    <b>{collection.itemCount}</b>
                  </button>
                  <button
                    type="button"
                    className="sidebar-remove"
                    aria-label={`Delete collection ${collection.name}`}
                    onClick={() => {
                      if (window.confirm(`Delete the “${collection.name}” collection? Tracks are kept.`)) void deleteCollection(collection.id);
                    }}
                  >
                    <Trash size={13} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sidebar-empty">Group tracks into crates for projects, moods, or clients.</p>
        )}
        <div className="sidebar-create">
          <input
            value={newCollection}
            onChange={(event) => setNewCollection(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") submitCollection(); }}
            placeholder="New collection…"
            aria-label="New collection name"
          />
          <button type="button" disabled={!newCollection.trim()} onClick={submitCollection} aria-label="Create collection">
            <Plus size={15} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="sidebar-group" aria-labelledby="tags-heading">
        <h2 className="sidebar-heading" id="tags-heading">Tags</h2>
        {state.tags.length ? (
          <div className="tag-cloud" role="group" aria-label="Filter by tag">
            {state.tags.map((tag) => {
              const active = state.selectedTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`tag-chip${active ? " is-active" : ""}`}
                  style={!active && tag.color ? ({ "--tag-color": tag.color } as CSSProperties) : undefined}
                  aria-pressed={active}
                  title={`${tag.itemCount} ${tag.itemCount === 1 ? "track" : "tracks"} tagged ${tag.name}`}
                  onClick={() => toggleTagSelection(tag.id)}
                >
                  <TagIcon size={12} weight="fill" aria-hidden="true" />
                  {tag.name}
                  <small>{tag.itemCount}</small>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="sidebar-empty">Tag beats dark, guitar, sample-ready — whatever you reach for.</p>
        )}
        <div className="sidebar-create">
          <input
            value={newTag}
            onChange={(event) => setNewTag(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") submitTag(); }}
            placeholder="New tag…"
            aria-label="New tag name"
          />
          <button type="button" disabled={!newTag.trim()} onClick={submitTag} aria-label="Create tag">
            <Plus size={15} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="sidebar-group sidebar-tools" aria-label="Library tools">
        <h2 className="sidebar-heading">Tools</h2>
        <button type="button" className="sidebar-tool" onClick={() => void findDuplicates("sha256")}>
          <MagnifyingGlass size={16} aria-hidden="true" /> Find duplicate audio
        </button>
        <button type="button" className="sidebar-tool" onClick={() => void findDuplicates("source")}>
          <MagnifyingGlass size={16} aria-hidden="true" /> Find same-source exports
        </button>
        <button type="button" className="sidebar-tool" onClick={onOpenImport}>
          <FolderOpen size={16} aria-hidden="true" /> Import metadata folder
        </button>
      </section>
    </nav>
  );
}

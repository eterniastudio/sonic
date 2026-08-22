import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  FileAudio,
  FolderOpen,
  FadersHorizontal,
  MagnifyingGlass,
  Play,
  Plus,
  Rows,
  SquaresFour,
  Tag as TagIcon,
  Trash,
  WarningCircle,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";
import { formatBytes, formatDuration, shortPath } from "../../domain/format";
import type { LibraryFilters, LibraryItem, LibrarySort } from "../../domain/types";
import { requestNextLibraryPage } from "../../services/library-pagination";
import { BulkActionBar } from "./BulkActionBar";
import { DuplicatesDialog } from "./DuplicatesDialog";
import { LibrarySidebar } from "./LibrarySidebar";
import { SidecarImportDialog } from "./SidecarImportDialog";

const EMPTY_FILTERS: LibraryFilters = { format: "", key: "", bpmMin: "", bpmMax: "", missingOnly: false };

function TrackMeta({ item }: { item: LibraryItem }) {
  return (
    <>
      <b>{item.bpm ? `${item.bpm} BPM` : "No BPM"}</b>
      <small>{item.key ?? "No key"}{item.camelot ? ` · ${item.camelot}` : ""}</small>
    </>
  );
}

export function LibraryPage() {
  const {
    state,
    selectedLibraryItem: selected,
    selectLibraryItem,
    refreshLibrary,
    reexportLibraryItem,
    removeLibraryItem,
    revealPath,
    openSource,
    loadPreview,
    separateLibraryItemStems,
    assignTagToItem,
    removeTagFromItem,
    toggleLibrarySelection,
    setAllLibrarySelected,
    setLibraryView,
    selectCollection,
    toggleTagSelection,
  } = useSonic();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<LibrarySort>("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [separatingId, setSeparatingId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const effectiveFilters = useMemo<LibraryFilters>(() => ({
    ...filters,
    collectionId: state.selectedCollectionId ?? "",
    tagIds: state.selectedTagIds,
  }), [filters, state.selectedCollectionId, state.selectedTagIds]);

  const scopedToSidebar = Boolean(state.selectedCollectionId || state.selectedTagIds.length);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshLibrary(query, effectiveFilters, sort), 240);
    return () => window.clearTimeout(timer);
  }, [effectiveFilters, query, refreshLibrary, sort]);

  useEffect(() => {
    setLoadingMore(false);
  }, [effectiveFilters, query, sort]);

  const items = state.library;
  const totalCount = Math.max(state.libraryTotalCount, items.length);
  const pageCount = items.length < totalCount
    ? `${items.length} of ${totalCount} tracks`
    : `${totalCount} ${totalCount === 1 ? "track" : "tracks"}`;
  const formatFacets = state.libraryFacets?.formats.length
    ? state.libraryFacets.formats
    : [...new Set(items.map((item) => item.format))].map((value) => ({
        value,
        count: items.filter((item) => item.format === value).length,
      }));
  const allVisibleSelected = items.length > 0 && items.every((item) => state.selectedLibraryIds.includes(item.id));
  const grid = state.libraryView === "grid";

  const loadMore = async () => {
    if (!requestNextLibraryPage()) return;
    setLoadingMore(true);
    try {
      await refreshLibrary(query, effectiveFilters, sort);
    } finally {
      setLoadingMore(false);
    }
  };

  const showAll = () => {
    setQuery("");
    setFilters(EMPTY_FILTERS);
    selectCollection(null);
    if (state.selectedTagIds.length) state.selectedTagIds.forEach((tagId) => toggleTagSelection(tagId));
  };

  const showMissing = () => setFilters((current) => ({ ...current, missingOnly: true }));

  const itemTags = selected ? state.itemTagsById[selected.id] ?? [] : [];
  const assignableTags = state.tags.filter((tag) => !itemTags.some((assigned) => assigned.id === tag.id));

  return (
    <main className={`library-layout${grid ? " is-grid-view" : ""}`} aria-labelledby="library-heading">
      <LibrarySidebar
        missingActive={filters.missingOnly}
        onShowAll={showAll}
        onShowMissing={showMissing}
        onOpenImport={() => setImportOpen(true)}
      />

      <section className="library-workspace">
        <header className="page-heading">
          <div><span className="eyebrow">Saved tracks</span><h1 id="library-heading">Library</h1><p>Search, organize, split, or export tracks again.</p></div>
          <span className="page-count" aria-live="polite">{pageCount}</span>
        </header>

        {(state.selectedCollectionId || state.selectedTagIds.length || filters.missingOnly) ? (
          <div className="scope-strip" aria-label="Active scopes">
            {state.collections.filter((collection) => collection.id === state.selectedCollectionId).map((collection) => (
              <button key={collection.id} type="button" className="scope-chip" onClick={() => selectCollection(null)}>
                {collection.name}<X size={12} weight="bold" aria-hidden="true" />
              </button>
            ))}
            {state.tags.filter((tag) => state.selectedTagIds.includes(tag.id)).map((tag) => (
              <button key={tag.id} type="button" className="scope-chip is-tag" onClick={() => toggleTagSelection(tag.id)}>
                <TagIcon size={11} weight="fill" aria-hidden="true" />{tag.name}<X size={12} weight="bold" aria-hidden="true" />
              </button>
            ))}
            {filters.missingOnly ? (
              <button type="button" className="scope-chip is-warning" onClick={() => setFilters((current) => ({ ...current, missingOnly: false }))}>
                Missing files<X size={12} weight="bold" aria-hidden="true" />
              </button>
            ) : null}
            {scopedToSidebar ? (
              <button type="button" className="scope-clear" onClick={() => { selectCollection(null); state.selectedTagIds.forEach((tagId) => toggleTagSelection(tagId)); }}>Clear all</button>
            ) : null}
          </div>
        ) : null}

        <div className="library-tools">
          <label className="search-field">
            <MagnifyingGlass size={18} aria-hidden="true" />
            <span className="sr-only">Search beat library</span>
            <input id="library-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, artist, key, BPM, or file name" />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear library search">×</button> : null}
          </label>
          <button className={filtersOpen ? "is-active" : ""} type="button" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}>
            <FadersHorizontal size={16} weight={filtersOpen ? "fill" : "regular"} aria-hidden="true" /> Filters
          </button>
          <label className="sort-field">
            <span className="sr-only">Sort library</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Title A–Z</option>
              <option value="artist">Artist A–Z</option>
              <option value="bpm">Tempo</option>
              <option value="format">Format</option>
            </select>
          </label>
          <div className="view-switch" role="group" aria-label="Result layout">
            <button type="button" className={!grid ? "is-active" : ""} aria-pressed={!grid} onClick={() => setLibraryView("list")}><Rows size={16} aria-hidden="true" /><span className="sr-only">List view</span></button>
            <button type="button" className={grid ? "is-active" : ""} aria-pressed={grid} onClick={() => setLibraryView("grid")}><SquaresFour size={16} aria-hidden="true" /><span className="sr-only">Grid view</span></button>
          </div>
        </div>

        {filtersOpen ? (
          <div className="filter-strip" aria-label="Library filters">
            <label><span>Format</span><select value={filters.format} onChange={(event) => setFilters((current) => ({ ...current, format: event.target.value }))}><option value="">All</option>{formatFacets.map((facet) => <option key={facet.value} value={facet.value}>{facet.value.toUpperCase()} ({facet.count})</option>)}</select></label>
            <label><span>Key</span><input value={filters.key} onChange={(event) => setFilters((current) => ({ ...current, key: event.target.value }))} placeholder="F# minor" /></label>
            <label><span>Min BPM</span><input type="number" min="20" max="400" value={filters.bpmMin} onChange={(event) => setFilters((current) => ({ ...current, bpmMin: event.target.value }))} /></label>
            <label><span>Max BPM</span><input type="number" min="20" max="400" value={filters.bpmMax} onChange={(event) => setFilters((current) => ({ ...current, bpmMax: event.target.value }))} /></label>
            <label className="missing-filter"><input type="checkbox" checked={filters.missingOnly} onChange={(event) => setFilters((current) => ({ ...current, missingOnly: event.target.checked }))} /><span>Missing files only</span></label>
            <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>Reset</button>
          </div>
        ) : null}

        <BulkActionBar />

        {items.length ? (
          <>
            <label className="select-all">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(event) => setAllLibrarySelected(event.target.checked)}
              />
              <span>Select every loaded track</span>
            </label>

            {grid ? (
              <ul className="library-grid" aria-label="Library results">
                {items.map((item) => (
                  <li key={item.id} className={`library-card${selected?.id === item.id ? " is-selected" : ""}${!item.exists ? " is-missing" : ""}`}>
                    <label className="card-select">
                      <input
                        type="checkbox"
                        checked={state.selectedLibraryIds.includes(item.id)}
                        onChange={() => toggleLibrarySelection(item.id)}
                        aria-label={`Select ${item.title}`}
                      />
                    </label>
                    <button type="button" className="card-body" onClick={() => selectLibraryItem(item.id)} aria-current={selected?.id === item.id ? "true" : undefined}>
                      <span className="card-art" aria-hidden="true">
                        {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <FileAudio size={26} />}
                        {!item.exists ? <span className="card-missing"><WarningCircle size={15} weight="fill" /> Missing</span> : null}
                      </span>
                      <span className="card-title">{item.title}</span>
                      <span className="card-creator">{item.creator ?? item.sourceLabel}</span>
                      <span className="card-meta"><TrackMeta item={item} /></span>
                      <span className="card-format">{item.format.toUpperCase()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="library-table" role="list" aria-label="Library results">
                <div className="library-table-head" aria-hidden="true"><span className="head-check" /><span>Track</span><span>Details</span><span>Format</span><span>Exported</span></div>
                {items.map((item) => (
                  <div role="listitem" key={item.id} className={`library-row-item${state.selectedLibraryIds.includes(item.id) ? " is-checked" : ""}`}>
                    <label className="row-check">
                      <input
                        type="checkbox"
                        checked={state.selectedLibraryIds.includes(item.id)}
                        onChange={() => toggleLibrarySelection(item.id)}
                        aria-label={`Select ${item.title}`}
                      />
                    </label>
                    <button
                      type="button"
                      className={`library-row${selected?.id === item.id ? " is-selected" : ""}${!item.exists ? " is-missing" : ""}`}
                      onClick={() => selectLibraryItem(item.id)}
                      aria-current={selected?.id === item.id ? "true" : undefined}
                    >
                      <span className="library-track">
                        <span className="library-art" aria-hidden="true">{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <FileAudio size={21} />}</span>
                        <span><strong>{item.title}</strong><small>{item.creator ?? item.sourceLabel}</small></span>
                      </span>
                      <span className="library-music"><TrackMeta item={item} /></span>
                      <span className="format-cell"><b>{item.format.toUpperCase()}</b><small>{formatBytes(item.fileSizeBytes)}</small></span>
                      <span className="date-cell"><strong>{new Date(item.exportedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</strong><small>{item.exists ? "Available" : "File missing"}</small></span>
                      {!item.exists ? <WarningCircle className="missing-icon" size={17} weight="fill" aria-label="File missing" /> : null}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {state.libraryNextCursor ? (
              <div className="source-actions" style={{ marginTop: 12 }}>
                <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading more…" : `Load more (${items.length} of ${totalCount})`}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="library-empty">
            <Waveform size={31} aria-hidden="true" />
            <h2>{query.trim() || scopedToSidebar || filters.missingOnly ? "No matches" : "No saved tracks"}</h2>
            <p>{query.trim() || scopedToSidebar || filters.missingOnly ? "Try another search or clear the active scopes." : "Finished exports appear here."}</p>
          </div>
        )}
      </section>

      <aside className="library-detail" aria-label="Selected library item">
        {selected ? (
          <>
            <div className="detail-art" aria-hidden="true">{selected.thumbnailUrl ? <img src={selected.thumbnailUrl} alt="" /> : <FileAudio size={34} />}</div>
            <span className="eyebrow">{selected.sourceLabel}</span>
            <h2>{selected.title}</h2>
            <p className="detail-creator">{selected.creator ?? "No artist listed"}</p>
            {!selected.exists ? <div className="inline-alert is-error"><WarningCircle size={17} weight="fill" aria-hidden="true" /><span>File not found. It may have been moved or deleted.</span></div> : null}

            <section className="detail-tags" aria-label={`${selected.title} tags`}>
              <span className="eyebrow">Tags</span>
              {itemTags.length ? (
                <div className="tag-row">
                  {itemTags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      className="tag-chip is-assigned"
                      style={tag.color ? ({ "--tag-color": tag.color } as React.CSSProperties) : undefined}
                      onClick={() => void removeTagFromItem(selected.id, tag.id)}
                      aria-label={`Remove tag ${tag.name}`}
                    >
                      <TagIcon size={11} weight="fill" aria-hidden="true" />{tag.name}<X size={10} weight="bold" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="tag-none">No tags yet.</p>
              )}
              {assignableTags.length ? (
                <label className="tag-add">
                  <span className="sr-only">Add a tag to this track</span>
                  <Plus size={13} weight="bold" aria-hidden="true" />
                  <select
                    value=""
                    onChange={(event) => {
                      const tagId = event.target.value;
                      if (tagId) void assignTagToItem(selected.id, tagId);
                    }}
                  >
                    <option value="">Add tag…</option>
                    {assignableTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                  </select>
                </label>
              ) : null}
            </section>

            <dl className="detail-metrics">
              <div><dt>Tempo</dt><dd>{selected.bpm ? `${selected.bpm} BPM` : "—"}</dd></div>
              <div><dt>Key</dt><dd>{selected.key ?? "—"}</dd></div>
              <div><dt>Camelot</dt><dd>{selected.camelot ?? "—"}</dd></div>
              <div><dt>Detune</dt><dd>{selected.detuneCents ? `${selected.detuneCents > 0 ? "+" : ""}${selected.detuneCents}c` : "0c"}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(selected.durationSeconds)}</dd></div>
              <div><dt>Format</dt><dd>{selected.format.toUpperCase()}</dd></div>
            </dl>
            <div className="detail-path"><span>Output file</span><strong title={selected.outputPath}>{shortPath(selected.outputPath, 54)}</strong></div>
            <div className="detail-actions">
              <button className="primary-action" type="button" disabled={!selected.exists} onClick={() => void loadPreview(selected)}><Play size={17} weight="fill" aria-hidden="true" /> Play</button>
              <button type="button" disabled={!selected.exists} onClick={() => void revealPath(selected.outputPath)}><FolderOpen size={17} aria-hidden="true" /> Show in folder</button>
              <button type="button" onClick={() => void reexportLibraryItem(selected.id)}><ArrowClockwise size={17} aria-hidden="true" /> Export again</button>
              <button type="button" disabled={!selected.exists || separatingId === selected.id} onClick={async () => { setSeparatingId(selected.id); try { await separateLibraryItemStems(selected.id); } finally { setSeparatingId(null); } }}><Waveform size={17} aria-hidden="true" /> {separatingId === selected.id ? "Splitting…" : "Split into 4 stems"}</button>
              <button type="button" onClick={() => void openSource(selected.source)}><FileAudio size={17} aria-hidden="true" /> Open original</button>
            </div>
            <button className="destructive-text" type="button" onClick={() => {
              if (window.confirm("Remove this track from the Library? The audio file won’t be deleted.")) void removeLibraryItem(selected.id, false);
            }}><Trash size={15} aria-hidden="true" /> Remove from Library</button>
            {selected.exists ? <button className="destructive-text delete-audio" type="button" onClick={() => {
              if (window.confirm(`Delete “${selected.title}” and its metadata file? This cannot be undone.`)) void removeLibraryItem(selected.id, true);
            }}><Trash size={15} weight="fill" aria-hidden="true" /> Delete audio and metadata</button> : null}
          </>
        ) : <div className="detail-empty"><FileAudio size={30} aria-hidden="true" /><h2>Select a track</h2><p>Track details and file actions appear here.</p></div>}
      </aside>

      {importOpen ? <SidecarImportDialog /> : null}
      <DuplicatesDialog />
    </main>
  );
}

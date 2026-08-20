import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  FileAudio,
  FolderOpen,
  MagnifyingGlass,
  Play,
  Trash,
  WarningCircle,
  Waveform,
} from "@phosphor-icons/react";
import { useSonic } from "../../app/SonicProvider";
import { formatBytes, formatDuration, shortPath } from "../../domain/format";
import type { LibraryFilters, LibrarySort } from "../../domain/types";
import { requestNextLibraryPage } from "../../services/library-pagination";
import "../../styles/library-pagination.css";

const EMPTY_FILTERS: LibraryFilters = { format: "", key: "", bpmMin: "", bpmMax: "", missingOnly: false };

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
  } = useSonic();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<LibrarySort>("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [separatingId, setSeparatingId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const hasFilters = Boolean(query.trim() || filters.format || filters.key || filters.bpmMin || filters.bpmMax || filters.missingOnly);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshLibrary(query, filters, sort), 240);
    return () => window.clearTimeout(timer);
  }, [filters, query, refreshLibrary, sort]);

  useEffect(() => {
    setLoadingMore(false);
  }, [filters, query, sort]);

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

  const loadMore = async () => {
    if (!requestNextLibraryPage()) return;
    setLoadingMore(true);
    try {
      await refreshLibrary(query, filters, sort);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <main className="library-layout" aria-labelledby="library-heading">
      <section className="library-workspace">
        <header className="page-heading">
          <div><span className="eyebrow">Saved tracks</span><h1 id="library-heading">Library</h1><p>Play, split, or export tracks again.</p></div>
          <span className="page-count" aria-live="polite">{pageCount}</span>
        </header>

        <div className="library-tools">
          <label className="search-field">
            <MagnifyingGlass size={18} aria-hidden="true" />
            <span className="sr-only">Search beat library</span>
            <input id="library-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, artist, key, BPM, or file name" />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear library search">×</button> : null}
          </label>
          <button className={filtersOpen ? "is-active" : ""} type="button" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}>
            <MagnifyingGlass size={17} weight={filtersOpen ? "fill" : "regular"} aria-hidden="true" /> Filters
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

        {items.length ? (
          <>
            <div className="library-table" role="list" aria-label="Library results">
              <div className="library-table-head" aria-hidden="true"><span>Track</span><span>Details</span><span>Format</span><span>Exported</span></div>
              {items.map((item) => (
                <div role="listitem" key={item.id} className="library-row-item">
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
                  <span className="library-music"><strong>{item.bpm ? `${item.bpm} BPM` : "No BPM"}</strong><small>{item.key ?? "No key"}{item.camelot ? ` · ${item.camelot}` : ""}</small></span>
                  <span className="format-cell"><b>{item.format.toUpperCase()}</b><small>{formatBytes(item.fileSizeBytes)}</small></span>
                  <span className="date-cell"><strong>{new Date(item.exportedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</strong><small>{item.exists ? "Available" : "File missing"}</small></span>
                  {!item.exists ? <WarningCircle className="missing-icon" size={17} weight="fill" aria-label="File missing" /> : null}
                  </button>
                </div>
              ))}
            </div>
            {state.libraryNextCursor ? (
              <div className="library-pagination">
                <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading more…" : `Load more (${items.length} of ${totalCount})`}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="library-empty"><MagnifyingGlass size={31} aria-hidden="true" /><h2>{hasFilters ? "No matches" : "No saved tracks"}</h2><p>{hasFilters ? "Try another search or clear the filters." : "Finished exports appear here."}</p></div>
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
    </main>
  );
}

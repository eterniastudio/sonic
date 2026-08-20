import { invoke } from "@tauri-apps/api/core";
import type {
  FacetCount,
  LibraryFacets,
  LibraryFilters,
  LibraryItem,
  LibraryPage,
  LibrarySort,
} from "../domain/types";
import type { SonicBridge } from "./bridge-types";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  normalizeLibraryItem,
} from "./normalizers";

const DEFAULT_LIBRARY_PAGE_SIZE = 100;

type PaginationSnapshot = LibraryPage & { key: string };

function optionalNumber(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeFacetCounts(value: unknown): FacetCount[] {
  return asArray(value).flatMap((entry) => {
    const raw = asRecord(entry);
    const facetValue = asString(raw.value).trim();
    const count = asNumber(raw.count);
    return facetValue && count !== undefined && count >= 0
      ? [{ value: facetValue, count }]
      : [];
  });
}

function deriveFacets(items: LibraryItem[]): LibraryFacets {
  const formats = new Map<string, number>();
  const keys = new Map<string, number>();
  let missingCount = 0;

  for (const item of items) {
    formats.set(item.format, (formats.get(item.format) ?? 0) + 1);
    if (item.key) keys.set(item.key, (keys.get(item.key) ?? 0) + 1);
    if (!item.exists) missingCount += 1;
  }

  const byCountThenValue = (left: FacetCount, right: FacetCount) => (
    right.count - left.count || left.value.localeCompare(right.value)
  );

  return {
    formats: [...formats].map(([value, count]) => ({ value, count })).sort(byCountThenValue),
    keys: [...keys].map(([value, count]) => ({ value, count })).sort(byCountThenValue),
    missingCount,
  };
}

function normalizePageItem(value: unknown): LibraryItem {
  const raw = asRecord(value);
  const item = normalizeLibraryItem(value);
  if (typeof raw.exists === "boolean") item.exists = raw.exists;
  return item;
}

export function normalizeLibraryPage(value: unknown): LibraryPage {
  const raw = asRecord(value);
  const items = asArray(raw.items ?? raw.library ?? raw.libraryItems).map(normalizePageItem);
  const rawFacets = asRecord(raw.facets);
  const derivedFacets = deriveFacets(items);
  const formats = normalizeFacetCounts(rawFacets.formats);
  const keys = normalizeFacetCounts(rawFacets.keys);
  const nextCursor = asString(raw.nextCursor).trim() || undefined;

  return {
    items,
    nextCursor,
    totalCount: asNumber(raw.totalCount) ?? items.length,
    facets: {
      formats: formats.length ? formats : derivedFacets.formats,
      keys: keys.length ? keys : derivedFacets.keys,
      missingCount: asNumber(rawFacets.missingCount) ?? derivedFacets.missingCount,
    },
  };
}

function libraryQueryKey(query: string, filters?: LibraryFilters, sort?: LibrarySort) {
  return JSON.stringify({
    query: query.trim(),
    filters: filters ?? null,
    sort: sort ?? "newest",
  });
}

function mergeLibraryItems(current: LibraryItem[], incoming: LibraryItem[]) {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const merged = current.map((item) => incomingById.get(item.id) ?? item);
  const currentIds = new Set(current.map((item) => item.id));
  for (const item of incoming) {
    if (!currentIds.has(item.id)) merged.push(item);
  }
  return merged;
}

function compareOptionalText(left: string | undefined, right: string | undefined) {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function sortLibraryItems(items: LibraryItem[], sort: LibrarySort | undefined) {
  const sorted = [...items];
  sorted.sort((left, right) => {
    switch (sort ?? "newest") {
      case "oldest":
        return left.exportedAt.localeCompare(right.exportedAt) || left.id.localeCompare(right.id);
      case "title":
        return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
      case "artist":
        return compareOptionalText(left.creator, right.creator) || left.id.localeCompare(right.id);
      case "bpm": {
        const leftBpm = left.bpm ?? Number.POSITIVE_INFINITY;
        const rightBpm = right.bpm ?? Number.POSITIVE_INFINITY;
        return leftBpm - rightBpm || left.id.localeCompare(right.id);
      }
      case "format":
        return left.format.localeCompare(right.format) || left.id.localeCompare(right.id);
      default:
        return right.exportedAt.localeCompare(left.exportedAt) || right.id.localeCompare(left.id);
    }
  });
  return sorted;
}

function nativeLibraryQuery(
  query: string,
  filters: LibraryFilters | undefined,
  sort: LibrarySort | undefined,
  cursor: string | undefined,
  limit: number,
) {
  return {
    search: query.trim() || null,
    key: filters?.key.trim() || null,
    bpmMin: optionalNumber(filters?.bpmMin) ?? null,
    bpmMax: optionalNumber(filters?.bpmMax) ?? null,
    format: filters?.format || null,
    missing: filters?.missingOnly ? true : null,
    limit,
    cursor: cursor ?? null,
    sort: sort ?? "newest",
  };
}

class LibraryPaginationController {
  private nextPageRequested = false;
  private requestVersion = 0;
  private snapshot: PaginationSnapshot | null = null;
  private readonly pageSize: number;

  constructor(private readonly bridge: SonicBridge, pageSize: number) {
    this.pageSize = Math.max(1, Math.min(500, Math.trunc(pageSize)));
  }

  requestNextPage() {
    if (!this.snapshot?.nextCursor) return false;
    this.nextPageRequested = true;
    return true;
  }

  async listLibrary(query = "", filters?: LibraryFilters, sort?: LibrarySort): Promise<LibraryPage> {
    const key = libraryQueryKey(query, filters, sort);
    const append = Boolean(
      this.nextPageRequested
      && this.snapshot?.key === key
      && this.snapshot.nextCursor,
    );
    const cursor = append ? this.snapshot?.nextCursor : undefined;
    this.nextPageRequested = false;
    const requestVersion = ++this.requestVersion;

    const page = this.bridge.mode === "native"
      ? normalizeLibraryPage(await invoke<unknown>("list_library", {
          query: nativeLibraryQuery(query, filters, sort, cursor, this.pageSize),
        }))
      : await this.listPreviewLibrary(query, filters, sort, cursor);

    if (requestVersion !== this.requestVersion && this.snapshot) {
      return this.currentSnapshot();
    }

    this.snapshot = {
      ...page,
      key,
      items: append && this.snapshot
        ? mergeLibraryItems(this.snapshot.items, page.items)
        : page.items,
    };
    return this.currentSnapshot();
  }

  private async listPreviewLibrary(
    query: string,
    filters: LibraryFilters | undefined,
    sort: LibrarySort | undefined,
    cursor: string | undefined,
  ): Promise<LibraryPage> {
    const fullPage = normalizeLibraryPage(await this.bridge.listLibrary(query, filters, sort));
    const sortedItems = sortLibraryItems(fullPage.items, sort);
    const parsedOffset = Number.parseInt(cursor ?? "0", 10);
    const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    const end = Math.min(offset + this.pageSize, sortedItems.length);

    return {
      ...fullPage,
      items: sortedItems.slice(offset, end),
      nextCursor: end < sortedItems.length ? String(end) : undefined,
    };
  }

  private currentSnapshot(): LibraryPage {
    if (!this.snapshot) {
      return {
        items: [],
        totalCount: 0,
        facets: { formats: [], keys: [], missingCount: 0 },
      };
    }
    const { key: _key, ...page } = this.snapshot;
    return page;
  }
}

let activeController: LibraryPaginationController | null = null;

export function withLibraryPagination(
  bridge: SonicBridge,
  pageSize = DEFAULT_LIBRARY_PAGE_SIZE,
): SonicBridge {
  const controller = new LibraryPaginationController(bridge, pageSize);
  activeController = controller;

  return new Proxy(bridge, {
    get(target, property) {
      if (property === "listLibrary") return controller.listLibrary.bind(controller);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function requestNextLibraryPage() {
  return activeController?.requestNextPage() ?? false;
}

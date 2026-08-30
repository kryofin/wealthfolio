import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { QueryKeys } from "@/lib/query-keys";

import { searchCashActivities } from "../adapters/cash-activities";
import type {
  CashActivitySearchRequest,
  CashActivitySearchResponse,
  CashActivity,
} from "../types/cash-activity";

const PAGE_SIZE = 50;

/**
 * Server-side cash-activity search with infinite scroll. Mirrors the shape of
 * the main activity page's `useActivitySearch` so the Transactions page can
 * lean on the same UX pattern (debounced search, load-more, total count).
 */
export function useCashActivitySearch(
  request: Omit<CashActivitySearchRequest, "offset" | "limit">,
  options: { pageSize?: number; enabled?: boolean } = {},
) {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const enabled = options.enabled ?? true;

  const query = useInfiniteQuery<CashActivitySearchResponse, Error>({
    // React Query structurally compares keys, so we can pass the request object
    // directly without stringifying.
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "search", request, pageSize],
    queryFn: ({ pageParam = 0 }) =>
      searchCashActivities({
        ...request,
        offset: pageParam as number,
        limit: pageSize,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const fetched = allPages.reduce((sum, p) => sum + p.items.length, 0);
      return fetched < lastPage.totalCount ? fetched : undefined;
    },
    enabled,
  });

  const items: CashActivity[] = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );
  const totalCount = query.data?.pages[0]?.totalCount ?? 0;

  return {
    items,
    totalCount,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    isError: query.isError,
    hasNextPage: query.hasNextPage ?? false,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
    error: query.error,
  };
}

/**
 * Page-at-a-time variant of {@link useCashActivitySearch}, for the transactions
 * grid (edit mode). The grid is paginated rather than infinite because its body
 * is `contain: strict` with no scroll-end hook, so it cannot host a load-more
 * sentinel the way the view-mode table does.
 *
 * Kept separate from `useCashActivitySearch` rather than folded into it as a
 * `mode` switch, so view mode keeps its exact current behaviour.
 */
export function useCashActivityPage(
  request: Omit<CashActivitySearchRequest, "offset" | "limit">,
  options: { pageIndex: number; pageSize?: number; enabled?: boolean },
) {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const { pageIndex, enabled = true } = options;

  const query = useQuery<CashActivitySearchResponse, Error>({
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "page", request, pageIndex, pageSize],
    queryFn: () =>
      searchCashActivities({
        ...request,
        offset: pageIndex * pageSize,
        limit: pageSize,
      }),
    // Keeps the previous page on screen while the next one loads, so the grid
    // does not collapse to zero rows and lose scroll/focus between pages.
    placeholderData: keepPreviousData,
    enabled,
  });

  const items: CashActivity[] = useMemo(() => query.data?.items ?? [], [query.data]);
  const totalCount = query.data?.totalCount ?? 0;

  return {
    items,
    totalCount,
    pageCount: Math.ceil(totalCount / pageSize) || 1,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    refetch: query.refetch,
    error: query.error,
  };
}

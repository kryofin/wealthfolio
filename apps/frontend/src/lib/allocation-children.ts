import type { CategoryAllocation } from "@/lib/types";

/** Mirrors `RESIDUAL_CATEGORY_SUFFIX` in `crates/core/src/portfolio/allocation/allocation_service.rs`. */
const RESIDUAL_SUFFIX = ":__residual__";

/**
 * A residual row holds the part of a category carrying no sub-category assignment (e.g. holdings
 * classified as "Fixed Income" but no bond type). The backend emits it so drill-downs always
 * account for their parent, naming it in English for consumers that don't know the marker.
 */
export function isResidualCategoryId(categoryId: string): boolean {
  return categoryId.endsWith(RESIDUAL_SUFFIX);
}

/** Drill-down children of a category, with any residual row renamed in the user's language. */
export function namedChildren(
  category: CategoryAllocation,
  residualName: (categoryName: string) => string,
): CategoryAllocation[] {
  return (category.children ?? []).map((child) =>
    isResidualCategoryId(child.categoryId)
      ? { ...child, categoryName: residualName(category.categoryName) }
      : child,
  );
}

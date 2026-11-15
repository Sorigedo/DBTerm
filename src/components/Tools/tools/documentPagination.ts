export type MeasuredPagination<T> = {
  pages: T[][]
  dropped: T[]
}

export function paginateMeasuredItems<T>(
  items: T[],
  fits: (chunk: T[]) => boolean,
): MeasuredPagination<T> {
  const pages: T[][] = []
  const dropped: T[] = []
  let page: T[] = []

  for (const item of items) {
    const candidate = [...page, item]
    if (fits(candidate)) {
      page = candidate
      continue
    }
    if (page.length > 0) {
      pages.push(page)
      page = []
    }
    if (fits([item])) {
      page = [item]
    } else {
      pages.push([item])
      dropped.push(item)
      page = []
    }
  }

  if (page.length > 0) pages.push(page)
  return { pages, dropped }
}

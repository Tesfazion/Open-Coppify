/** Join conditional class names. A dependency-free alternative to `clsx`. */
export type ClassValue = string | number | false | null | undefined

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ')
}

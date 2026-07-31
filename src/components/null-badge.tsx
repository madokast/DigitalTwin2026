/** DB null 展示：斜体淡色 Null，不可选中复制 */
export function NullBadge() {
  return (
    <span className="italic text-muted-foreground select-none" aria-label="空值">
      Null
    </span>
  )
}

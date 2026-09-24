async function copyImageToClipboard(src: string): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
  try {
    const blob = await fetch(src).then((response) => response.blob());
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    return true;
  } catch { return false; }
}

function handleRovingMenuKeyDown(event: React.KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled), [role='menuitemradio']:not(:disabled)"));
  if (!items.length) return;
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : event.key === "ArrowDown"
        ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
  event.preventDefault();
  items[nextIndex]?.focus();
}

export { copyImageToClipboard, handleRovingMenuKeyDown };

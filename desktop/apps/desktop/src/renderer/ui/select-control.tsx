import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@pfsaa/ui-system";

export interface SelectControlOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface SelectControlProps {
  value: string;
  options: SelectControlOption[];
  onChange: (value: string) => void;
  "aria-label": string;
  testId?: string;
  disabled?: boolean;
  className?: string;
}

function firstEnabledIndex(options: SelectControlOption[]) {
  return options.findIndex((option) => !option.disabled);
}

function nextEnabledIndex(options: SelectControlOption[], start: number, direction: 1 | -1) {
  if (!options.length) return -1;
  let index = start;
  for (let count = 0; count < options.length; count += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function SelectControl({ value, options, onChange, "aria-label": ariaLabel, testId, disabled = false, className = "" }: SelectControlProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = `select-menu-${useId().replace(/:/g, "")}`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => {
    const selected = options.findIndex((option) => option.value === value && !option.disabled);
    return selected >= 0 ? selected : firstEnabledIndex(options);
  });
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: "hidden" });

  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const selectedOption = options[selectedIndex]
    ?? options.find((option) => option.value === "" && option.disabled)
    ?? options.find((option) => !option.disabled)
    ?? options[0];
  const resolvedActiveIndex = activeIndex >= 0 && !options[activeIndex]?.disabled ? activeIndex : (selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options));

  useEffect(() => {
    setPortalRoot(rootRef.current?.closest<HTMLElement>('[role="dialog"]')
      ?? rootRef.current?.closest<HTMLElement>(".overlay-root")
      ?? null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      if (!portalRoot || !triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const dialogPortal = portalRoot.getAttribute("role") === "dialog";
      const portalRect = dialogPortal ? portalRoot.getBoundingClientRect() : undefined;
      const desiredHeight = Math.min(320, Math.max(80, options.length * 42 + 14));
      const lowerBound = dialogPortal ? Math.max(0, portalRect?.top ?? 0) : 0;
      const upperBound = dialogPortal ? Math.min(window.innerHeight, portalRect?.bottom ?? window.innerHeight) : window.innerHeight;
      const spaceBelow = Math.max(0, upperBound - rect.bottom - 12);
      const spaceAbove = Math.max(0, rect.top - lowerBound - 12);
      const opensAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
      const availableHeight = Math.max(80, Math.min(320, opensAbove ? spaceAbove : spaceBelow));
      setMenuStyle({
        top: opensAbove
          ? (dialogPortal ? rect.top - (portalRect?.top ?? 0) - availableHeight - 6 : Math.max(8, rect.top - availableHeight - 6))
          : (dialogPortal ? rect.bottom - (portalRect?.top ?? 0) + 6 : rect.bottom + 6),
        left: dialogPortal ? rect.left - (portalRect?.left ?? 0) : rect.left,
        minWidth: Math.max(rect.width, 220),
        width: Math.max(rect.width, 220),
        maxHeight: availableHeight,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, options.length, portalRoot]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[resolvedActiveIndex]?.focus();
  }, [open, resolvedActiveIndex]);

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setActiveIndex(index);
    closeAndRestoreFocus();
  }

  function openMenu(index = selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options)) {
    if (disabled || !options.length) return;
    setActiveIndex(index >= 0 ? index : firstEnabledIndex(options));
    setOpen(true);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); openMenu(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); openMenu(selectedIndex >= 0 ? selectedIndex : options.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (open) closeAndRestoreFocus(); else openMenu(); }
    else if (event.key === "Escape" && open) { event.preventDefault(); closeAndRestoreFocus(); }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); closeAndRestoreFocus(); return; }
    if (event.key === "Tab") { event.preventDefault(); closeAndRestoreFocus(); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(resolvedActiveIndex); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex(nextEnabledIndex(options, resolvedActiveIndex, 1)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(nextEnabledIndex(options, resolvedActiveIndex, -1)); return; }
    if (event.key === "Home") { event.preventDefault(); setActiveIndex(firstEnabledIndex(options)); return; }
    if (event.key === "End") {
      event.preventDefault();
      for (let index = options.length - 1; index >= 0; index -= 1) if (!options[index]?.disabled) { setActiveIndex(index); break; }
    }
  }

  const menu = open && <div
    ref={menuRef}
    id={menuId}
    className={`select-control-menu${portalRoot ? " portal" : ""}${portalRoot?.getAttribute("role") === "dialog" ? " dialog-portal" : ""}`}
    role="listbox"
    aria-label={ariaLabel}
    onKeyDown={onMenuKeyDown}
    style={portalRoot ? menuStyle : undefined}
  >
    {options.map((option, index) => <button
      ref={(element) => { optionRefs.current[index] = element; }}
      key={option.value}
      type="button"
      role="option"
      data-value={option.value}
      aria-selected={option.value === value}
      aria-disabled={option.disabled || undefined}
      tabIndex={index === resolvedActiveIndex ? 0 : -1}
      className={option.value === value ? "selected" : ""}
      disabled={option.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => choose(index)}
    ><span>{option.label}</span>{option.value === value && <Icon name="check" size={13} />}</button>)}
  </div>;

  return <div ref={rootRef} className={`select-control-wrap ${className}`.trim()}>
    <button
      ref={triggerRef}
      type="button"
      className="select-control"
      data-testid={testId}
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-controls={menuId}
      aria-expanded={open}
      disabled={disabled}
      onKeyDown={onTriggerKeyDown}
      onClick={() => { if (open) closeAndRestoreFocus(); else openMenu(); }}
    ><span>{selectedOption?.label ?? value}</span><Icon name="chevron" size={14} /></button>
    {portalRoot ? createPortal(menu, portalRoot) : menu}
  </div>;
}

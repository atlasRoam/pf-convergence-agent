import { useEffect, useRef } from "react";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function PaneResizeHandle({
  label,
  value,
  minimum,
  maximum,
  direction = 1,
  className = "",
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  direction?: 1 | -1;
  className?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);
  useEffect(() => () => {
    if (dragRef.current) document.body.classList.remove("is-resizing-pane");
  }, []);
  const stopDragging = (element: HTMLDivElement, pointerId: number) => {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    dragRef.current = null;
    element.classList.remove("is-active");
    document.body.classList.remove("is-resizing-pane");
  };

  return <div
    className={`pane-resize-handle ${className}`.trim()}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={Math.round(minimum)}
    aria-valuemax={Math.round(maximum)}
    aria-valuenow={Math.round(value)}
    aria-disabled={disabled || undefined}
    aria-hidden={disabled || undefined}
    tabIndex={disabled ? -1 : 0}
    onPointerDown={(event) => {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.classList.add("is-active");
      document.body.classList.add("is-resizing-pane");
    }}
    onPointerMove={(event) => {
      if (disabled) return;
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      onChange(clamp(drag.startValue + (event.clientX - drag.startX) * direction, minimum, maximum));
    }}
    onPointerUp={(event) => stopDragging(event.currentTarget, event.pointerId)}
    onPointerCancel={(event) => stopDragging(event.currentTarget, event.pointerId)}
    onLostPointerCapture={(event) => {
      dragRef.current = null;
      event.currentTarget.classList.remove("is-active");
      document.body.classList.remove("is-resizing-pane");
    }}
    onKeyDown={(event) => {
      if (disabled) return;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = value - 16 * direction;
      else if (event.key === "ArrowRight") next = value + 16 * direction;
      else if (event.key === "Home") next = minimum;
      else if (event.key === "End") next = maximum;
      if (next === null) return;
      event.preventDefault();
      onChange(clamp(next, minimum, maximum));
    }}
  />;
}

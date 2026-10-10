import React, { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'agent-hub-split-width';
const DEFAULT_WIDTH = 360;
const MIN_LEFT = 240;
const MIN_RIGHT = 320;

interface ResizableSplitProps {
  left: React.ReactNode;
  right: React.ReactNode;
  className?: string;
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n) && n >= MIN_LEFT) return n;
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

export const ResizableSplit: React.FC<ResizableSplitProps> = ({
  left,
  right,
  className = '',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);

  const clampWidth = useCallback((raw: number) => {
    const total = containerRef.current?.clientWidth ?? 1200;
    const maxLeft = Math.max(MIN_LEFT, total - MIN_RIGHT);
    return Math.min(maxLeft, Math.max(MIN_LEFT, raw));
  }, []);

  useEffect(() => {
    setLeftWidth((w) => clampWidth(w));
  }, [clampWidth]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = clampWidth(e.clientX - rect.left);
      setLeftWidth(next);
    };

    const onUp = () => {
      setDragging(false);
      setLeftWidth((w) => {
        try {
          localStorage.setItem(STORAGE_KEY, String(w));
        } catch {
          /* ignore */
        }
        return w;
      });
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, clampWidth]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setLeftWidth((w) => {
        const next = clampWidth(w - step);
        try {
          localStorage.setItem(STORAGE_KEY, String(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setLeftWidth((w) => {
        const next = clampWidth(w + step);
        try {
          localStorage.setItem(STORAGE_KEY, String(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    }
  };

  return (
    <div ref={containerRef} className={`flex flex-1 min-h-0 overflow-hidden ${className}`}>
      <div style={{ width: leftWidth }} className="shrink-0 h-full overflow-hidden">
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(leftWidth)}
        aria-valuemin={MIN_LEFT}
        tabIndex={0}
        className="split-handle"
        data-dragging={dragging ? 'true' : 'false'}
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex-1 min-w-0 h-full overflow-hidden">{right}</div>
    </div>
  );
};

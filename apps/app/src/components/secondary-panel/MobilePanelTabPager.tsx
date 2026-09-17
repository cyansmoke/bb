import { useRef, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { TabPill } from "@/components/ui/tab-pill";

interface MobilePanelTab {
  id: string;
  label: string;
  leadingVisual: ReactNode;
  onSelect: () => void;
  onClose: (() => void) | null;
}

interface MobilePanelTabPagerProps {
  activeTabId: string | null;
  tabs: readonly MobilePanelTab[];
  newTabControl: ReactNode;
}

export function MobilePanelTabPager({
  activeTabId,
  tabs,
  newTabControl,
}: MobilePanelTabPagerProps) {
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  const activeTab = tabs[activeIndex];
  const previousTab = tabs[activeIndex - 1];
  const nextTab = activeIndex < 0 ? undefined : tabs[activeIndex + 1];

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1"
      data-testid="mobile-panel-tab-pager"
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground/70 [&_[data-icon-root]]:size-3.5"
        aria-label="Previous tab"
        disabled={previousTab === undefined}
        onClick={() => previousTab?.onSelect()}
      >
        <Icon name="ChevronLeft" />
      </Button>
      <div
        className="min-w-0 flex-1 touch-pan-y overflow-hidden [&>div]:w-full [&>div>button:first-child]:w-full [&_[data-tab-pill-close]]:text-muted-foreground/70 [&_[data-tab-pill-close]_[data-icon-root]]:size-3.5"
        onTouchStart={(event) => {
          suppressClick.current = false;
          const touch = event.touches[0];
          touchStart.current =
            event.touches.length === 1 && touch
              ? { x: touch.clientX, y: touch.clientY }
              : null;
        }}
        onTouchCancel={() => {
          touchStart.current = null;
        }}
        onTouchEnd={(event) => {
          const start = touchStart.current;
          touchStart.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch) return;
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (Math.abs(dx) < 30 || Math.abs(dx) <= Math.abs(dy)) return;
          suppressClick.current = true;
          (dx < 0 ? nextTab : previousTab)?.onSelect();
        }}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {activeTab ? (
          <TabPill
            label={activeTab.label}
            leadingVisual={activeTab.leadingVisual}
            title={activeTab.label}
            isActive
            onSelect={activeTab.onSelect}
            labelMaxWidthClass="max-w-full"
            enlargeCloseTargetOnCoarsePointer
            closeAction={
              activeTab.onClose === null
                ? null
                : {
                    onClose: activeTab.onClose,
                    closeLabel: `Close ${activeTab.label}`,
                  }
            }
          />
        ) : null}
      </div>
      {newTabControl}
      <Button
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground/70 [&_[data-icon-root]]:size-3.5"
        aria-label="Next tab"
        disabled={nextTab === undefined}
        onClick={() => nextTab?.onSelect()}
      >
        <Icon name="ChevronRight" />
      </Button>
    </div>
  );
}

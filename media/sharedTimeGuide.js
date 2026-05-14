// Shared right-side time guide for webviews.
(function (global) {
  "use strict";

  const HIDE_DELAY_MS = 1700;
  const SCROLL_REVEAL_DELAY_MS = 180;
  const USER_SCROLL_INTENT_MS = 900;
  const CURRENT_REFERENCE_RATIO = 0.28;
  const CURRENT_REFERENCE_MAX_PX = 180;
  const TOOLTIP_DOT_HIT_PADDING_PX = 10;
  const TOOLTIP_RAIL_HIT_WIDTH_PX = 26;

  function createTimeGuide(options) {
    return new TimeGuide(options || {});
  }

  class TimeGuide {
    constructor(options) {
      this.options = options || {};
      this.guide = null;
      this.rail = null;
      this.hoverRail = null;
      this.scrollRoot = null;
      this.contentElement = null;
      this.currentItems = [];
      this.currentPeriods = [];
      this.currentScale = "";
      this.updateFrame = 0;
      this.revealTimer = 0;
      this.scrollRevealTimer = 0;
      this.hoverTimer = 0;
      this.activeTooltipTick = null;
      this.userScrollIntentUntil = 0;
      this.scrollbarDragActive = false;
      this.resizeObserver = null;
      this.observedScrollRoot = null;
      this.handleObservedResize = () => this.scheduleUpdate();
      this.handleWheelIntent = (event) => this.handleWheelEvent(event);
      this.handleTouchIntent = () => this.markUserScrollIntent();
      this.handlePointerDownIntent = (event) => this.handlePointerDownEvent(event);
      this.handleDocumentPointerDown = (event) => this.handleDocumentPointerDownEvent(event);
      this.handleGuideMouseMove = (event) => this.handleGuideMouseMoveEvent(event);
      this.handleGuideMouseLeave = () => {
        this.clearTooltipActiveTick();
        this.scheduleHideHover();
      };
      this.handlePointerMoveIntent = () => {
        if (this.scrollbarDragActive) this.markUserScrollIntent();
      };
      this.handlePointerUpIntent = () => {
        this.scrollbarDragActive = false;
      };
      this.handleKeyIntent = (event) => this.handleKeyEvent(event);
    }

    update() {
      this.updateFrame = 0;
      this.syncContentObserver();
      const host = this.getHost();
      const guide = this.ensureGuide(host);
      if (!guide) return;

      const items = this.getItems();
      const periods = this.buildPeriods(items);
      this.currentItems = Array.isArray(this.activeItems) ? this.activeItems : items;
      this.currentPeriods = periods;
      this.currentScale = periods.length > 0 ? periods[0].scale || "" : "";

      const minItems = Number.isFinite(Number(this.options.minItems)) ? Math.max(1, Number(this.options.minItems)) : 1;
      const shouldHide =
        periods.length < minItems || (this.options.requireScrollable === true && !this.isScrollable());
      guide.hidden = shouldHide;
      guide.setAttribute("aria-label", this.getAriaLabel());
      if (shouldHide) {
        if (this.rail) this.rail.textContent = "";
        return;
      }

      this.renderPeriods(periods);
      this.updateCurrent();
    }

    scheduleUpdate() {
      if (this.updateFrame) return;
      this.updateFrame = requestAnimationFrame(() => this.update());
    }

    handleScroll() {
      this.scheduleCurrentUpdate();
      if (this.shouldRevealForScroll()) this.scheduleRevealTemporarily();
    }

    updateCurrent() {
      const guide = this.guide;
      if (!guide || guide.hidden) return;
      const ticks = Array.from(guide.querySelectorAll(".dateGuideTick")).filter((item) => item instanceof HTMLElement);
      if (ticks.length === 0) return;

      const activeItem = this.findCurrentItem();
      const activeKey = activeItem ? this.getActiveKey(activeItem) : "";
      for (const tick of ticks) {
        const isCurrent = !!activeKey && tick.dataset.key === activeKey;
        tick.classList.toggle("dateGuideTick-current", isCurrent);
        if (isCurrent) tick.setAttribute("aria-current", "true");
        else tick.removeAttribute("aria-current");
      }
    }

    scheduleCurrentUpdate() {
      if (this.currentUpdateFrame) return;
      this.currentUpdateFrame = requestAnimationFrame(() => {
        this.currentUpdateFrame = 0;
        this.updateCurrent();
      });
    }

    dispose() {
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.resizeObserver = null;
      this.detachScrollIntentListeners();
      if (this.guide && this.guide.parentNode) this.guide.parentNode.removeChild(this.guide);
      this.guide = null;
      this.rail = null;
      this.hoverRail = null;
      this.contentElement = null;
      this.activeTooltipTick = null;
      if (this.updateFrame) cancelAnimationFrame(this.updateFrame);
      if (this.currentUpdateFrame) cancelAnimationFrame(this.currentUpdateFrame);
      if (this.revealTimer) window.clearTimeout(this.revealTimer);
      if (this.scrollRevealTimer) window.clearTimeout(this.scrollRevealTimer);
      if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
      document.body.classList.remove("dateGuideScrolling", "dateGuideHovering");
    }

    getHost() {
      if (typeof this.options.getHost === "function") {
        const host = this.options.getHost();
        if (host instanceof HTMLElement) return host;
      }
      return document.body;
    }

    getRoot() {
      if (typeof this.options.getScrollRoot === "function") {
        const root = this.options.getScrollRoot();
        if (root instanceof HTMLElement) return root;
      }
      const root = document.getElementById("scrollRoot");
      return root instanceof HTMLElement ? root : document.scrollingElement || document.documentElement;
    }

    getContentElement() {
      if (typeof this.options.getContentElement === "function") {
        const element = this.options.getContentElement();
        if (element instanceof HTMLElement) return element;
      }
      return null;
    }

    getAriaLabel() {
      if (typeof this.options.getAriaLabel === "function") {
        const label = this.options.getAriaLabel();
        if (typeof label === "string" && label.trim()) return label.trim();
      }
      return "Dates";
    }

    getItems() {
      const rawItems = typeof this.options.getItems === "function" ? this.options.getItems() : [];
      if (!Array.isArray(rawItems)) return [];
      return rawItems
        .map((item, index) => normalizeGuideItem(item, index))
        .filter((item) => item && item.element instanceof HTMLElement);
    }

    ensureGuide(host) {
      if (!(host instanceof HTMLElement)) return null;
      if (!this.guide || !this.guide.isConnected || this.guide.parentElement !== host) {
        this.guide = document.createElement("aside");
        this.guide.className = "dateGuide";
        this.hoverRail = document.createElement("div");
        this.hoverRail.className = "dateGuideHoverRail";
        this.hoverRail.setAttribute("aria-hidden", "true");
        this.hoverRail.addEventListener("mouseenter", () => this.revealForHover());
        this.hoverRail.addEventListener("mouseleave", this.handleGuideMouseLeave);
        this.rail = document.createElement("div");
        this.rail.className = "dateGuideTimeline";
        this.guide.appendChild(this.hoverRail);
        this.guide.appendChild(this.rail);
        host.appendChild(this.guide);
      }
      return this.guide;
    }

    syncContentObserver() {
      this.syncScrollIntentListeners();
      const element = this.getContentElement();
      if (element === this.contentElement) return;
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.contentElement = element;
      if (element instanceof HTMLElement && typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(this.handleObservedResize);
        this.resizeObserver.observe(element);
      } else {
        this.resizeObserver = null;
      }
    }

    syncScrollIntentListeners() {
      const root = this.getRoot();
      if (!(root instanceof HTMLElement) || root === this.observedScrollRoot) return;
      this.detachScrollIntentListeners();
      this.observedScrollRoot = root;
      root.addEventListener("wheel", this.handleWheelIntent, { passive: true });
      root.addEventListener("touchmove", this.handleTouchIntent, { passive: true });
      root.addEventListener("pointerdown", this.handlePointerDownIntent, { passive: true });
      document.addEventListener("pointerdown", this.handleDocumentPointerDown, { capture: true });
      window.addEventListener("pointermove", this.handlePointerMoveIntent, { passive: true });
      window.addEventListener("pointerup", this.handlePointerUpIntent, { passive: true });
      window.addEventListener("pointercancel", this.handlePointerUpIntent, { passive: true });
      window.addEventListener("keydown", this.handleKeyIntent, { capture: true });
    }

    detachScrollIntentListeners() {
      const root = this.observedScrollRoot;
      if (root instanceof HTMLElement) {
        root.removeEventListener("wheel", this.handleWheelIntent);
        root.removeEventListener("touchmove", this.handleTouchIntent);
        root.removeEventListener("pointerdown", this.handlePointerDownIntent);
      }
      window.removeEventListener("pointermove", this.handlePointerMoveIntent);
      window.removeEventListener("pointerup", this.handlePointerUpIntent);
      window.removeEventListener("pointercancel", this.handlePointerUpIntent);
      document.removeEventListener("pointerdown", this.handleDocumentPointerDown, { capture: true });
      window.removeEventListener("keydown", this.handleKeyIntent, { capture: true });
      this.observedScrollRoot = null;
      this.scrollbarDragActive = false;
    }

    buildPeriods(items) {
      const mode = this.options.mode === "timeline" ? "timeline" : "date";
      return mode === "timeline" ? this.buildTimelinePeriods(items) : this.buildDatePeriods(items);
    }

    buildDatePeriods(items) {
      const dateItems = items.filter((item) => isDateKey(item.dateKey));
      this.activeItems = dateItems;
      const seenDates = new Set();
      const dateKeys = [];
      for (const item of dateItems) {
        if (seenDates.has(item.dateKey)) continue;
        seenDates.add(item.dateKey);
        dateKeys.push(item.dateKey);
      }
      dateKeys.sort();
      if (dateKeys.length === 0) return [];

      const firstDate = parseLocalDateKey(dateKeys[0]);
      const lastDate = parseLocalDateKey(dateKeys[dateKeys.length - 1]);
      if (!firstDate || !lastDate) return [];

      const rangeDays = Math.max(0, Math.round((lastDate.getTime() - firstDate.getTime()) / 86400000));
      const scale = chooseDateGuideScale(dateKeys, rangeDays);
      const entries = buildDateGuideEntries(dateItems, scale);
      const allSameYear = dateKeys.every((dateKey) => dateKey.slice(0, 4) === dateKeys[0].slice(0, 4));
      const allSameMonth = dateKeys.every((dateKey) => dateKey.slice(0, 7) === dateKeys[0].slice(0, 7));
      let previousYear = "";
      let previousMonth = "";

      const periods = entries.map((entry, index) => {
        const position = this.resolvePosition(entry.item, entry.item.itemIndex, dateItems.length);
        const major = isMajorDateGuideEntry(entry.key, scale, index, {
          allSameYear,
          allSameMonth,
          previousYear,
          previousMonth,
          total: entries.length,
        });
        previousYear = entry.key.slice(0, 4);
        previousMonth = entry.key.slice(0, 7);
        return {
          key: entry.key,
          scale,
          major,
          label: major ? formatDateGuideLabel(entry.key, scale, { allSameYear, allSameMonth }) : "",
          position,
          tooltip: formatDateGuideTitle(entry.key, scale),
          targetElement: entry.item.element,
        };
      });
      return thinGuideLabels(periods, this.estimateGuideHeight());
    }

    buildTimelinePeriods(items) {
      const timeZone = this.getTimeZone();
      const timeItems = items
        .map((item) => normalizeTimelineItem(item, timeZone))
        .filter((item) => item && Number.isFinite(item.timestampMs));
      this.activeItems = timeItems;
      if (timeItems.length === 0) return [];

      const sortedByTime = [...timeItems].sort((a, b) => a.timestampMs - b.timestampMs);
      const first = sortedByTime[0];
      const last = sortedByTime[sortedByTime.length - 1];
      const rangeMs = Math.max(0, last.timestampMs - first.timestampMs);
      const labelBudget = Math.max(2, Math.floor(this.estimateGuideHeight() / 28));
      const labelKind = chooseTimelineLabelKind(timeItems, rangeMs, labelBudget);
      const labelAll = timeItems.length <= labelBudget;
      const marked = markTimelineLabels(timeItems, labelKind, labelAll);
      const periods = marked.map((entry) => ({
        key: entry.key,
        scale: labelKind,
        major: entry.major,
        label: entry.major ? formatTimelineLabel(entry.parts, labelKind, entry.context) : "",
        position: this.resolvePosition(entry, entry.itemIndex, timeItems.length),
        tooltip: formatTimelineTooltip(entry, timeZone),
        targetElement: entry.element,
      }));
      return thinGuideLabels(periods, this.estimateGuideHeight());
    }

    getTimeZone() {
      if (typeof this.options.getTimeZone === "function") {
        const value = this.options.getTimeZone();
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return "";
    }

    resolvePosition(item, index, total) {
      const strategy = this.options.positionStrategy === "scroll" ? "scroll" : "index";
      if (strategy === "scroll") {
        const position = this.resolveScrollPosition(item.element);
        if (Number.isFinite(position)) return position;
      }
      if (total <= 1) return 0;
      const rawPosition = (Math.max(0, index) / Math.max(1, total - 1)) * 100;
      return Math.max(1, Math.min(99, rawPosition));
    }

    resolveScrollPosition(element) {
      const root = this.getRoot();
      if (!(root instanceof HTMLElement) || !(element instanceof HTMLElement)) return NaN;
      const rootRect = root.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const maxScroll = Math.max(1, root.scrollHeight - root.clientHeight);
      const top = root.scrollTop + elementRect.top - rootRect.top;
      return Math.max(1, Math.min(99, (top / maxScroll) * 100));
    }

    renderPeriods(periods) {
      const rail = this.rail;
      if (!(rail instanceof HTMLElement)) return;
      rail.textContent = "";
      this.activeTooltipTick = null;
      for (const period of periods) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `dateGuideTick dateGuideTick-${period.scale || "item"} ${
          period.major ? "dateGuideTick-major" : "dateGuideTick-minor"
        }`;
        btn.style.setProperty("--pos", `${period.position}%`);
        btn.dataset.key = period.key;
        btn.dataset.scale = period.scale || "";
        btn.dataset.tooltip = period.tooltip || "";
        btn.setAttribute("aria-label", period.tooltip || period.label || period.key);
        btn.addEventListener("click", () => this.activatePeriod(period, btn));

        const label = document.createElement("span");
        label.className = "dateGuideLabel";
        label.textContent = period.label || "";
        const dot = document.createElement("span");
        dot.className = "dateGuideDot";
        const hit = document.createElement("span");
        hit.className = "dateGuideHit";
        hit.setAttribute("aria-hidden", "true");
        hit.addEventListener("mouseenter", (event) => {
          this.revealForHover();
          this.handleGuideMouseMoveEvent(event);
        });
        hit.addEventListener("mousemove", this.handleGuideMouseMove);
        hit.addEventListener("mouseleave", this.handleGuideMouseLeave);
        hit.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.activatePeriod(period, btn);
        });
        btn.appendChild(label);
        btn.appendChild(dot);
        btn.appendChild(hit);
        rail.appendChild(btn);
      }
    }

    activatePeriod(period, button) {
      this.scrollToPeriod(period);
      if (button instanceof HTMLElement) button.blur();
      this.scheduleHideHover();
    }

    scrollToPeriod(period) {
      const target = period && period.targetElement instanceof HTMLElement ? period.targetElement : null;
      if (!target) return;
      scrollElementIntoRootView(this.getRoot(), target, { behavior: "smooth", block: "start" });
      target.classList.add("highlight");
      window.setTimeout(() => target.classList.remove("highlight"), 2000);
    }

    findCurrentItem() {
      const items = this.currentItems.filter((item) => item.element instanceof HTMLElement);
      if (items.length === 0) return null;
      const root = this.getRoot();
      const rootRect = root.getBoundingClientRect();
      const referenceTop = rootRect.top + Math.min(rootRect.height * CURRENT_REFERENCE_RATIO, CURRENT_REFERENCE_MAX_PX);
      let current = items[0];
      for (const item of items) {
        const rect = item.element.getBoundingClientRect();
        if (rect.top <= referenceTop) current = item;
        else break;
      }
      return current;
    }

    getActiveKey(item) {
      if (!item) return "";
      if (this.options.mode === "timeline") return item.key || "";
      return buildDateKeyForScale(item.dateKey, this.currentScale || "day");
    }

    revealTemporarily() {
      document.body.classList.add("dateGuideScrolling");
      if (this.revealTimer) window.clearTimeout(this.revealTimer);
      if (this.scrollRevealTimer) {
        window.clearTimeout(this.scrollRevealTimer);
        this.scrollRevealTimer = 0;
      }
      this.revealTimer = window.setTimeout(() => {
        document.body.classList.remove("dateGuideScrolling");
        this.revealTimer = 0;
      }, HIDE_DELAY_MS);
    }

    scheduleRevealTemporarily() {
      if (document.body.classList.contains("dateGuideScrolling")) {
        this.revealTemporarily();
        return;
      }
      if (this.scrollRevealTimer) return;
      this.scrollRevealTimer = window.setTimeout(() => {
        this.scrollRevealTimer = 0;
        if (this.shouldRevealForScroll()) this.revealTemporarily();
      }, SCROLL_REVEAL_DELAY_MS);
    }

    handleWheelEvent(event) {
      if (!isEventInsideRoot(event, this.getRoot())) return;
      this.markUserScrollIntent();
    }

    handlePointerDownEvent(event) {
      if (!isEventInsideRoot(event, this.getRoot())) return;
      if (!isLikelyScrollbarPointer(event, this.getRoot())) return;
      this.scrollbarDragActive = true;
      this.markUserScrollIntent();
    }

    handleDocumentPointerDownEvent(event) {
      if (!this.isGuideShowing()) return;
      if (this.isPointerInsideGuide(event)) return;
      this.hideImmediately();
    }

    handleKeyEvent(event) {
      if (!isScrollKeyEvent(event)) return;
      if (isEditableEventTarget(event.target)) return;
      if (event.key === " " && isButtonLikeEventTarget(event.target)) return;
      this.markUserScrollIntent();
    }

    markUserScrollIntent() {
      this.userScrollIntentUntil = Date.now() + USER_SCROLL_INTENT_MS;
    }

    shouldRevealForScroll() {
      return Date.now() <= this.userScrollIntentUntil || this.scrollbarDragActive;
    }

    revealForHover() {
      document.body.classList.add("dateGuideHovering");
      if (this.hoverTimer) {
        window.clearTimeout(this.hoverTimer);
        this.hoverTimer = 0;
      }
    }

    handleGuideMouseMoveEvent(event) {
      const target = event && event.target instanceof HTMLElement ? event.target : null;
      const tick = target ? target.closest(".dateGuideTick") : null;
      if (!(tick instanceof HTMLElement) || !this.isPointerNearTickMark(event, tick)) {
        this.setTooltipActiveTick(null);
        return;
      }
      this.setTooltipActiveTick(tick);
    }

    isPointerNearTickMark(event, tick) {
      if (!event || !(tick instanceof HTMLElement)) return false;
      const dot = tick.querySelector(".dateGuideDot");
      if (dot instanceof HTMLElement) {
        const dotRect = dot.getBoundingClientRect();
        if (
          event.clientX >= dotRect.left - TOOLTIP_DOT_HIT_PADDING_PX &&
          event.clientX <= dotRect.right + TOOLTIP_DOT_HIT_PADDING_PX &&
          event.clientY >= dotRect.top - TOOLTIP_DOT_HIT_PADDING_PX &&
          event.clientY <= dotRect.bottom + TOOLTIP_DOT_HIT_PADDING_PX
        ) {
          return true;
        }
      }
      const tickRect = tick.getBoundingClientRect();
      return (
        event.clientX >= tickRect.right - TOOLTIP_RAIL_HIT_WIDTH_PX &&
        event.clientX <= tickRect.right + 2 &&
        event.clientY >= tickRect.top - 3 &&
        event.clientY <= tickRect.bottom + 3
      );
    }

    setTooltipActiveTick(tick) {
      if (this.activeTooltipTick === tick) return;
      this.clearTooltipActiveTick();
      if (tick instanceof HTMLElement) {
        tick.classList.add("dateGuideTick-tooltipActive");
        this.activeTooltipTick = tick;
      }
    }

    clearTooltipActiveTick() {
      if (this.activeTooltipTick instanceof HTMLElement) {
        this.activeTooltipTick.classList.remove("dateGuideTick-tooltipActive");
      }
      this.activeTooltipTick = null;
    }

    scheduleHideHover() {
      this.clearTooltipActiveTick();
      document.body.classList.add("dateGuideHovering");
      if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => {
        document.body.classList.remove("dateGuideHovering");
        this.hoverTimer = 0;
      }, HIDE_DELAY_MS);
    }

    hideImmediately() {
      this.clearTooltipActiveTick();
      if (this.hoverTimer) {
        window.clearTimeout(this.hoverTimer);
        this.hoverTimer = 0;
      }
      if (this.revealTimer) {
        window.clearTimeout(this.revealTimer);
        this.revealTimer = 0;
      }
      if (this.scrollRevealTimer) {
        window.clearTimeout(this.scrollRevealTimer);
        this.scrollRevealTimer = 0;
      }
      document.body.classList.remove("dateGuideHovering", "dateGuideScrolling");
    }

    isGuideShowing() {
      const guide = this.guide;
      if (!(guide instanceof HTMLElement) || guide.hidden) return false;
      return (
        document.body.classList.contains("dateGuideHovering") ||
        document.body.classList.contains("dateGuideScrolling")
      );
    }

    isPointerInsideGuide(event) {
      const guide = this.guide;
      if (!(guide instanceof HTMLElement) || !event) return false;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && guide.contains(target)) return true;
      const rect = guide.getBoundingClientRect();
      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    }

    estimateGuideHeight() {
      const guide = this.rail;
      const height = guide instanceof HTMLElement ? guide.getBoundingClientRect().height : 0;
      if (height > 0) return height;
      return Math.max(180, window.innerHeight - 80);
    }

    isScrollable() {
      const root = this.getRoot();
      if (!(root instanceof HTMLElement)) return true;
      return root.scrollHeight > root.clientHeight * 1.2;
    }
  }

  function normalizeGuideItem(item, index) {
    if (!item || typeof item !== "object") return null;
    const element = item.element instanceof HTMLElement ? item.element : null;
    if (!element) return null;
    const timestampIso = typeof item.timestampIso === "string" ? item.timestampIso.trim() : "";
    const dateKey = typeof item.dateKey === "string" ? item.dateKey.trim() : "";
    return {
      key: typeof item.key === "string" && item.key.trim() ? item.key.trim() : `item-${index}`,
      element,
      timestampIso,
      timestampMs: Number.isFinite(Number(item.timestampMs)) ? Number(item.timestampMs) : Date.parse(timestampIso),
      dateKey,
      title: typeof item.title === "string" ? item.title.trim() : "",
      tooltip: typeof item.tooltip === "string" ? item.tooltip.trim() : "",
      tooltipOverride: typeof item.tooltipOverride === "string" ? item.tooltipOverride.trim() : "",
      itemIndex: Number.isFinite(Number(item.itemIndex)) ? Number(item.itemIndex) : index,
    };
  }

  function isEventInsideRoot(event, root) {
    if (!(root instanceof HTMLElement)) return true;
    const target = event && event.target;
    if (target instanceof Node && root.contains(target)) return true;
    return root === document.documentElement || root === document.body || root === document.scrollingElement;
  }

  function isLikelyScrollbarPointer(event, root) {
    if (!(root instanceof HTMLElement)) return false;
    if (event.button !== 0) return false;
    if (isInteractivePointerTarget(event.target, root)) return false;
    const rect = root.getBoundingClientRect();
    const scrollbarWidth = Math.max(12, root.offsetWidth - root.clientWidth);
    const verticalScrollbar = root.scrollHeight > root.clientHeight;
    const horizontalScrollbar = root.scrollWidth > root.clientWidth;
    const nearVerticalScrollbar =
      verticalScrollbar && event.clientX >= rect.right - scrollbarWidth - 4 && event.clientX <= rect.right + 2;
    const nearHorizontalScrollbar =
      horizontalScrollbar && event.clientY >= rect.bottom - scrollbarWidth - 4 && event.clientY <= rect.bottom + 2;
    return nearVerticalScrollbar || nearHorizontalScrollbar;
  }

  function isInteractivePointerTarget(target, root) {
    if (!(target instanceof HTMLElement)) return false;
    if (target === root) return false;
    return !!target.closest("button,a,input,textarea,select,[role='button'],.dateGuide");
  }

  function isScrollKeyEvent(event) {
    if (!event || event.altKey || event.ctrlKey || event.metaKey) return false;
    const key = event.key;
    return (
      key === "ArrowUp" ||
      key === "ArrowDown" ||
      key === "ArrowLeft" ||
      key === "ArrowRight" ||
      key === "PageUp" ||
      key === "PageDown" ||
      key === "Home" ||
      key === "End" ||
      key === " "
    );
  }

  function isEditableEventTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
    return target.isContentEditable;
  }

  function isButtonLikeEventTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest("button,a,[role='button']");
  }

  function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function parseLocalDateKey(value) {
    if (!isDateKey(value)) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function chooseDateGuideScale(dateKeys, rangeDays) {
    const uniqueMonths = new Set(dateKeys.map((dateKey) => dateKey.slice(0, 7))).size;
    if (rangeDays <= 120 && dateKeys.length <= 140) return "day";
    if (rangeDays <= 1095 && uniqueMonths <= 48) return "month";
    return "year";
  }

  function buildDateGuideEntries(items, scale) {
    const seen = new Set();
    const entries = [];
    for (const item of items) {
      const key = buildDateKeyForScale(item.dateKey, scale);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, item });
    }
    return entries;
  }

  function buildDateKeyForScale(dateKey, scale) {
    const value = String(dateKey || "");
    if (!isDateKey(value)) return "";
    if (scale === "year") return value.slice(0, 4);
    if (scale === "month") return value.slice(0, 7);
    return value;
  }

  function isMajorDateGuideEntry(key, scale, index, context) {
    if (scale === "year") return true;
    if (scale === "month") {
      if (context.allSameYear) return context.total <= 18 || index === 0;
      return index === 0 || key.slice(0, 4) !== context.previousYear;
    }
    if (context.total <= 18) return true;
    if (context.allSameMonth) return index === 0 || Number(key.slice(8, 10)) % 7 === 1;
    return index === 0 || key.slice(0, 7) !== context.previousMonth;
  }

  function formatDateGuideLabel(key, scale, context) {
    if (scale === "year") return key;
    if (scale === "month") return context.allSameYear ? formatGuideMonthLabel(key) : key.slice(0, 4);
    return formatGuideDayLabel(key);
  }

  function formatDateGuideTitle(key, scale) {
    if (scale === "year") return key;
    if (scale === "month") return formatGuideMonthTitle(key);
    return formatGuideDayTitle(key);
  }

  function normalizeTimelineItem(item, timeZone) {
    const timestampMs = Number.isFinite(Number(item.timestampMs)) ? Number(item.timestampMs) : Date.parse(item.timestampIso || "");
    if (!Number.isFinite(timestampMs)) return null;
    const parts = getDateParts(new Date(timestampMs), timeZone);
    if (!parts) return null;
    return {
      ...item,
      timestampMs,
      parts,
      key: item.key || `ts-${timestampMs}-${item.itemIndex}`,
    };
  }

  function chooseTimelineLabelKind(items, rangeMs, labelBudget) {
    const days = rangeMs / 86400000;
    const allSameDay = items.every((item) => item.parts.dateKey === items[0].parts.dateKey);
    if (allSameDay || days <= 1) return "time";
    if (days <= 3) return "dayTime";
    if (days <= 90) return "day";
    return items.length <= labelBudget ? "fullDate" : "month";
  }

  function markTimelineLabels(items, labelKind, labelAll) {
    const out = [];
    let previousHour = "";
    let previousDate = "";
    let previousMonth = "";
    let previousYear = "";
    const allSameYear = items.every((item) => item.parts.year === items[0].parts.year);

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const hourKey = `${item.parts.dateKey}T${item.parts.hour}`;
      const monthKey = `${item.parts.year}-${item.parts.month}`;
      const isFirst = i === 0;
      const isLast = i === items.length - 1;
      let major = labelAll || isFirst || isLast;
      if (!major && labelKind === "time") major = hourKey !== previousHour;
      else if (!major && labelKind === "dayTime") major = item.parts.dateKey !== previousDate;
      else if (!major && (labelKind === "day" || labelKind === "fullDate")) major = item.parts.dateKey !== previousDate;
      else if (!major && labelKind === "month") major = monthKey !== previousMonth || item.parts.year !== previousYear;

      out.push({
        ...item,
        major,
        context: {
          allSameYear,
          previousDate,
          previousMonth,
          previousYear,
        },
      });
      previousHour = hourKey;
      previousDate = item.parts.dateKey;
      previousMonth = monthKey;
      previousYear = item.parts.year;
    }
    return out;
  }

  function formatTimelineLabel(parts, labelKind, context) {
    if (!parts) return "";
    if (labelKind === "time") return `${Number(parts.hour)}:${parts.minute}`;
    if (labelKind === "dayTime") return `${Number(parts.month)}/${Number(parts.day)} ${Number(parts.hour)}:${parts.minute}`;
    if (labelKind === "month") {
      if (context && context.allSameYear) return `${Number(parts.month)}/${Number(parts.day)}`;
      return `${parts.year}/${Number(parts.month)}`;
    }
    if (labelKind === "fullDate") return `${parts.year}/${Number(parts.month)}/${Number(parts.day)}`;
    return context && context.allSameYear
      ? `${Number(parts.month)}/${Number(parts.day)}`
      : `${parts.year}/${Number(parts.month)}/${Number(parts.day)}`;
  }

  function formatTimelineTooltip(item, timeZone) {
    const override = typeof item.tooltipOverride === "string" ? item.tooltipOverride.trim() : "";
    if (override) return override;
    const timestamp = formatFullTimestamp(item.timestampMs, timeZone);
    const title = item.tooltip || item.title || "";
    return title ? `${timestamp} - ${title}` : timestamp;
  }

  function getDateParts(date, timeZone) {
    const opts = {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    };
    let parts;
    try {
      parts = new Intl.DateTimeFormat("en-US-u-nu-latn", opts).formatToParts(date);
    } catch {
      return null;
    }
    const out = {};
    for (const part of parts) {
      if (part.type !== "literal") out[part.type] = part.value;
    }
    if (!out.year || !out.month || !out.day || !out.hour || !out.minute || !out.second) return null;
    return {
      year: out.year,
      month: out.month,
      day: out.day,
      hour: out.hour,
      minute: out.minute,
      second: out.second,
      dateKey: `${out.year}-${out.month}-${out.day}`,
    };
  }

  function formatFullTimestamp(timestampMs, timeZone) {
    const parts = getDateParts(new Date(timestampMs), timeZone);
    if (!parts) return new Date(timestampMs).toISOString();
    return `${parts.year}/${Number(parts.month)}/${Number(parts.day)} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function thinGuideLabels(periods, guideHeight) {
    const out = periods.map((period) => ({ ...period }));
    const labeledIndexes = out.map((period, index) => (period.label ? index : -1)).filter((index) => index >= 0);
    if (labeledIndexes.length <= 1) return out;

    const minGapPercent = Math.max(6, Math.min(18, (22 / Math.max(180, guideHeight)) * 100));
    let lastKeptIndex = -1;
    for (const index of labeledIndexes) {
      if (lastKeptIndex >= 0 && out[index].position - out[lastKeptIndex].position < minGapPercent) {
        out[index].label = "";
        continue;
      }
      lastKeptIndex = index;
    }

    const lastOriginalIndex = labeledIndexes[labeledIndexes.length - 1];
    if (lastOriginalIndex !== undefined && !out[lastOriginalIndex].label) {
      const previousKeptIndex = findPreviousLabeledGuideIndex(out, lastOriginalIndex);
      if (previousKeptIndex < 0 || out[lastOriginalIndex].position - out[previousKeptIndex].position >= minGapPercent) {
        out[lastOriginalIndex].label = periods[lastOriginalIndex].label;
      }
    }
    return out;
  }

  function findPreviousLabeledGuideIndex(periods, beforeIndex) {
    for (let i = beforeIndex - 1; i >= 0; i -= 1) {
      if (periods[i] && periods[i].label) return i;
    }
    return -1;
  }

  function formatGuideMonthLabel(value) {
    const date = new Date(`${value}-01T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    try {
      return new Intl.DateTimeFormat(undefined, { month: "short" }).format(date);
    } catch {
      return value;
    }
  }

  function formatGuideDayLabel(value) {
    const date = parseLocalDateKey(value);
    if (!date) return value;
    try {
      return new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" }).format(date);
    } catch {
      return value.slice(5).replace("-", "/");
    }
  }

  function formatGuideMonthTitle(value) {
    const date = new Date(`${value}-01T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    try {
      return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long" }).format(date);
    } catch {
      return value;
    }
  }

  function formatGuideDayTitle(value) {
    const date = parseLocalDateKey(value);
    if (!date) return value;
    try {
      return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(date);
    } catch {
      return value;
    }
  }

  function scrollElementIntoRootView(root, element, options) {
    if (!(root instanceof HTMLElement) || !(element instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const block = options && options.block === "center" ? "center" : "start";
    const behavior = (options && options.behavior) || "auto";
    const nextTop =
      block === "center"
        ? root.scrollTop + elementRect.top - rootRect.top - rootRect.height / 2 + elementRect.height / 2
        : root.scrollTop + elementRect.top - rootRect.top;
    root.scrollTo({ top: Math.max(0, Math.floor(nextTop)), behavior });
  }

  global.CodexHistoryTimeGuide = { create: createTimeGuide };
})(window);

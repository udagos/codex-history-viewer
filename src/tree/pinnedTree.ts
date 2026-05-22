import * as path from "node:path";
import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { SessionSource, SessionSourceFilter, SessionSummary } from "../sessions/sessionTypes";
import {
  FolderNode,
  HistoryEmptyNode,
  MissingPinnedNode,
  PinnedDropHintNode,
  PinnedFoldersGroupNode,
  PinnedSessionsGroupNode,
  SessionNode,
  TreeNode,
  missingPinnedLabel,
  toTreeItemContextValue,
} from "./treeNodes";
import { getConfig } from "../settings";
import { truncateByDisplayWidth } from "../utils/textUtils";
import { t } from "../i18n";
import { buildSessionHoverTooltip } from "./sessionTooltipUtils";

// Provides the pinned sessions view.

export type PinnedViewSortMode = "pinnedAt" | "date" | "name";

export class PinnedTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
  private sourceFilter: SessionSourceFilter;
  private tagFilter: string[];
  private sortMode: PinnedViewSortMode;
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  private initialLoadComplete = false;
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    historyService: HistoryService,
    pinStore: PinStore,
    annotationStore: SessionAnnotationStore,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    sortMode: PinnedViewSortMode,
    extensionUri: vscode.Uri,
  ) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
    this.tagFilter = normalizeTagFilter(tagFilter);
    this.sortMode = sortMode;
    this.codexIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "source-codex.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "source-codex.svg"),
    };
    this.claudeIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "source-claude.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "source-claude.svg"),
    };
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public markInitialLoadComplete(): void {
    if (this.initialLoadComplete) return;
    this.initialLoadComplete = true;
    this.refresh();
  }

  public setTagFilter(tags: readonly string[]): void {
    this.tagFilter = normalizeTagFilter(tags);
  }

  public setSourceFilter(sourceFilter: SessionSourceFilter): void {
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
  }

  public setSortMode(sortMode: PinnedViewSortMode): void {
    this.sortMode = sortMode;
  }

  private matchesTags(fsPath: string, session?: SessionSummary): boolean {
    if (this.tagFilter.length === 0) return true;
    
    // Check the path itself
    if (this.pathMatchesTags(fsPath)) return true;
    
    // If session is provided, also check its folder
    if (session && session.meta.cwd && this.pathMatchesTags(session.meta.cwd)) return true;
    
    return false;
  }

  private pathMatchesTags(fsPath: string): boolean {
    const ann = this.annotationStore.get(fsPath);
    if (!ann || ann.tags.length === 0) return false;
    const tagKeys = new Set(ann.tags.map((tag) => normalizeTagKey(tag)));
    return this.tagFilter.some((tag) => tagKeys.has(normalizeTagKey(tag)));
  }

  private matchesSource(session: SessionSummary): boolean {
    if (this.sourceFilter === "all") return true;
    return session.source === this.sourceFilter;
  }

  private matchesMissingPinnedSource(fsPath: string): boolean {
    if (this.sourceFilter === "all") return true;
    const inferred = inferSourceFromFsPath(fsPath);
    if (!inferred) return true;
    return inferred === this.sourceFilter;
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof FolderNode) {
      const annotation = this.annotationStore.get(element.cwd);
      const item = new vscode.TreeItem(element.cwdShort, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = buildSessionDescription("", annotation?.tags ?? []);
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.tooltip = annotation?.note ? `${element.cwd}\n\n${annotation.note}` : element.cwd;
      return item;
    }
    if (element instanceof PinnedFoldersGroupNode) {
      const item = new vscode.TreeItem(t("tree.pinned.folders"), vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("folder-opened");
      return item;
    }
    if (element instanceof PinnedSessionsGroupNode) {
      const item = new vscode.TreeItem(t("tree.pinned.sessions"), vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("history");
      return item;
    }
    if (element instanceof SessionNode) {
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.displayTitle, 40, "...");
      const annotation = this.annotationStore.get(element.session.fsPath);
      const item = new vscode.TreeItem(
        `${element.session.localDate} ${element.session.timeLabel} ${shortTitle}`,
      );
      item.description = buildSessionDescription(element.session.cwdShort, annotation?.tags ?? []);
      item.contextValue = toTreeItemContextValue(element);
      // Show source-specific icons (Codex/Claude) in the list row.
      item.iconPath = this.resolveSourceIconPath(element.session.source);

      // Clicking the title opens the reusable viewer or a session tab depending on the preview setting.
      const previewOnSelection = getConfig().previewOpenOnSelection;
      item.command = {
        command: previewOnSelection ? "codexHistoryViewer.openSessionReusable" : "codexHistoryViewer.openSession",
        title: "",
        arguments: [element],
      };

      item.tooltip = buildSessionHoverTooltip({
        session: element.session,
        annotation: annotation ? { tags: annotation.tags, note: annotation.note } : null,
        label: String(item.label ?? ""),
        description: typeof item.description === "string" ? item.description : undefined,
        mode: getConfig().previewTooltipMode,
      });
      return item;
    }
    if (element instanceof MissingPinnedNode) {
      const item = new vscode.TreeItem(`${missingPinnedLabel()}`);
      item.description = element.fsPath;
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("warning");
      item.tooltip = t("tree.tooltip.missingPinned", element.fsPath);
      return item;
    }
    if (element instanceof HistoryEmptyNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon(element.iconId);
      item.tooltip = element.label;
      return item;
    }
    if (element instanceof PinnedDropHintNode) {
      const item = new vscode.TreeItem(t("tree.pinned.dropHint"), vscode.TreeItemCollapsibleState.None);
      item.description = t("tree.pinned.dropHintDescription");
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("pinned");
      item.tooltip = t("tree.pinned.dropHintTooltip");
      return item;
    }
    return new vscode.TreeItem("?");
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!this.initialLoadComplete) {
      return element ? [] : [new HistoryEmptyNode(t("history.empty.loading"), "sync~spin")];
    }

    const pins = this.pinStore.getAll();
    const folderPins = [];
    const sessionPins = [];

    const index = this.historyService.getIndex();
    for (const p of pins) {
      if (index.byFolder.has(p.fsPath)) {
        folderPins.push(p);
      } else {
        sessionPins.push(p);
      }
    }

    if (!element) {
      const nodes: TreeNode[] = [];
      if (folderPins.length > 0) {
        nodes.push(new PinnedFoldersGroupNode());
      }
      if (sessionPins.length > 0 || folderPins.length === 0) {
        // Show sessions group if there are sessions, OR if everything is empty to show drop hint.
        nodes.push(new PinnedSessionsGroupNode());
      }
      return nodes;
    }

    if (element instanceof PinnedFoldersGroupNode) {
      const nodes: FolderNode[] = [];
      for (const p of folderPins) {
        if (!this.matchesTags(p.fsPath)) continue;
        const cwdShort = path.basename(p.fsPath) || p.fsPath;
        nodes.push(new FolderNode(p.fsPath, cwdShort, true));
      }
      
      this.sortFolders(nodes, folderPins);
      return nodes;
    }

    if (element instanceof PinnedSessionsGroupNode) {
      const nodes: TreeNode[] = [];
      const validPins: { node: SessionNode | MissingPinnedNode; pin: { fsPath: string; pinnedAt: number } }[] = [];
      for (const p of sessionPins) {
        const s = this.historyService.findByFsPath(p.fsPath);
        if (s) {
          if (!this.matchesSource(s)) continue;
          if (!this.matchesTags(s.fsPath, s)) continue;
          validPins.push({ node: new SessionNode(s, true), pin: p });
        } else {
          if (!this.matchesMissingPinnedSource(p.fsPath)) continue;
          if (!this.matchesTags(p.fsPath)) continue;
          validPins.push({ node: new MissingPinnedNode(p.fsPath), pin: p });
        }
      }
      
      this.sortSessions(validPins);
      if (validPins.length === 0) return [new PinnedDropHintNode()];
      return validPins.map(v => v.node);
    }

    if (element instanceof FolderNode) {
      const sessions = index.byFolder.get(element.cwd) ?? [];
      const filtered = sessions.filter((s) => {
        if (!this.matchesSource(s)) return false;
        if (!this.matchesTags(s.fsPath, s)) return false;
        return true;
      });
      return filtered.map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));
    }

    return [];
  }

  private sortFolders(nodes: FolderNode[], folderPins: { fsPath: string; pinnedAt: number }[]) {
    if (this.sortMode === "name") {
      nodes.sort((a, b) => a.cwdShort.localeCompare(b.cwdShort));
    } else {
      // For folders, 'date' and 'pinnedAt' act similarly as pinnedAt for now.
      const pinnedAtMap = new Map(folderPins.map(p => [p.fsPath, p.pinnedAt]));
      nodes.sort((a, b) => (pinnedAtMap.get(b.cwd) || 0) - (pinnedAtMap.get(a.cwd) || 0));
    }
  }

  private sortSessions(validPins: { node: SessionNode | MissingPinnedNode; pin: { fsPath: string; pinnedAt: number } }[]) {
    if (this.sortMode === "name") {
      validPins.sort((a, b) => {
        const titleA = a.node instanceof SessionNode ? a.node.session.displayTitle : a.pin.fsPath;
        const titleB = b.node instanceof SessionNode ? b.node.session.displayTitle : b.pin.fsPath;
        return titleA.localeCompare(titleB);
      });
    } else if (this.sortMode === "date") {
      validPins.sort((a, b) => {
        const dateA = a.node instanceof SessionNode ? (Date.parse(a.node.session.startedAtIso ?? "0") || 0) : 0;
        const dateB = b.node instanceof SessionNode ? (Date.parse(b.node.session.startedAtIso ?? "0") || 0) : 0;
        return dateB - dateA;
      });
    } else {
      // Default to pinnedAt
      validPins.sort((a, b) => b.pin.pinnedAt - a.pin.pinnedAt);
    }
  }

  private resolveSourceIconPath(source: SessionSource): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudeIconPath : this.codexIconPath;
  }
}

function buildSessionDescription(cwdShort: string, tags: readonly string[]): string {
  const parts: string[] = [];
  if (cwdShort) parts.push(cwdShort);
  if (tags.length > 0) parts.push(`#${tags.join(" #")}`);
  return parts.join("  ");
}

function normalizeTagFilter(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const tag = String(raw ?? "").trim();
    if (!tag) continue;
    const key = normalizeTagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function normalizeTagKey(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSourceFilter(value: SessionSourceFilter): SessionSourceFilter {
  if (value === "codex" || value === "claude") return value;
  return "all";
}

function inferSourceFromFsPath(fsPath: string): SessionSource | null {
  const cfg = getConfig();
  if (isPathInsideRoot(fsPath, cfg.sessionsRoot)) return "codex";
  if (isPathInsideRoot(fsPath, cfg.claudeSessionsRoot)) return "claude";

  const base = path.basename(fsPath).toLowerCase();
  if (base.startsWith("rollout-")) return "codex";
  if (base.endsWith(".jsonl")) return "claude";
  return null;
}

function isPathInsideRoot(fsPath: string, rootPath: string): boolean {
  const root = String(rootPath ?? "").trim();
  if (!root) return false;
  const rel = path.relative(root, fsPath);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
